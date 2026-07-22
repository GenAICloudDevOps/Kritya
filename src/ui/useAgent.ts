import { useCallback, useEffect, useRef, useState } from "react";
import path from "node:path";
import type { Agent } from "../agent/loop.js";
import { gitBranch } from "../git/git.js";
import { listProviders, resolveProvider, saveConfig, type CliConfig } from "../config/config.js";
import { contextWindowFor } from "../config/models.js";
import { ProviderClient, RetryExhaustedError } from "../provider/client.js";
import { crossedContextWarnThreshold } from "../agent/contextWarning.js";
import {
  cacheSavingsFor,
  costFor,
  crossedBudgetWarnThreshold,
  tokenBudgetFor,
} from "../agent/budget.js";
import { SessionStore, type SessionMeta } from "../session/store.js";
import { tavilySearch } from "../tools/webSearch.js";
import type { ItemBody, Phase, PermissionDecision, TaskItem, UiBridge, Usage } from "../types.js";

export type Item = ItemBody & { id: number };

export interface PendingPermission {
  toolName: string;
  summary: string;
  diff?: string;
  warning?: string;
  resolve(decision: PermissionDecision): void;
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
  const [permission, setPermission] = useState<PendingPermission | null>(null);
  const [model, setModel] = useState(modelRef.current);
  const [provider, setProvider] = useState(providerRef.current);
  const [usageByModel, setUsageByModel] = useState<Record<string, Usage>>({});
  const [tasks, setTasks] = useState<TaskItem[]>(initialTasks ?? []);
  const [ctxPct, setCtxPct] = useState(0);
  const ctxPctRef = useRef(0);
  const [tokenBudget, setTokenBudget] = useState(() => tokenBudgetFor(config));
  const [budgetPct, setBudgetPct] = useState(0);
  const budgetPctRef = useRef(0);
  const [budgetUsed, setBudgetUsed] = useState(0);
  const totalTokensRef = useRef(0);
  const [budgetStopped, setBudgetStopped] = useState(false);
  const [branch, setBranch] = useState<string | null>(() => gitBranch(workspace));
  const [planMode, setPlanMode] = useState(false);
  const [acceptEdits, setAcceptEdits] = useState(false);
  const [autoApprovedCount, setAutoApprovedCount] = useState(0);
  const hasConfirmedAcceptEdits = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  /** Tool calls currently running, keyed by call id — more than one when a
   *  turn's read-only calls are dispatched in parallel. Rendered as live rows. */
  const [inFlight, setInFlight] = useState<{ id: string; name: string; summary: string }[]>([]);

