import { useCallback, useEffect, useRef, useState } from "react";
import { Box, Static, Text, useApp, useInput, useStdout } from "ink";
import TextInput from "ink-text-input";
import fs from "node:fs";
import path from "node:path";
import fg from "fast-glob";
import type { Agent } from "../agent/loop.js";
import { gitDiffStat } from "../git/git.js";
import type { CliConfig } from "../config/config.js";
import type { ProviderClient } from "../provider/client.js";
import { SessionStore, type SessionMeta } from "../session/store.js";
import { resolveSafe } from "../tools/common.js";
import { loadIgnorePatterns } from "../tools/ignore.js";
import type { UndoStack } from "../undo/undo.js";
import type { TaskItem, UiBridge } from "../types.js";
import { Banner } from "./Banner.js";
import { truncateToWidth } from "./inline.js";
import { Markdown } from "./Markdown.js";
import { ModelPicker } from "./ModelPicker.js";
import { PermissionPrompt } from "./PermissionPrompt.js";
import { SelectList } from "./SelectList.js";
import { Spinner } from "./Spinner.js";
import { tailForViewport } from "./viewport.js";
import type { CustomCommand } from "../commands/custom.js";
import { BUILTIN_COMMANDS, runCommand, type CommandContext } from "../commands/registry.js";
import { mcpPrompts, mcpResources } from "../mcp/client.js";
import { useAgent } from "./useAgent.js";

export type { UiBridge };

export interface AppProps {
  agent: Agent;
  workspace: string;
  modelRef: { current: string };
  providerRef: { current: string };
  config: CliConfig;
  resumedCount: number;
  /** Updates the client subagents (spawn_agent) construct with, so a /provider switch applies to them too. */
  onSwitchClient(client: ProviderClient): void;
  /** Task checklist saved alongside the resumed session (via -c), if any. */
  initialTasks?: TaskItem[];
  undoStack: UndoStack;
  uiBridge: UiBridge;
  resumeSessions?: SessionMeta[];
  customCommands?: CustomCommand[];
  mcpToolCount?: number;
}

/**
 * Preview of tool output: a few lines by default, everything when verbose.
 * Tabs are expanded first — `read` emits a padded line number and a tab, which
 * the terminal takes to the next 8-column stop, leaving a ragged gap that made
 * previews look broken. Lines are clipped rather than wrapped, so a preview
 * stays the size it claims to be.
 */
function toolOutputPreview(
  output: string,
  verbose: boolean,
  width: number,
  isError = false
): string {
  const lines = output
    .replace(/\s+$/, "")
    .split("\n")
    .map((l) => l.replace(/^(\s*\d+)\t/, "$1 ").replace(/\t/g, "  "));
  while (lines.length && !lines[0].trim()) lines.shift();
  // Drop indentation every line shares — `read` pads its line numbers to five
  // columns, which is dead space in a preview that is already indented.
  const common = Math.min(
    ...lines.filter((l) => l.trim()).map((l) => /^ */.exec(l)![0].length),
    Infinity
  );
  if (common > 0 && common < Infinity) {
    for (let i = 0; i < lines.length; i++) lines[i] = lines[i].slice(common);
  }
  if (verbose) return lines.join("\n");
  // A failure is exactly when the detail is worth the rows.
  const keep = isError ? 8 : 3;
  const head = lines.slice(0, keep).map((l) => truncateToWidth(l, width));
  return lines.length > keep
    ? `${head.join("\n")}\n… (+${lines.length - keep} lines · Ctrl+O)`
    : head.join("\n");
}

const MENTION_RE = /(^|\s)@([^\s@]*)$/;
const MENTION_ALL_RE = /(?:^|\s)@([^\s@]+)/g;
const MAX_MENTION_CHARS = 8000;
const IMAGE_RE = /\.(png|jpe?g|gif|webp|bmp)$/i;

// Erase screen + scrollback, then home the cursor (same sequence Ink itself
// uses for its own "content taller than the terminal" clear path).
const CLEAR_TERMINAL = "\x1b[2J\x1b[3J\x1b[H";

