import { useCallback, useEffect, useRef, useState } from "react";
import path from "node:path";
import type { Agent } from "../agent/loop.js";
import { gitBranch } from "../git/git.js";
import { listProviders, resolveProvider, saveConfig, type CliConfig } from "../config/config.js";
import { DEFAULT_MODEL, contextWindowFor } from "../config/models.js";
import { ProviderClient, RetryExhaustedError } from "../provider/client.js";
import { createSwitchyardClient } from "../provider/switchyardClient.js";
import { SWITCHYARD_ROUTE_ID, resolveEffectiveModel } from "../provider/switchyardSidecar.js";
import { KillSwitchError } from "../agent/killSwitch.js";
import {
  loadProjectState,
  nextPhase,
  PHASE_COMMAND,
  type ProjectState,
  type WorkflowPhase,
} from "../agent/workflow.js";
import type { SessionMeta } from "../session/store.js";
import { tavilySearch } from "../tools/webSearch.js";
import type {
  ElicitationField,
  ElicitationResult,
  ItemBody,
  Phase,
  PermissionDecision,
  TaskItem,
  UiBridge,
} from "../types.js";
import { killActiveNotice, useKillSwitch } from "./useKillSwitch.js";
import { useUsageBudget } from "./useUsageBudget.js";
import { useSessionResume } from "./useSessionResume.js";

export type Item = ItemBody & { id: number };

export interface PendingPermission {
  toolName: string;
  summary: string;
  diff?: string;
  warning?: string;
  resolve(decision: PermissionDecision): void;
}

export interface PendingElicitation {
  message: string;
  fields: ElicitationField[];
  resolve(result: ElicitationResult): void;
}

export interface UseAgentParams {
  agent: Agent;
  workspace: string;
  modelRef: { current: string };
  providerRef: { current: string };
  config: CliConfig;
  uiBridge: UiBridge;
  resumedCount: number;
  initialTasks?: TaskItem[];
  resumeSessions?: SessionMeta[];
  refreshFileList(): void;
  /** Updates the client subagents (spawn_agent) construct with, so a provider switch applies to them too. */
  onSwitchClient(client: ProviderClient): void;
}

/**
 * Owns everything tied to running agent turns: the transcript, streaming and
 * permission state, usage/cost tracking, and session resume. Input handling
 * (text box, slash-command suggestions, @mention autocomplete) stays in App.
 */