  const addItem = useCallback((item: ItemBody) => {
    setItems((prev) => [...prev, { ...item, id: nextId.current++ }]);
  }, []);

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
        "commands (rm -rf, force-push, etc.) still always ask. Shift+Tab again for plan mode, once " +
        "more for normal.",
    });
  };

  /** Cycles normal → accept-edits → plan → normal. First entry into accept-edits this session pauses on a confirmation instead of switching immediately. */
  const cycleMode = () => {
    if (planMode) {
      agent.planMode = false;
      setPlanMode(false);
      addItem({ kind: "info", text: "Plan mode OFF — the agent can make changes again." });
      return;
    }
    if (acceptEdits) {
      agent.acceptEdits = false;
      setAcceptEdits(false);
      agent.planMode = true;
      setPlanMode(true);
      addItem({
        kind: "info",
        text: "Plan mode ON — read-only. The agent will explore and propose a plan; edits and shell are blocked.",
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
    agent.contextWindow = contextWindowFor(id, config);
    saveConfig({ model: id });
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
    const newClient = new ProviderClient(resolved.apiKey, resolved.baseUrl, {
      temperature: resolved.temperature,
      topP: resolved.topP,
      maxTokens: resolved.maxTokens,
    });
    agent.setClient(newClient);
    onSwitchClient(newClient);
    providerRef.current = name;
    setProvider(name);
    saveConfig({ provider: name });

    const providerDefaultModel = config.providers?.[name]?.model;
    let note = `Switched provider to ${name} — conversation history kept.`;
    if (providerDefaultModel && providerDefaultModel !== modelRef.current) {
      setModelEverywhere(providerDefaultModel);
      note = `Switched provider to ${name} (model: ${providerDefaultModel}) — conversation history kept.`;
    } else {
      note += ` Model "${modelRef.current}" carried over — /model to change it if it isn't offered here.`;
    }
    addItem({ kind: "info", text: note });
  };

  const totalUsage = Object.values(usageByModel).reduce(
    (acc, u) => ({
      promptTokens: acc.promptTokens + u.promptTokens,
      completionTokens: acc.completionTokens + u.completionTokens,
      cachedPromptTokens: (acc.cachedPromptTokens ?? 0) + (u.cachedPromptTokens ?? 0),
      estimated: acc.estimated || Boolean(u.estimated),
    }),
    { promptTokens: 0, completionTokens: 0, cachedPromptTokens: 0, estimated: false }
  );

  const totalCost = Object.entries(usageByModel).reduce((sum, [id, u]) => {
    const p = config.pricing?.[id];
    return p ? sum + costFor(u, p) : sum;
  }, 0);

  const costReport = () => {
    const lines = Object.entries(usageByModel).map(([id, u]) => {
      const p = config.pricing?.[id];
      const dollars = p ? ` ≈ $${costFor(u, p).toFixed(4)}` : "";
      const cached = u.cachedPromptTokens ?? 0;
      const hitRate =
        cached > 0 && u.promptTokens > 0
          ? ` (${cached.toLocaleString()} cached, ${Math.round((cached / u.promptTokens) * 100)}% hit rate)`
          : "";
      // Some providers omit real token counts; those turns fall back to a
      // text-length estimate (see agent/loop.ts). Flag it here rather than
      // let an approximate number pass as an exact one.
      const estNote = u.estimated ? " (some figures estimated — provider didn't report usage)" : "";
      return `  ${id}: ${u.promptTokens.toLocaleString()} in${hitRate} / ${u.completionTokens.toLocaleString()} out${dollars}${estNote}`;
    });
    if (!lines.length) return "No usage yet this session.";
    const totalSavings = Object.entries(usageByModel).reduce((sum, [id, u]) => {
      const p = config.pricing?.[id];
      return p ? sum + cacheSavingsFor(u, p) : sum;
    }, 0);
    const savingsNote =
      totalSavings > 0 ? ` (saved $${totalSavings.toFixed(4)} via prompt caching)` : "";
    const total = totalCost > 0 ? `\nEstimated total: $${totalCost.toFixed(4)}${savingsNote}` : "";
    const ctxNote = `\nContext window: ${ctxPctRef.current}% used`;
    const budgetNote =
      `\nToken budget: ${budgetUsed.toLocaleString()} / ${tokenBudget.toLocaleString()} ` +
      `(${budgetPct}%)${budgetStopped ? " — STOPPED, run /budget reset or /budget <number>" : ""}`;
    const hint =
      totalCost > 0
        ? ""
        : `\nTip: add per-model prices (USD per 1M tokens) to ~/.kritya/config.json to see $ estimates:\n  "pricing": { "${model}": { "input": 0.6, "output": 2.4, "cachedInput": 0.15 } }\n("cachedInput" is optional — the discounted rate for cache-hit prompt tokens, for cache-savings reporting.)`;
    return `Usage this session:\n${lines.join("\n")}${total}${ctxNote}${budgetNote}${hint}`;
  };

  const resetBudget = () => {
    totalTokensRef.current = 0;
    budgetPctRef.current = 0;
    setBudgetUsed(0);
    setBudgetPct(0);
    setBudgetStopped(false);
    addItem({ kind: "info", text: "Token budget usage reset for this session." });
  };

  const setBudgetLimit = (n: number) => {
    setTokenBudget(n);
    const pct = Math.min(999, Math.round((totalTokensRef.current / n) * 100));
    budgetPctRef.current = pct;
    setBudgetPct(pct);
    if (pct < 100) setBudgetStopped(false);
    addItem({ kind: "info", text: `Token budget set to ${n.toLocaleString()} for this session.` });
  };

  const runWebSearch = async (query: string) => {
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
          onToolEnd: (id, name, summary, preview, isError) => {
            setInFlight((prev) => prev.filter((t) => t.id !== id));
            if (name !== "update_tasks")
              addItem({ kind: "tool", name, summary, error: isError, output: preview });
          },
          requestPermission: (toolName, summary, diff, warning) =>
            new Promise<PermissionDecision>((resolve) => {
              setActivity(null);
              process.stdout.write("\x07"); // ring the terminal bell when input is needed
              setPermission({ toolName, summary, diff, warning, resolve });
              setPhase("permission");
            }),
          onRetry: (attempt, status) => {
            // Drop the partial text the failed attempt streamed, or the
            // retried answer would appear twice.
            setStream("");
            setActivity(
              `Provider error${status ? ` (${status})` : ""} — retrying (attempt ${attempt})…`
            );
          },
          onUsage: (u) => {
            const pct = Math.round(agent.contextUsage() * 100);
            if (crossedContextWarnThreshold(ctxPctRef.current, pct)) {
              addItem({
                kind: "info",
                text: `⚠ Context usage at ${pct}% — kritya will auto-compact older history soon to stay within the model's context window.`,
              });
            }
            ctxPctRef.current = pct;
            setCtxPct(pct);
            const id = modelRef.current;
            setUsageByModel((prev) => ({
              ...prev,
              [id]: {
                promptTokens: (prev[id]?.promptTokens ?? 0) + u.promptTokens,
                completionTokens: (prev[id]?.completionTokens ?? 0) + u.completionTokens,
                cachedPromptTokens:
                  (prev[id]?.cachedPromptTokens ?? 0) + (u.cachedPromptTokens ?? 0),
                // Once any turn's usage for this model was estimated rather
                // than provider-reported, the running total is no longer
                // exact — keep it flagged for the rest of the session.
                estimated: Boolean(prev[id]?.estimated) || Boolean(u.estimated),
              },
            }));

            totalTokensRef.current += u.promptTokens + u.completionTokens;
            setBudgetUsed(totalTokensRef.current);
            const bPct = Math.min(999, Math.round((totalTokensRef.current / tokenBudget) * 100));
            if (crossedBudgetWarnThreshold(budgetPctRef.current, bPct)) {
              addItem({
                kind: "info",
                text:
                  `⚠ Token budget at ${bPct}% (${totalTokensRef.current.toLocaleString()} / ` +
                  `${tokenBudget.toLocaleString()} tokens this session). kritya will stop once it ` +
                  `hits 100% — run /budget to check or raise it.`,
              });
              agent.audit?.logTool({
                tool: "budget",
                summary: `token budget at ${bPct}% (${totalTokensRef.current}/${tokenBudget})`,
                outcome: "ok",
              });
              agent.turnSpan?.addEvent("budget.warn", { "kritya.budget_pct": bPct });
            }
            if (bPct >= 100 && budgetPctRef.current < 100) {
              addItem({
                kind: "info",
                text:
                  `⛔ Token budget reached (${totalTokensRef.current.toLocaleString()} / ` +
                  `${tokenBudget.toLocaleString()} tokens). Stopping further turns — run ` +
                  `/budget reset to clear it, or /budget <number> to raise the cap.`,
              });
              agent.audit?.logTool({
                tool: "budget",
                summary: `token budget reached, stopping (${totalTokensRef.current}/${tokenBudget})`,
                outcome: "blocked",
              });
              agent.turnSpan?.addEvent("budget.stopped", { "kritya.budget_pct": bPct });
              setBudgetStopped(true);
              abortRef.current?.abort();
            }
            budgetPctRef.current = bPct;
            setBudgetPct(bPct);
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
      if (isAbort) {
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
      process.stdout.write("\x07"); // bell: the turn is done
    }
  };

  const onPermissionDecision = (decision: PermissionDecision) => {
    const pending = permission;
    setPermission(null);
    setPhase("working");
    pending?.resolve(decision);
  };

  const agentLoadSession = (file: string): number => {
    const messages = SessionStore.loadFile(file);
    agent.loadHistory(messages);
    const replay = messages.filter(
      (m) =>
        (m.role === "user" || m.role === "assistant") &&
        typeof m.content === "string" &&
        m.content.trim() &&
        !(m.role === "user" && m.content.startsWith("["))
    );
    for (const m of replay.slice(-6)) {
      addItem({
        kind: m.role === "user" ? "user" : "assistant",
        text: String(m.content),
      });
    }
    return messages.length;
  };

  const onResumeSelect = (file: string) => {
    setPhase("input");
    if (!file) {
      addItem({ kind: "info", text: "Starting a fresh session." });
      return;
    }
    const meta = resumeSessions?.find((s) => s.file === file);
    const messages = agentLoadSession(file);
    const restoredTasks = SessionStore.loadTasksForSession(file);
    setTasks(restoredTasks);
    const done = restoredTasks.filter((t) => t.status === "done").length;
    const taskNote = restoredTasks.length
      ? ` — checklist restored (${done}/${restoredTasks.length} done)`
      : "";
    addItem({
      kind: "info",
      text: `Resumed session from ${meta?.date ?? "?"} (${messages} messages)${taskNote}.`,
    });
  };

  return {
    items,
    addItem,
    phase,
    setPhase,
    stream,
    thinking,
    activity,
    setActivity,
    permission,
    inFlight,
    model,
    provider,
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
    onResumeSelect,
  };
}