export function App({
  agent,
  workspace,
  modelRef,
  providerRef,
  config,
  resumedCount,
  initialTasks,
  undoStack,
  uiBridge,
  resumeSessions,
  customCommands = [],
  mcpToolCount = 0,
  onSwitchClient,
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

  // Terminals that reflow their buffer on resize (e.g. VS Code's xterm.js)
  // rewrap already-printed full-width lines (banner art, box borders) to the
  // new column count on their own, before Ink's next redraw arrives. Ink then
  // erases based on a stale line count from before that reflow, so it clears
  // the wrong number of rows and leaves stale copies of boxes/banners behind
  // — compounding on every resize. There's no way to reflow in place safely,
  // so once the column count actually settles on a new value (ignoring
  // height-only resizes, e.g. VS Code adding a split terminal), wipe the
  // screen ourselves and remount <Static> so Ink reprints everything fresh
  // onto a blank canvas. The manual clear is safe here specifically because
  // the forced remount immediately triggers Ink's own static-flush path,
  // which resyncs its internal line-count bookkeeping — it's only unsafe to
  // write raw ANSI without following it with something that resets that
  // bookkeeping.
  const lastColumns = useRef(stdout?.columns);
  useEffect(() => {
    if (!stdout) return;
    let timer: NodeJS.Timeout | undefined;
    const onResize = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (stdout.columns === lastColumns.current) return;
        lastColumns.current = stdout.columns;
        stdout.write(CLEAR_TERMINAL);
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
    inFlight,
    model,
    provider,
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
    onResumeSelect,
  } = useAgent({
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
    // Servers can contribute slash commands too (MCP prompts).
    ...mcpPrompts().map((p) => ({ name: p.command, description: p.description })),
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
      ? [...fileList, ...mcpResources().map((r) => r.mention)]
          .filter((f) => f.toLowerCase().includes(mentionFragment))
          .slice(0, 8)
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
    // Ctrl+K is the kill switch, and it comes before every other binding and
    // phase check on purpose: a panic button that only works from the idle
    // input line is not a panic button. It fires mid-stream, mid-tool, and
    // while a permission prompt is on screen.
    if (key.ctrl && _input === "k") {
      if (killed) return; // already stopped; /kill off is the way back
      engageKill("Ctrl+K");
      return;
    }
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
      tokenBudget,
      budgetPct,
      budgetUsed,
      budgetStopped,
      resetBudget,
      setBudgetLimit,
      addItem,
      setPhase,
      setActivity,
      setCtxPct,
      setTasks,
      setPlanMode,
      killed,
      killReason,
      engageKill,
      releaseKill,
      setModelEverywhere,
      provider,
      setProviderEverywhere,
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

  const expandMentions = async (text: string): Promise<string> => {
    const mentions = [...new Set([...text.matchAll(MENTION_ALL_RE)].map((m) => m[1]))];
    let extra = "";
    for (const p of mentions) {
      if (IMAGE_RE.test(p)) continue; // images are attached separately, not inlined as text
      // An @mcp:… mention names a document a server offers rather than a file
      // on disk, so it's fetched instead of read — and marked as external,
      // since a server wrote it.
      const resource = mcpResources().find((r) => r.mention === p);
      if (resource) {
        try {
          const body = await resource.read();
          const capped =
            body.length > MAX_MENTION_CHARS
              ? body.slice(0, MAX_MENTION_CHARS) + "\n… (truncated)"
              : body;
          extra +=
            `\n\n[Attached MCP resource: ${resource.uri} from server "${resource.server}" — ` +
            `external content]\n\`\`\`\n${capped}\n\`\`\``;
        } catch (err) {
          extra += `\n\n[MCP resource ${p} could not be read: ${err instanceof Error ? err.message : String(err)}]`;
        }
        continue;
      }
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
    await runAgent(await expandMentions(text), images);
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
                  {item.resultSummary && !verbose ? ` — ${item.resultSummary}` : ""}
                </Text>
                {item.output && item.output.trim() && (!item.resultSummary || verbose) && (
                  <Text dimColor>
                    {toolOutputPreview(
                      item.output,
                      verbose,
                      Math.max(20, (stdout?.columns ?? 80) - 6),
                      item.error
                    )
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
          <Markdown
            text={tailForViewport(stream, stdout?.columns ?? 80, stdout?.rows ?? 24)}
            streaming
          />
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
              inFlight.length > 1
                ? `${inFlight.length} tools running (Esc to cancel)`
                : inFlight.length === 1
                  ? `${inFlight[0].summary} (Esc to cancel)`
                  : activity
                    ? activity
                    : thinking
                      ? "thinking… (Esc to cancel)"
                      : "working… (Esc to cancel)"
            }
          />
          {inFlight.length > 1 && (
            <Box flexDirection="column" marginLeft={2}>
              {inFlight.map((t) => (
                <Text key={t.id} dimColor>
                  · {t.summary}
                </Text>
              ))}
            </Box>
          )}
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
                void expandMentions(text).then((t) => agent.queueSteer(t));
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
          {killed ? (
            <Text bold color="red">
              ⛔ KILLED{killReason ? ` (${killReason})` : ""} ·{" "}
            </Text>
          ) : (
            ""
          )}
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
          {budgetPct > 0 ? (
            <Text color={budgetStopped ? "red" : budgetPct >= 80 ? "yellow" : undefined}>
              {" "}
              · budget {budgetPct}%
            </Text>
          ) : (
            ""
          )}
          {phase === "working" && elapsed > 0 ? ` · ${elapsed}s` : ""} ·{" "}
          {totalUsage.estimated ? "~" : ""}
          {totalUsage.promptTokens.toLocaleString()} in
          {(totalUsage.cachedPromptTokens ?? 0) > 0
            ? ` (${Math.round(((totalUsage.cachedPromptTokens ?? 0) / totalUsage.promptTokens) * 100)}% cached)`
            : ""}{" "}
          / {totalUsage.completionTokens.toLocaleString()} out
          {totalCost > 0 ? ` · $${totalCost.toFixed(4)}` : ""}
          {verbose ? " · verbose" : ""} · {path.basename(workspace)}
        </Text>
      </Box>
    </Box>
  );
}
