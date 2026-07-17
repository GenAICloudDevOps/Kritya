import React, { useCallback, useEffect, useRef, useState } from "react";
import { Box, Static, Text, useApp, useInput } from "ink";
import TextInput from "ink-text-input";
import fs from "node:fs";
import path from "node:path";
import fg from "fast-glob";
import type { Agent } from "../agent/loop.js";
import { saveConfig, type CliConfig } from "../config/config.js";
import { SessionStore, type SessionMeta } from "../session/store.js";
import { resolveSafe } from "../tools/common.js";
import { tavilySearch } from "../tools/webSearch.js";
import type { UndoStack } from "../undo/undo.js";
import type { PermissionDecision, TaskItem, Usage } from "../types.js";
import { Banner } from "./Banner.js";
import { Markdown } from "./Markdown.js";
import { ModelPicker } from "./ModelPicker.js";
import { PermissionPrompt } from "./PermissionPrompt.js";
import { SelectList } from "./SelectList.js";
import { Spinner } from "./Spinner.js";

type ItemBody =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | { kind: "tool"; name: string; summary: string; error: boolean }
  | { kind: "info"; text: string }
  | { kind: "banner"; subtitle: string };

type Item = ItemBody & { id: number };

type Phase = "input" | "working" | "permission" | "model" | "resume";

interface PendingPermission {
  toolName: string;
  summary: string;
  diff?: string;
  resolve(decision: PermissionDecision): void;
}

export interface UiBridge {
  onTasksUpdate(tasks: TaskItem[]): void;
}

export interface AppProps {
  agent: Agent;
  workspace: string;
  modelRef: { current: string };
  config: CliConfig;
  resumedCount: number;
  undoStack: UndoStack;
  uiBridge: UiBridge;
  resumeSessions?: SessionMeta[];
}

const COMMANDS: { name: string; description: string }[] = [
  { name: "/help", description: "show available commands" },
  { name: "/model", description: "pick a model, or /model <id> for any NVIDIA model ID" },
  { name: "/web-search", description: "search the web: /web-search <query>" },
  { name: "/undo", description: "revert the last file change the agent made" },
  { name: "/compact", description: "summarize older conversation to free context space" },
  { name: "/clear", description: "start a fresh conversation" },
  { name: "/cost", description: "show token usage and estimated cost" },
  { name: "/exit", description: "leave" },
  { name: "/quit", description: "leave" },
];

const HELP_TEXT = `Commands:
${COMMANDS.map((c) => `  ${c.name.padEnd(14)} ${c.description}`).join("\n")}

Also: @path/to/file attaches a file to your message (with autocomplete).
Project memory: put standing instructions in KRITYA.md at your workspace root.
Keys: Esc cancels a running request · Tab completes · Ctrl+C exits`;

const MENTION_RE = /(^|\s)@([^\s@]*)$/;
const MENTION_ALL_RE = /(?:^|\s)@([^\s@]+)/g;
const MAX_MENTION_CHARS = 8000;