export function useAgent({
  agent,
  workspace,
  modelRef,
  providerRef,
  config,
  uiBridge,
  resumedCount,
  initialTasks,
  resumeSessions,
  refreshFileList,
  onSwitchClient,
}: UseAgentParams) {
  const nextId = useRef(0);
  const [items, setItems] = useState<Item[]>(() => {
    const initial: Item[] = [
      {
        id: nextId.current++,
        kind: "banner",
        subtitle: `${path.basename(workspace)} · ${modelRef.current} · type a request, or /help for commands`,
      },
    ];
    if (resumedCount > 0) {
      const done = initialTasks?.filter((t) => t.status === "done").length ?? 0;
      const taskNote = initialTasks?.length
        ? ` — checklist restored (${done}/${initialTasks.length} done)`
        : "";
      initial.push({
        id: nextId.current++,
        kind: "info",
        text: `Resumed previous session (${resumedCount} messages)${taskNote}.`,
      });
    }
    return initial;
  });
  const [phase, setPhase] = useState<Phase>(resumeSessions?.length ? "resume" : "input");
  const [stream, setStream] = useState("");
  const [thinking, setThinking] = useState(false);
  const [activity, setActivity] = useState<string | null>(null);
  /**
   * Which workflow phase the *current turn* is running. Turn-scoped and cleared
   * when the turn ends, unlike `workflow` below — `activity` can't carry this,
   * since retries and permission prompts overwrite it mid-turn. The ref is what
   * the turn's teardown reads: a command sets this and calls runAgent in the
   * same tick, so the state value inside runAgent's closure is still stale.
   */
  const runningPhaseRef = useRef<WorkflowPhase | null>(null);
  const [runningPhase, setRunningPhaseState] = useState<WorkflowPhase | null>(null);
  const setRunningPhase = useCallback((p: WorkflowPhase | null) => {
    runningPhaseRef.current = p;
    setRunningPhaseState(p);
  }, []);
  /** The active project workflow, for the statusline. Persists between turns. */
  const [workflow, setWorkflow] = useState<ProjectState | null>(() => loadProjectState(workspace));
  const [permission, setPermission] = useState<PendingPermission | null>(null);
  const [elicitation, setElicitation] = useState<PendingElicitation | null>(null);
  const [model, setModel] = useState(modelRef.current);
  const [provider, setProvider] = useState(providerRef.current);
  /** The model that actually served the most recent turn — see Usage.servedModel.
   *  Only meaningful behind a router (switchyard), where it can differ from
   *  `model` (the route name); cleared on provider/model switch. */
  const [servedModel, setServedModel] = useState<string | undefined>(undefined);
  const [tasks, setTasks] = useState<TaskItem[]>(initialTasks ?? []);
  const [branch, setBranch] = useState<string | null>(() => gitBranch(workspace));
  const [planMode, setPlanMode] = useState(false);
  /** The manual Shift+Tab read-only toggle — independent of the project
   *  workflow's own `planMode`. */
  const [dryRunMode, setDryRunMode] = useState(false);
  const [acceptEdits, setAcceptEdits] = useState(false);
  const [autoApprovedCount, setAutoApprovedCount] = useState(0);
  const hasConfirmedAcceptEdits = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  /** Tool calls currently running, keyed by call id — more than one when a
   *  turn's read-only calls are dispatched in parallel. Rendered as live rows. */
  const [inFlight, setInFlight] = useState<
    { id: string; name: string; summary: string; status?: string }[]
  >([]);

  /**
   * The phase to restore once a permission prompt resolves. Tool-call
   * permission requests always arrive mid-turn (phase "working"), but MCP
   * sampling requests can arrive at any time — including while the user is
   * simply sitting at the input prompt — so restoring to the phase captured
   * when the prompt opened (rather than hardcoding "working") keeps the UI
   * from getting stuck in a false "working" state afterward.
   */
  const phaseRef = useRef<Phase>(phase);
  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);
  const previousPhaseRef = useRef<Phase>("input");

  /** Reusable permission prompt, shared by in-turn tool calls and out-of-turn
   *  callers (e.g. MCP sampling) — same UI, same three-way decision. */
  const requestPermission = useCallback(
    (
      toolName: string,
      summary: string,
      diff?: string,
      warning?: string
    ): Promise<PermissionDecision> =>
      new Promise<PermissionDecision>((resolve) => {
        previousPhaseRef.current = phaseRef.current;
        setActivity(null);
        process.stdout.write("\x07"); // ring the terminal bell when input is needed
        setPermission({ toolName, summary, diff, warning, resolve });
        setPhase("permission");
      }),
    []
  );

  /** Same out-of-turn reasoning as `requestPermission` — MCP elicitation
   *  requests can arrive at any time, not just mid-turn. */
  const requestElicitation = useCallback(
    (message: string, fields: ElicitationField[]): Promise<ElicitationResult> =>
      new Promise<ElicitationResult>((resolve) => {
        previousPhaseRef.current = phaseRef.current;
        setActivity(null);
        process.stdout.write("\x07");
        setElicitation({ message, fields, resolve });
        setPhase("elicitation");
      }),
    []
  );

  const addItem = useCallback((item: ItemBody) => {
    setItems((prev) => {
      // A model that calls the same tool with the same arguments several times
      // in a row still gets a line each — hiding the calls would misreport what
      // it did — but repeating the identical preview under every one buries the
      // rest of the turn. Show the output once.
      const last = prev[prev.length - 1];
      const repeat =
        item.kind === "tool" &&
        last?.kind === "tool" &&
        last.summary === item.summary &&
        last.output === item.output &&
        !!item.output;
      const next = repeat ? { ...item, output: "" } : item;
      return [...prev, { ...next, id: nextId.current++ }];
    });
  }, []);

  const {
    usageByModel,
    totalUsage,
    totalCost,
    costReport,
    ctxPct,
    setCtxPct,
    tokenBudget,
    budgetPct,
    budgetUsed,
    budgetStopped,
    resetBudget,
    setBudgetLimit,
    recordUsage,
    totalTokensRef,
  } = useUsageBudget({ agent, config, modelRef, model, addItem, abortRef });

  const { killed, killReason, engageKill, releaseKill } = useKillSwitch({
    agent,
    addItem,
    abortRef,
    permission,
    setPermission,
    setInFlight,
    setActivity,
    setStream,
    setThinking,
    setPhase,
  });

  useEffect(() => {
    uiBridge.onTasksUpdate = setTasks;
    uiBridge.onExternalEdit = (relPath) => {
      addItem({
        kind: "info",
        text: `Detected an external edit to ${relPath} (made outside kritya) — checkpointed for /undo.`,
      });
    };
  }, [uiBridge, addItem]);

  useEffect(() => {
    agent.onAutoApprove = () => setAutoApprovedCount((n) => n + 1);
  }, [agent]);

  const enterAcceptEdits = () => {
    hasConfirmedAcceptEdits.current = true;
    agent.acceptEdits = true;
    setAcceptEdits(true);
    setAutoApprovedCount(0);
    addItem({
      kind: "info",
      text:
        "Accept-edits mode ON — file writes/edits auto-approve without asking. Destructive shell " +
        "commands (rm -rf, force-push, etc.) still always ask. Shift+Tab again for dry-run mode, once " +
        "more for normal.",
    });
  };

  /** Cycles normal → accept-edits → dry-run → normal. First entry into accept-edits this session pauses on a confirmation instead of switching immediately. */
  const cycleMode = () => {
    if (dryRunMode) {
      agent.dryRunMode = false;
      setDryRunMode(false);
      addItem({ kind: "info", text: "Dry-run mode OFF — the agent can make changes again." });
      return;
    }
    if (acceptEdits) {
      agent.acceptEdits = false;
      setAcceptEdits(false);
      agent.dryRunMode = true;
      setDryRunMode(true);
      addItem({
        kind: "info",
        text: "Dry-run mode ON — read-only. The agent will explore and propose a plan; edits and shell are blocked.",
      });
      return;
    }
    if (!hasConfirmedAcceptEdits.current) {
      setPhase("confirmMode");
      return;
    }
    enterAcceptEdits();
  };

  const onAcceptEditsConfirm = (confirmed: boolean) => {
    setPhase("input");
    if (confirmed) enterAcceptEdits();
  };

  const setModelEverywhere = (id: string) => {
    modelRef.current = id;
    setModel(id);
    setServedModel(undefined);
    agent.contextWindow = contextWindowFor(id, config);
    // On switchyard, "model" is a routing directive, not a portable choice: the
    // route id (SWITCHYARD_ROUTE_ID) means "let escalation routing decide",
    // while any other id means "call this model directly, skip routing
    // entirely." Persisting a raw id here would silently disable routing on
    // every future launch (config.model outranks the switchyard default — see
    // engine.ts/headless.ts/index.tsx), so a bypass id is kept session-only.
    if (providerRef.current !== "switchyard" || id === SWITCHYARD_ROUTE_ID) {
      saveConfig({ model: id });
    }
    addItem({ kind: "info", text: `Model set to ${id}` });
  };

  /**
   * Switch the active provider mid-session — e.g. as a fallback when the
   * current one keeps timing out or rate-limiting. Only the underlying HTTP
   * client changes; `agent.history` (and the persisted session file) are
   * untouched, so the conversation carries over.
   */
  const setProviderEverywhere = (name: string) => {
    const resolved = resolveProvider(config, name);
    if (!resolved.apiKey) {
      addItem({
        kind: "info",
        text:
          `No API key found for provider "${name}". Set its env var, a .env file, or ` +
          `providers.${name}.apiKey in ~/.kritya/config.json, then try again.`,
      });
      return;
    }
    const sampling = {
      temperature: resolved.temperature,
      topP: resolved.topP,
      maxTokens: resolved.maxTokens,
    };

    const finishSwitch = () => {
      providerRef.current = name;
      setProvider(name);
      setServedModel(undefined);
      saveConfig({ provider: name });

      const providerDefaultModel = config.providers?.[name]?.model;
      // Filters out SWITCHYARD_ROUTE_ID as a carry-over candidate when `name`
      // isn't switchyard — it's a routing directive, not a real model, so it
      // would 404 against any other provider (see the config.model === config.provider
      // mismatch this was built to fix).
      const targetModel = resolveEffectiveModel(
        name,
        [
          providerDefaultModel,
          name === "switchyard" ? SWITCHYARD_ROUTE_ID : undefined,
          modelRef.current,
        ],
        name === "switchyard" ? SWITCHYARD_ROUTE_ID : DEFAULT_MODEL
      );
      let note = `Switched provider to ${name} — conversation history kept.`;
      if (targetModel !== modelRef.current) {
        setModelEverywhere(targetModel);
        note = `Switched provider to ${name} (model: ${targetModel}) — conversation history kept.`;
      } else {
        note += ` Model "${modelRef.current}" carried over — /model to change it if it isn't offered here.`;
      }
      addItem({ kind: "info", text: note });
    };

    if (name === "switchyard") {
      addItem({ kind: "info", text: "Starting local switchyard-server…" });
      createSwitchyardClient(resolved.apiKey, sampling)
        .then((newClient) => {
          agent.setClient(newClient);
          onSwitchClient(newClient);
          finishSwitch();
        })
        .catch((err) => {
          addItem({
            kind: "info",
            text: `Couldn't start switchyard: ${err instanceof Error ? err.message : String(err)}`,
          });
        });
      return;
    }

    const newClient = new ProviderClient(resolved.apiKey, resolved.baseUrl, sampling);
    agent.setClient(newClient);
    onSwitchClient(newClient);
    finishSwitch();
  };

  /** Re-read the workflow pointer from disk after anything that may have moved it. */
  const refreshWorkflow = useCallback(() => {
    setWorkflow(loadProjectState(workspace));
  }, [workspace]);

  /**
   * Say what to run next, once a phase turn has finished.
   *
   * The phase prompts also ask the model to name the next command, but a model
   * paraphrasing its instructions drops it often enough that the handoff can't
   * depend on that — the user is left at a prompt with no idea what comes next.
   * Printing it here makes it deterministic.
   */
  const announceNextPhase = useCallback(() => {
    const ran = runningPhaseRef.current;
    setRunningPhase(null);
    if (!ran) return;
    // Prefer the phase on disk: an autonomous turn may have advanced it past
    // whatever the command started.
    const current = loadProjectState(workspace)?.phase ?? ran;
    const next = nextPhase(current);
    addItem({
      kind: "info",
      text: next
        ? `✓ ${current} phase done — next: ${PHASE_COMMAND[next]} (or /project to review where you are)`
        : `✓ ${current} phase done — the workflow is complete. /project clear ends it.`,
    });
  }, [workspace, addItem, setRunningPhase]);

  const runWebSearch = async (query: string) => {
    if (agent.kill.active) {
      addItem({ kind: "info", text: killActiveNotice(agent.kill.reason) });
      return;
    }
    setPhase("working");
    setActivity(`Web search: ${query}`);
    try {
      const results = await tavilySearch(query, 5);
      addItem({ kind: "info", text: `Web search: ${query}\n\n${results}` });
      agent.addUserNote(`[Results of a web search I ran for "${query}"]:\n${results}`);
    } catch (err) {
      addItem({
        kind: "info",
        text: `Web search failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    } finally {
      setActivity(null);
      setPhase("input");
    }
  };

  const runAgent = async (text: string, images: string[] = []) => {
    // The kill switch is checked first, ahead of every other stop condition:
    // once it's on, the only thing the user can get back is this line.
    if (agent.kill.active) {
      addItem({ kind: "info", text: killActiveNotice(agent.kill.reason) });
      return;
    }
    if (budgetStopped) {
      addItem({
        kind: "info",
        text:
          `Token budget reached (${totalTokensRef.current.toLocaleString()} / ` +
          `${tokenBudget.toLocaleString()} tokens) — run /budget reset to clear it, or ` +
          `/budget <number> to raise the cap, before continuing.`,
      });
      return;
    }
    setPhase("working");
    const ac = new AbortController();
    abortRef.current = ac;
    setInFlight([]);

    try {
      await agent.runTurn(
        text,
        {
          onTextDelta: (delta) => {
            setThinking(false);
            setStream((prev) => prev + delta);
          },
          onReasoningDelta: () => setThinking(true),
          onAssistantText: (full) => {
            setStream("");
            setThinking(false);
            addItem({ kind: "assistant", text: full });
          },
          onToolStart: (id, name, summary) => {
            setStream("");
            setInFlight((prev) => [...prev, { id, name, summary }]);
          },
          onToolEnd: (id, name, summary, preview, isError, resultSummary) => {
            setInFlight((prev) => prev.filter((t) => t.id !== id));
            if (name !== "update_tasks")
              addItem({
                kind: "tool",
                name,
                summary,
                error: isError,
                output: preview,
                resultSummary,
              });
          },
          onToolProgress: (id, text) => {
            setInFlight((prev) => prev.map((t) => (t.id === id ? { ...t, status: text } : t)));
          },
          requestPermission,
          requestElicitation,
          onRetry: (attempt, status) => {
            // Drop the partial text the failed attempt streamed, or the
            // retried answer would appear twice.
            setStream("");
            setActivity(
              `Provider error${status ? ` (${status})` : ""} — retrying (attempt ${attempt})…`
            );
          },
          onUsage: (usage) => {
            if (usage.servedModel) setServedModel(usage.servedModel);
            recordUsage(usage);
          },
        },
        ac.signal,
        images
      );
    } catch (err) {
      const isAbort =
        (err instanceof Error && err.name === "AbortError") ||
        (err instanceof Error && /abort/i.test(err.message));
      let text: string;
      if (err instanceof KillSwitchError || agent.kill.active) {
        // engageKill already printed the banner; don't follow it with a
        // stack-trace-flavored "Error:" line for the abort it caused.
        text = "Turn stopped by the kill switch.";
      } else if (isAbort) {
        text = "Interrupted.";
      } else {
        const message = err instanceof Error ? err.message : String(err);
        if (err instanceof RetryExhaustedError) {
          const alternatives = listProviders(config)
            .filter((p) => p.hasKey && p.name !== provider)
            .map((p) => p.name);
          const hint = alternatives.length
            ? ` Provider "${provider}" isn't responding — try /provider ${alternatives[0]}` +
              (alternatives.length > 1
                ? ` (also available: ${alternatives.slice(1).join(", ")})`
                : "") +
              ` to switch without losing this conversation.`
            : ` Provider "${provider}" isn't responding, and no other provider has an API key ` +
              `configured to fall back to — see the "Providers" section of the README.`;
          text = `Error: ${message}${hint}`;
        } else {
          text = `Error: ${message}`;
        }
      }
      addItem({ kind: "info", text });
    } finally {
      abortRef.current = null;
      setInFlight([]);
      setStream("");
      setThinking(false);
      setActivity(null);
      setPermission(null);
      setPhase("input");
      refreshFileList();
      setBranch(gitBranch(workspace));
      // A phase can advance itself by writing .kritya/project.json, so re-read
      // it rather than trusting the command that started the turn.
      refreshWorkflow();
      announceNextPhase();
      process.stdout.write("\x07"); // bell: the turn is done
    }
  };

  const onPermissionDecision = (decision: PermissionDecision) => {
    const pending = permission;
    setPermission(null);
    setPhase(previousPhaseRef.current);
    pending?.resolve(decision);
  };

  const onElicitationDecision = (result: ElicitationResult) => {
    const pending = elicitation;
    setElicitation(null);
    setPhase(previousPhaseRef.current);
    pending?.resolve(result);
  };

  const { onResumeSelect } = useSessionResume({
    agent,
    resumeSessions,
    addItem,
    setPhase,
    setTasks,
  });

  return {
    items,
    addItem,
    phase,
    setPhase,
    stream,
    thinking,
    activity,
    setActivity,
    runningPhase,
    setRunningPhase,
    workflow,
    refreshWorkflow,
    permission,
    elicitation,
    inFlight,
    model,
    provider,
    servedModel,
    usageByModel,
    totalUsage,
    totalCost,
    tasks,
    setTasks,
    ctxPct,
    setCtxPct,
    tokenBudget,
    budgetPct,
    budgetUsed,
    budgetStopped,
    resetBudget,
    setBudgetLimit,
    branch,
    planMode,
    setPlanMode,
    dryRunMode,
    killed,
    killReason,
    engageKill,
    releaseKill,
    acceptEdits,
    setAcceptEdits,
    autoApprovedCount,
    cycleMode,
    onAcceptEditsConfirm,
    abortRef,
    setModelEverywhere,
    setProviderEverywhere,
    costReport,
    runAgent,
    runWebSearch,
    onPermissionDecision,
    onElicitationDecision,
    onResumeSelect,
    requestPermission,
    requestElicitation,
  };
}
