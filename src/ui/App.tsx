import { useCallback, useEffect, useRef, useState } from "react";
import { Box, Static, Text, useApp, useInput, useStdout } from "ink";
import TextInput from "ink-text-input";
import fs from "node:fs";
import path from "node:path";
import fg from "fast-glob";
import type { Agent } from "../agent/loop.js";
import { gitDiffStat } from "../git/git.js";
import type { CliConfig } from "../config/config.js";
import { SessionStore, type SessionMeta } from "../session/store.js";
import { resolveSafe } from "../tools/common.js";
import { loadIgnorePatterns } from "../tools/ignore.js";
import type { UndoStack } from "../undo/undo.js";
import type { TaskItem, UiBridge } from "../types.js";
import { Banner } from "./Banner.js";
import { Markdown } from "./Markdown.js";
import { ModelPicker } from "./ModelPicker.js";
import { PermissionPrompt } from "./PermissionPrompt.js";
import { SelectList } from "./SelectList.js";
import { Spinner } from "./Spinner.js";
import type { CustomCommand } from "../commands/custom.js";
import { BUILTIN_COMMANDS, runCommand, type CommandContext } from "../commands/registry.js";
import { useAgent } from "./useAgent.js";

export type { UiBridge };

export interface AppProps {
  agent: Agent;
  workspace: string;
  modelRef: { current: string };
  config: CliConfig;
  resumedCount: number;
  /** Task checklist saved alongside the resumed session (via -c), if any. */
  initialTasks?: TaskItem[];
  undoStack: UndoStack;
  uiBridge: UiBridge;
  resumeSessions?: SessionMeta[];
  customCommands?: CustomCommand[];
  mcpToolCount?: number;
}

/** Preview of tool output: a few lines by default, everything when verbose. */
function toolOutputPreview(output: string, verbose: boolean): string {
  const lines = output.replace(/\s+$/, "").split("\n");
  if (verbose) return lines.join("\n");
  const head = lines.slice(0, 3).join("\n");
  return lines.length > 3 ? `${head}\n… (+${lines.length - 3} lines · Ctrl+O)` : head;
}

const MENTION_RE = /(^|\s)@([^\s@]*)$/;
const MENTION_ALL_RE = /(?:^|\s)@([^\s@]+)/g;
const MAX_MENTION_CHARS = 8000;
const IMAGE_RE = /\.(png|jpe?g|gif|webp|bmp)$/i;