export function App({
  agent,
  workspace,
  modelRef,
  config,
  resumedCount,
  undoStack,
  uiBridge,
  resumeSessions,
}: AppProps) {
  const { exit } = useApp();
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
  const [input, setInput] = useState("");
  const [stream, setStream] = useState("");
  const [thinking, setThinking] = useState(false);
  const [activity, setActivity] = useState<string | null>(null);
  const [permission, setPermission] = useState<PendingPermission | null>(null);
  const [model, setModel] = useState(modelRef.current);
  const [usageByModel, setUsageByModel] = useState<Record<string, Usage>>({});
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [ctxPct, setCtxPct] = useState(0);
  const [steerInput, setSteerInput] = useState("");
  const [cmdIndex, setCmdIndex] = useState(0);
  const [fileIndex, setFileIndex] = useState(0);
  const [fileList, setFileList] = useState<string[]>([]);
  const abortRef = useRef<AbortController | null>(null);

  const addItem = useCallback((item: ItemBody) => {
    setItems((prev) => [...prev, { ...item, id: nextId.current++ }]);
  }, []);

  useEffect(() => {
    uiBridge.onTasksUpdate = setTasks;
  }, [uiBridge]);

  const refreshFileList = useCallback(() => {
    fg("**/*", {
      cwd: workspace,
      dot: false,
      onlyFiles: true,
      ignore: ["**/node_modules/**", "**/.git/**", "**/dist/**"],
      suppressErrors: true,
    })
      .then((files) => setFileList(files.sort().slice(0, 2000)))
      .catch(() => {});
  }, [workspace]);

  useEffect(refreshFileList, [refreshFileList]);

  // Command suggestions while typing a slash command (before any arguments).
  const suggestions =
    phase === "input" && input.startsWith("/") && !input.includes(" ")
      ? COMMANDS.filter((c) => c.name.startsWith(input.trim()))
      : [];
  const selectedCmd = suggestions.length ? Math.min(cmdIndex, suggestions.length - 1) : 0;

  // File suggestions while typing an @mention.
  const mentionMatch = phase === "input" && !input.startsWith("/") ? MENTION_RE.exec(input) : null;
  const mentionFragment = mentionMatch ? mentionMatch[2].toLowerCase() : null;
  const fileSuggestions =
    mentionFragment !== null
      ? fileList.filter((f) => f.toLowerCase().includes(mentionFragment)).slice(0, 8)
      : [];
  const selectedFile = fileSuggestions.length ? Math.min(fileIndex, fileSuggestions.length - 1) : 0;

  const completeMention = (file: string) => {
    if (!mentionMatch) return;
    const head = input.slice(0, mentionMatch.index + mentionMatch[1].length);
    setInput(`${head}@${file} `);
    setFileIndex(0);
  };

  useInput((_input, key) => {
    if (key.escape && phase === "working") {
      abortRef.current?.abort();
    }
    if (suggestions.length) {
      if (key.upArrow) setCmdIndex((i) => (i - 1 + suggestions.length) % suggestions.length);
      else if (key.downArrow) setCmdIndex((i) => (i + 1) % suggestions.length);
      else if (key.tab) setInput(suggestions[selectedCmd].name + " ");
    } else if (fileSuggestions.length) {
      if (key.upArrow) setFileIndex((i) => (i - 1 + fileSuggestions.length) % fileSuggestions.length);
      else if (key.downArrow) setFileIndex((i) => (i + 1) % fileSuggestions.length);
      else if (key.tab) completeMention(fileSuggestions[selectedFile]);
    }
  });

  const setModelEverywhere = (id: string) => {
    modelRef.current = id;
    setModel(id);
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
    const hint =
      totalCost > 0
        ? ""
        : `\nTip: add per-model prices (USD per 1M tokens) to ~/.kritya/config.json to see $ estimates:\n  "pricing": { "${model}": { "input": 0.6, "output": 2.4 } }`;
    return `Usage this session:\n${lines.join("\n")}${total}${hint}`;
  };

  const runWebSearch = async (query: string) => {
    setPhase("working");
    setActivity(`Web search: ${query}`);
    try {
      const results = await tavilySearch(query, 5);
      addItem({ kind: "info", text: `Web search: ${query}\n\n${results}` });
      agent.addUserNote(`[Results of a web search I ran for "${query}"]:\n${results}`);
    } catch (err) {
      addItem({ kind: "info", text: `Web search failed: ${err instanceof Error ? err.message : String(err)}` });
    } finally {
      setActivity(null);
      setPhase("input");
    }
  };

  const handleSlash = (raw: string) => {
    const [cmd, ...rest] = raw.trim().split(/\s+/);
    const arg = rest.join(" ");
    switch (cmd) {
      case "/help":
        addItem({ kind: "info", text: HELP_TEXT });
        break;
      case "/model":
        if (arg) setModelEverywhere(arg);
        else setPhase("model");
        break;
      case "/web-search":
        if (!arg) addItem({ kind: "info", text: "Usage: /web-search <query>" });
        else void runWebSearch(arg);
        break;
      case "/undo": {
        const result = undoStack.undo();
        if (result === null) {
          addItem({ kind: "info", text: "Nothing to undo." });
        } else {
          addItem({ kind: "info", text: `Undo: ${result}` });
          agent.addUserNote(`[I reverted your last file change via /undo: ${result}]`);
          refreshFileList();
        }
        break;
      }
      case "/clear":
        agent.reset();
        setTasks([]);
        addItem({ kind: "info", text: "Conversation cleared." });
        break;
      case "/cost":
        addItem({ kind: "info", text: costReport() });
        break;
      case "/compact":
        setPhase("working");
        setActivity("Compacting context…");
        void agent
          .compact()
          .then((note) => {
            addItem({ kind: "info", text: note });
            setCtxPct(Math.round(agent.contextUsage() * 100));
          })
          .catch((err) =>
            addItem({
              kind: "info",
              text: `Compaction failed: ${err instanceof Error ? err.message : String(err)}`,
            })
          )
          .finally(() => {
            setActivity(null);
            setPhase("input");
          });
        break;
      case "/exit":
      case "/quit":
        exit();
        break;
      default:
        addItem({ kind: "info", text: `Unknown command: ${cmd}. Try /help` });
    }
  };

  const expandMentions = (text: string): string => {
    const mentions = [...new Set([...text.matchAll(MENTION_ALL_RE)].map((m) => m[1]))];
    let extra = "";
    for (const p of mentions) {
      try {
        const abs = resolveSafe(workspace, p);
        const content = fs.readFileSync(abs, "utf8");
        const capped =
          content.length > MAX_MENTION_CHARS
            ? content.slice(0, MAX_MENTION_CHARS) + "\n… (truncated)"
            : content;
        extra += `\n\n[Attached file: ${p}]\n\`\`\`\n${capped}\n\`\`\``;
      } catch {
        // Not a real file — leave the @word as-is.
      }
    }
    return text + extra;
  };

  const handleSubmit = async (value: string) => {
    // Enter while command suggestions are open selects the highlighted command instead of sending.
    if (suggestions.length && value.trim() !== suggestions[selectedCmd].name) {
      setInput(suggestions[selectedCmd].name + " ");
      setCmdIndex(0);
      return;
    }
    // Enter while file suggestions are open completes the mention instead of sending.
    if (fileSuggestions.length && mentionFragment !== fileSuggestions[selectedFile].toLowerCase()) {
      completeMention(fileSuggestions[selectedFile]);
      return;
    }

    let text = value.trim();
    setInput("");
    setCmdIndex(0);
    setFileIndex(0);
    if (!text) return;
    if (text.startsWith("/")) {
      handleSlash(text);
      return;
    }

    addItem({ kind: "user", text });
    setPhase("working");
    const ac = new AbortController();
    abortRef.current = ac;

    try {
      await agent.runTurn(
        expandMentions(text),
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
          onToolStart: (name, summary) => {
            setStream("");
            setActivity(summary);
          },
          onToolEnd: (name, summary, _preview, isError) => {
            setActivity(null);
            if (name !== "update_tasks") addItem({ kind: "tool", name, summary, error: isError });
          },
          requestPermission: (toolName, summary, diff) =>
            new Promise<PermissionDecision>((resolve) => {
              setActivity(null);
              setPermission({ toolName, summary, diff, resolve });
              setPhase("permission");
            }),
          onUsage: (u) => {
            setCtxPct(Math.round(agent.contextUsage() * 100));
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
        ac.signal
      );
    } catch (err) {
      const isAbort =
        (err instanceof Error && err.name === "AbortError") ||
        (err instanceof Error && /abort/i.test(err.message));
      addItem({
        kind: "info",
        text: isAbort ? "Interrupted." : `Error: ${err instanceof Error ? err.message : String(err)}`,
      });
    } finally {
      abortRef.current = null;
      setStream("");
      setThinking(false);
      setActivity(null);
      setPermission(null);
      setPhase("input");
      refreshFileList();
    }
  };

  const onPermissionDecision = (decision: PermissionDecision) => {
    const pending = permission;
    setPermission(null);
    setPhase("working");
    pending?.resolve(decision);
  };

  const onResumeSelect = (file: string) => {
    setPhase("input");
    if (!file) {
      addItem({ kind: "info", text: "Starting a fresh session." });
      return;
    }
    const meta = resumeSessions?.find((s) => s.file === file);
    const messages = agentLoadSession(file);
    addItem({ kind: "info", text: `Resumed session from ${meta?.date ?? "?"} (${messages} messages).` });
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

  return (
    <Box flexDirection="column">
      <Static items={items}>
        {(item) => (
          <Box key={item.id} marginBottom={item.kind === "tool" ? 0 : 1} flexDirection="column">
            {item.kind === "user" && (
              <Text>
                <Text bold color="green">
                  ❯{" "}
                </Text>
                {item.text}
              </Text>
            )}
            {item.kind === "assistant" && <Markdown text={item.text} />}
            {item.kind === "tool" && (
              <Text dimColor>
                {item.error ? <Text color="red">✗</Text> : <Text color="green">✓</Text>} {item.summary}
              </Text>
            )}
            {item.kind === "info" && <Text dimColor>{item.text}</Text>}
            {item.kind === "banner" && <Banner subtitle={item.subtitle} />}
          </Box>
        )}
      </Static>

      {stream ? (
        <Box marginBottom={1}>
          <Markdown text={stream} />
        </Box>
      ) : null}

      {tasks.length > 0 && (
        <Box flexDirection="column" borderStyle="round" borderColor="blue" paddingX={1}>
          {tasks.map((t, i) => (
            <Text
              key={i}
              color={t.status === "done" ? "green" : t.status === "in_progress" ? "yellow" : undefined}
              dimColor={t.status === "pending"}
            >
              {t.status === "done" ? "☑" : t.status === "in_progress" ? "◐" : "☐"} {t.text}
            </Text>
          ))}
        </Box>
      )}

      {phase === "working" && (
        <Box flexDirection="column">
          <Spinner
            label={
              activity ? activity : thinking ? "thinking… (Esc to cancel)" : "working… (Esc to cancel)"
            }
          />
          <Box borderStyle="round" borderColor="yellow" paddingX={1}>
            <Text color="yellow">↳ </Text>
            <TextInput
              value={steerInput}
              onChange={setSteerInput}
              onSubmit={(value) => {
                const text = value.trim();
                setSteerInput("");
                if (!text) return;
                if (text.startsWith("/")) {
                  addItem({
                    kind: "info",
                    text: "Commands are unavailable while the agent is working — press Esc to interrupt first.",
                  });
                  return;
                }
                addItem({ kind: "user", text: `${text} (queued)` });
                agent.queueSteer(expandMentions(text));
              }}
              placeholder="steer the agent… (Enter to queue)"
            />
          </Box>
        </Box>
      )}

      {phase === "permission" && permission && (
        <PermissionPrompt
          toolName={permission.toolName}
          summary={permission.summary}
          diff={permission.diff}
          onDecision={onPermissionDecision}
        />
      )}

      {phase === "model" && (
        <ModelPicker
          current={model}
          customModels={config.customModels ?? []}
          onSelect={(id) => {
            setPhase("input");
            setModelEverywhere(id);
          }}
          onCancel={() => setPhase("input")}
        />
      )}

      {phase === "resume" && (
        <Box flexDirection="column" borderStyle="round" borderColor="magenta" paddingX={1}>
          <Text bold color="magenta">
            Resume a session <Text dimColor>(Esc for a fresh one)</Text>
          </Text>
          <SelectList
            items={(resumeSessions ?? []).map((s) => ({
              label: `${s.date} · ${s.count} msgs`,
              value: s.file,
              hint: s.preview,
            }))}
            onSelect={onResumeSelect}
            onCancel={() => onResumeSelect("")}
          />
        </Box>
      )}

      {phase === "input" && (
        <Box flexDirection="column">
          <Box borderStyle="round" borderColor="gray" paddingX={1}>
            <Text color="green">❯ </Text>
            <TextInput
              value={input}
              onChange={(v) => {
                setInput(v.replace(/\t/g, ""));
                setCmdIndex(0);
                setFileIndex(0);
              }}
              onSubmit={handleSubmit}
            />
          </Box>
          {suggestions.length > 0 && (
            <Box flexDirection="column" paddingLeft={2}>
              {suggestions.map((c, i) => (
                <Text key={c.name} color={i === selectedCmd ? "green" : undefined}>
                  {i === selectedCmd ? "❯ " : "  "}
                  <Text bold={i === selectedCmd}>{c.name}</Text>
                  <Text dimColor> — {c.description}</Text>
                </Text>
              ))}
              <Text dimColor>↑↓ select · Tab/Enter select · Enter again to run</Text>
            </Box>
          )}
          {fileSuggestions.length > 0 && (
            <Box flexDirection="column" paddingLeft={2}>
              {fileSuggestions.map((f, i) => (
                <Text key={f} color={i === selectedFile ? "green" : undefined}>
                  {i === selectedFile ? "❯ " : "  "}
                  {f}
                </Text>
              ))}
              <Text dimColor>↑↓ select · Tab/Enter attach file</Text>
            </Box>
          )}
        </Box>
      )}

      <Box>
        <Text dimColor>
          {model}
          {ctxPct > 0 ? ` · ctx ${ctxPct}%` : ""} · {totalUsage.promptTokens.toLocaleString()} in /{" "}
          {totalUsage.completionTokens.toLocaleString()} out
          {totalCost > 0 ? ` · $${totalCost.toFixed(4)}` : ""} · {path.basename(workspace)}
        </Text>
      </Box>
    </Box>
  );
}
