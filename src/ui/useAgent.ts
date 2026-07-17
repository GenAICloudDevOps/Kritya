import { useCallback, useEffect, useRef, useState } from "react";
import path from "node:path";
import type { Agent } from "../agent/loop.js";
import { gitBranch } from "../git/git.js";
import { saveConfig, type CliConfig } from "../config/config.js";
import { contextWindowFor } from "../config/models.js";
import { crossedContextWarnThreshold } from "../agent/contextWarning.js";
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
  config: CliConfig;
  uiBridge: UiBridge;
  resumedCount: number;
  resumeSessions?: SessionMeta[];
  refreshFileList(): void;
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
  config,
  uiBridge,
  resumedCount,
  resumeSessions,
  refreshFileList,
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
      initial.push({
        id: nextId.current++,
        kind: "info",
        text: `Resumed previous session (${resumedCount} messages).`,
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
  const [usageByModel, setUsageByModel] = useState<Record<string, Usage>>({});
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [ctxPct, setCtxPct] = useState(0);
  const ctxPctRef = useRef(0);
  const [branch, setBranch] = useState<string | null>(() => gitBranch(workspace));
  const [planMode, setPlanMode] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const addItem = useCallback((item: ItemBody) => {
    setItems((prev) => [...prev, { ...item, id: nextId.current++ }]);
  }, []);

  useEffect(() => {
    uiBridge.onTasksUpdate = setTasks;
  }, [uiBridge]);

  const setModelEverywhere = (id: string) => {
    modelRef.current = id;
    setModel(id);
    agent.contextWindow = contextWindowFor(id, config);
    saveConfig({ model: id });
    addItem({ kind: "info", text: `Model set to ${id}` });
  };

  const totalUsage = Object.values(usageByModel).reduce(
    (acc, u) => ({
      promptTokens: acc.promptTokens + u.promptTokens,
      completionTokens: acc.completionTokens + u.completionTokens,
    }),
    { promptTokens: 0, completionTokens: 0 }
  );

  const totalCost = Object.entries(usageByModel).reduce((sum, [id, u]) => {
    const p = config.pricing?.[id];
    if (!p) return sum;
    return sum + (u.promptTokens / 1e6) * p.input + (u.completionTokens / 1e6) * p.output;
  }, 0);

  const costReport = () => {
    const lines = Object.entries(usageByModel).map(([id, u]) => {
      const p = config.pricing?.[id];
      const dollars = p
        ? ` ≈ $${((u.promptTokens / 1e6) * p.input + (u.completionTokens / 1e6) * p.output).toFixed(4)}`
        : "";
      return `  ${id}: ${u.promptTokens.toLocaleString()} in / ${u.completionTokens.toLocaleString()} out${dollars}`;
    });
    if (!lines.length) return "No usage yet this session.";
    const total = totalCost > 0 ? `\nEstimated total: $${totalCost.toFixed(4)}` : "";
    const ctxNote = `\nContext window: ${ctxPctRef.current}% used`;
    const hint =
      totalCost > 0
        ? ""
        : `\nTip: add per-model prices (USD per 1M tokens) to ~/.kritya/config.json to see $ estimates:\n  "pricing": { "${model}": { "input": 0.6, "output": 2.4 } }`;
    return `Usage this session:\n${lines.join("\n")}${total}${ctxNote}${hint}`;
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
    setPhase("working");
    const ac = new AbortController();
    abortRef.current = ac;

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
          onToolStart: (_name, summary) => {
            setStream("");
            setActivity(summary);
          },
          onToolEnd: (name, summary, preview, isError) => {
            setActivity(null);
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
              },
            }));
          },
        },
        ac.signal,
        images
      );
    } catch (err) {
      const isAbort =
        (err instanceof Error && err.name === "AbortError") ||
        (err instanceof Error && /abort/i.test(err.message));
      addItem({
        kind: "info",
        text: isAbort
          ? "Interrupted."
          : `Error: ${err instanceof Error ? err.message : String(err)}`,
      });
    } finally {
      abortRef.current = null;
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
    addItem({
      kind: "info",
      text: `Resumed session from ${meta?.date ?? "?"} (${messages} messages).`,
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
    model,
    usageByModel,
    totalUsage,
    totalCost,
    tasks,
    setTasks,
    ctxPct,
    setCtxPct,
    branch,
    planMode,
    setPlanMode,
    abortRef,
    setModelEverywhere,
    costReport,
    runAgent,
    runWebSearch,
    onPermissionDecision,
    onResumeSelect,
  };
}