export function App({
  agent,
  workspace,
  modelRef,
  config,
  resumedCount,
  initialTasks,
  undoStack,
  uiBridge,
  resumeSessions,
  customCommands = [],
  mcpToolCount = 0,
}: AppProps) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [input, setInput] = useState("");
  const [inputKey, setInputKey] = useState(0);
  const [steerInput, setSteerInput] = useState("");
  const [resumeFilter, setResumeFilter] = useState("");
  const [cmdIndex, setCmdIndex] = useState(0);
  const [fileIndex, setFileIndex] = useState(0);
  const [fileList, setFileList] = useState<string[]>([]);
  const [verbose, setVerbose] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [staticKey, setStaticKey] = useState(0);
  const inputHistory = useRef<string[]>([]);
  const histIndex = useRef<number>(-1); // -1 means "current, not browsing history"

  // Ink's <Static> flushes each item once at whatever width was current at the
  // time; already-flushed history doesn't rewrap when the terminal is
  // resized mid-turn. Remounting <Static> makes Ink treat all items as newly
  // added, so it reflows them at the new width through Ink's own safe
  // static-flush path. Don't write raw ANSI escapes ourselves here — Ink
  // tracks previously-written line counts internally (via log-update) to
  // erase and redraw the live input region; writing to stdout outside that
  // path desyncs the bookkeeping and corrupts the next redraw. Only remount
  // when the column count actually changed — panel actions that only change
  // height (e.g. VS Code adding/removing a split terminal, which fires
  // 'resize' too) shouldn't trigger a reflow, since there's nothing to rewrap.
  const lastColumns = useRef(stdout?.columns);
  useEffect(() => {
    if (!stdout) return;
    let timer: NodeJS.Timeout | undefined;
    const onResize = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (stdout.columns === lastColumns.current) return;
        lastColumns.current = stdout.columns;
        setStaticKey((k) => k + 1);
      }, 150);
    };
    stdout.on("resize", onResize);
    return () => {
      clearTimeout(timer);
      stdout.off("resize", onResize);
    };
  }, [stdout]);

  const refreshFileList = useCallback(() => {
    fg("**/*", {
      cwd: workspace,
      dot: false,
      onlyFiles: true,
      ignore: ["**/node_modules/**", "**/.git/**", "**/dist/**", ...loadIgnorePatterns(workspace)],
      suppressErrors: true,
    })
      .then((files) => setFileList(files.sort().slice(0, 2000)))
      .catch(() => {});
  }, [workspace]);

  useEffect(refreshFileList, [refreshFileList]);

  const {
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
    totalUsage,
    totalCost,
    tasks,
    setTasks,
    ctxPct,
    setCtxPct,
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
    costReport,
    runAgent,
    runWebSearch,
    onPermissionDecision,
    onResumeSelect,
  } = useAgent({
    agent,
    workspace,
    modelRef,
    config,
    uiBridge,
    resumedCount,
    initialTasks,
    resumeSessions,
    refreshFileList,
  });

  // Tick an elapsed-seconds counter while the agent is working.
  useEffect(() => {
    if (phase !== "working") {
      setElapsed(0);
      return;
    }
    const start = Date.now();
    const t = setInterval(() => setElapsed(Math.floor((Date.now() - start) / 1000)), 1000);
    return () => clearInterval(t);
  }, [phase]);

  const allCommands = [
    ...BUILTIN_COMMANDS,
    ...customCommands.map((c) => ({ name: c.name, description: c.description })),
  ];

  // Command suggestions while typing a slash command (before any arguments).
  const suggestions =
    phase === "input" && input.startsWith("/") && !input.includes(" ")
      ? allCommands.filter((c) => c.name.startsWith(input.trim()))
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
    setInputKey((k) => k + 1);
    setFileIndex(0);
  };

  useInput((_input, key) => {
    if (key.escape && phase === "working") {
      abortRef.current?.abort();
    }
    // Ctrl+O toggles showing full tool output.
    if (key.ctrl && _input === "o") {
      setVerbose((v) => !v);
      return;
    }
    // Shift+Tab cycles normal → accept-edits → plan → normal. Only from the
    // plain input state — not mid-permission-prompt, mid-resume-picker, etc.
    if (key.tab && key.shift && phase === "input") {
      cycleMode();
      return;
    }
    // First-time accept-edits confirmation: Yes proceeds, anything else cancels.
    if (phase === "confirmMode") {
      const c = _input.toLowerCase();
      if (c === "y" || key.return) onAcceptEditsConfirm(true);
      else if (c === "n" || key.escape) onAcceptEditsConfirm(false);
      return;
    }
    // History recall with ↑/↓ when no autocomplete popup is open.
    if (phase === "input" && !suggestions.length && !fileSuggestions.length) {
      const hist = inputHistory.current;
      if (key.upArrow && hist.length) {
        histIndex.current =
          histIndex.current === -1 ? hist.length - 1 : Math.max(0, histIndex.current - 1);
        setInput(hist[histIndex.current]);
        return;
      }
      if (key.downArrow && histIndex.current !== -1) {
        histIndex.current += 1;
        if (histIndex.current >= hist.length) {
          histIndex.current = -1;
          setInput("");
        } else {
          setInput(hist[histIndex.current]);
        }
        return;
      }
    }
    if (phase === "resume") {
      if (key.backspace || key.delete) setResumeFilter((f) => f.slice(0, -1));
      else if (_input && !key.upArrow && !key.downArrow && !key.return && !key.escape && !key.tab) {
        setResumeFilter((f) => f + _input);
      }
    }
    if (suggestions.length) {
      if (key.upArrow) setCmdIndex((i) => (i - 1 + suggestions.length) % suggestions.length);
      else if (key.downArrow) setCmdIndex((i) => (i + 1) % suggestions.length);
      else if (key.tab) {
        setInput(suggestions[selectedCmd].name + " ");
        setInputKey((k) => k + 1);
      }
    } else if (fileSuggestions.length) {
      if (key.upArrow)
        setFileIndex((i) => (i - 1 + fileSuggestions.length) % fileSuggestions.length);
      else if (key.downArrow) setFileIndex((i) => (i + 1) % fileSuggestions.length);
      else if (key.tab) completeMention(fileSuggestions[selectedFile]);
    }
  });

  const handleSlash = (raw: string) => {
    const [cmd, ...rest] = raw.trim().split(/\s+/);
    const arg = rest.join(" ");
    const ctx: CommandContext = {
      arg,
      raw,
      agent,
      workspace,
      config,
      undoStack,
      customCommands,
      mcpToolCount,
      planMode,
      acceptEdits,
      setAcceptEdits,
      addItem,
      setPhase,
      setActivity,
      setCtxPct,
      setTasks,
      setPlanMode,
      setModelEverywhere,
      refreshFileList,
      runAgent,
      runWebSearch,
      expandMentions,
      costReport,
      gitDiffStat,
      exit,
    };
    void runCommand(cmd, ctx);
  };

  const expandMentions = (text: string): string => {
    const mentions = [...new Set([...text.matchAll(MENTION_ALL_RE)].map((m) => m[1]))];
    let extra = "";
    for (const p of mentions) {
      if (IMAGE_RE.test(p)) continue; // images are attached separately, not inlined as text
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

  // Collect @-mentioned image files as data URIs for vision-capable models.
  const collectImages = (text: string): string[] => {
    const images: string[] = [];
    for (const p of new Set([...text.matchAll(MENTION_ALL_RE)].map((m) => m[1]))) {
      if (!IMAGE_RE.test(p)) continue;
      try {
        const abs = resolveSafe(workspace, p);
        const b64 = fs.readFileSync(abs).toString("base64");
        const ext = p.split(".").pop()!.toLowerCase();
        const mime = ext === "jpg" ? "jpeg" : ext;
        images.push(`data:image/${mime};base64,${b64}`);
      } catch {
        // Not a readable image — skip.
      }
    }
    return images;
  };

  const handleSubmit = async (value: string) => {
    // Enter while command suggestions are open selects the highlighted command instead of sending.
    if (suggestions.length && value.trim() !== suggestions[selectedCmd].name) {
      setInput(suggestions[selectedCmd].name + " ");
      setInputKey((k) => k + 1);
      setCmdIndex(0);
      return;
    }
    // Enter while file suggestions are open completes the mention instead of sending.
    if (fileSuggestions.length && mentionFragment !== fileSuggestions[selectedFile].toLowerCase()) {
      completeMention(fileSuggestions[selectedFile]);
      return;
    }

    const text = value.trim();
    setInput("");
    setCmdIndex(0);
    setFileIndex(0);
    histIndex.current = -1;
    if (!text) return;
    if (inputHistory.current[inputHistory.current.length - 1] !== text) {
      inputHistory.current.push(text);
    }
    if (text.startsWith("/")) {
      handleSlash(text);
      return;
    }

    addItem({ kind: "user", text });
    const images = collectImages(text);
    if (images.length) addItem({ kind: "info", text: `Attached ${images.length} image(s).` });
    await runAgent(expandMentions(text), images);
  };

  return (
    <Box flexDirection="column">
      <Static key={staticKey} items={items}>
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
              <Box flexDirection="column">
                <Text dimColor>
                  {item.error ? <Text color="red">✗</Text> : <Text color="green">✓</Text>}{" "}
                  {item.summary}
                </Text>
                {item.output && item.output.trim() && (
                  <Text dimColor>
                    {toolOutputPreview(item.output, verbose)
                      .split("\n")
                      .map((l) => `    ${l}`)
                      .join("\n")}
                  </Text>
                )}
              </Box>
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
              color={
                t.status === "done" ? "green" : t.status === "in_progress" ? "yellow" : undefined
              }
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
              activity
                ? activity
                : thinking
                  ? "thinking… (Esc to cancel)"
                  : "working… (Esc to cancel)"
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
          warning={permission.warning}
          onDecision={onPermissionDecision}
        />
      )}

      {phase === "confirmMode" && (
        <Box flexDirection="column" borderStyle="round" borderColor="green" paddingX={1}>
          <Text bold color="green">
            Switch to accept-edits mode?
          </Text>
          <Text>File writes and edits will auto-approve without asking.</Text>
          <Text dimColor>
            Destructive shell commands (rm -rf, force-push, etc.) always still ask, in every mode.
          </Text>
          <Text dimColor>Shift+Tab again moves to plan mode; once more back to normal.</Text>
          <Box marginTop={1}>
            <Text>
              <Text color="green">Yes (y)</Text> · No (n/Esc)
            </Text>
          </Box>
        </Box>
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
            Resume a session <Text dimColor>(type to search · Esc for a fresh one)</Text>
          </Text>
          {resumeFilter ? (
            <Text>
              <Text dimColor>filter: </Text>
              {resumeFilter}
            </Text>
          ) : null}
          <SelectList
            items={(resumeSessions ?? [])
              .filter(
                (s) =>
                  s.title.toLowerCase().includes(resumeFilter.toLowerCase()) ||
                  SessionStore.matchesContent(s.file, resumeFilter)
              )
              .map((s) => ({
                label: s.title,
                value: s.file,
                hint: `${s.date} · ${s.count} msgs`,
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
              key={inputKey}
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
                <Text key={c.name} color={i === selectedCmd ? "cyan" : undefined}>
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
                <Text key={f} color={i === selectedFile ? "cyan" : undefined}>
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
          {planMode ? (
            <Text color="cyan">plan · </Text>
          ) : acceptEdits ? (
            <Text color="green">accept edits ({autoApprovedCount} auto-approved) · </Text>
          ) : (
            ""
          )}
          {model}
          {branch ? ` · ⎇ ${branch}` : ""}
          {tasks.length > 0
            ? ` · tasks ${tasks.filter((t) => t.status === "done").length}/${tasks.length}`
            : ""}
          {ctxPct > 0 ? ` · ctx ${ctxPct}%` : ""}
          {phase === "working" && elapsed > 0 ? ` · ${elapsed}s` : ""} ·{" "}
          {totalUsage.promptTokens.toLocaleString()} in /{" "}
          {totalUsage.completionTokens.toLocaleString()} out
          {totalCost > 0 ? ` · $${totalCost.toFixed(4)}` : ""}
          {verbose ? " · verbose" : ""} · {path.basename(workspace)}
        </Text>
      </Box>
    </Box>
  );
}
