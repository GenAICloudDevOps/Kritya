import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import {
  Box,
  Static,
  Text,
  useApp,
  useBoxMetrics,
  useInput,
  useStderr,
  useWindowSize,
  type DOMElement,
} from "ink";
import fs from "node:fs";
import { glob } from "tinyglobby";
import stringWidth from "string-width";
import type { Agent } from "../agent/loop.js";
import { gitDiffStat } from "../git/git.js";
import type { CliConfig } from "../config/config.js";
import { modelDisplaySlug } from "../config/models.js";
import { setStderrSink } from "../stderr.js";
import { openInEditor } from "./openInEditor.js";
import type { ProviderClient } from "../provider/client.js";
import { SessionStore, type SessionMeta } from "../session/store.js";
import { defaultSandboxMode, sandboxAvailable } from "../shell/sandbox.js";
import { resolveSafe } from "../tools/common.js";
import { loadIgnorePatterns } from "../tools/ignore.js";
import type { UndoStack } from "../undo/undo.js";
import type { AgentHandlers, TaskItem, UiBridge } from "../types.js";
import { Markdown } from "./Markdown.js";
import { ModelPicker } from "./ModelPicker.js";
import { ElicitationPrompt } from "./ElicitationPrompt.js";
import { PermissionPrompt } from "./PermissionPrompt.js";
import { SelectList } from "./SelectList.js";
import { Spinner } from "./Spinner.js";
import { StatusLine } from "./StatusLine.js";
import { StreamViewport } from "./StreamViewport.js";
import { TextInput } from "./TextInput.js";
import { TranscriptItem } from "./TranscriptItem.js";
import { terminalColumns, terminalRows } from "./viewport.js";
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
  /** Whether the full ASCII banner has never been shown for this workspace before; see bannerSeen.ts. */
  firstLaunch: boolean;
  /** Hands the caller a stable reference to the same permission prompt tool
   *  calls use, so MCP sampling (which can arrive outside any turn) can ask
   *  for approval too, without a second prompt UI. */
  onRequestPermissionReady?(requestPermission: AgentHandlers["requestPermission"]): void;
  /** Same reasoning as `onRequestPermissionReady`, for MCP elicitation. */
  onRequestElicitationReady?(
    requestElicitation: Required<AgentHandlers>["requestElicitation"]
  ): void;
  privacyMode: boolean;
}

const MENTION_RE = /(^|\s)@([^\s@]*)$/;
const MENTION_ALL_RE = /(?:^|\s)@([^\s@]+)/g;
const MAX_MENTION_CHARS = 8000;
const IMAGE_RE = /\.(png|jpe?g|gif|webp|bmp)$/i;

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
  onRequestPermissionReady,
  onRequestElicitationReady,
  privacyMode,
  firstLaunch,
}: AppProps) {
  const { exit, suspendTerminal, waitUntilRenderFlush } = useApp();
  /**
   * Leave, but not until the screen has caught up.
   *
   * Ink's `exit()` tears the tree down in the same tick it is called, so a
   * state update made in that same tick — the last line of a transcript, a
   * "goodbye" item — is committed to a tree that is already being unmounted and
   * never reaches the terminal. Verified: `setState(x); exit();` drops `x`,
   * while deferring `exit()` by one macrotask draws it. `waitUntilRenderFlush()`
   * is Ink's own barrier for exactly this — it yields so React can commit, then
   * settles the throttled frame timer and waits for the write to drain.
   */
  const exitAfterFlush = useCallback(async () => {
    await waitUntilRenderFlush();
    exit();
  }, [exit, waitUntilRenderFlush]);
  /**
   * Hand warnings raised outside React a way through Ink.
   *
   * Agent loops, MCP clients and plugin loaders are plain module functions, so
   * they cannot call useStderr() themselves and had been writing straight to
   * process.stderr — which Ink knows nothing about, so the text landed in the
   * middle of the frame and the next repaint drew against the wrong line count.
   * Registering Ink's own writer for the lifetime of the UI puts them back
   * inside the clear-write-repaint sandwich. Cleared on unmount so the fallback
   * is raw stderr again for anything that outlives the UI. See src/stderr.ts.
   */
  const { write: writeStderr } = useStderr();
  useEffect(() => {
    setStderrSink(writeStderr);
    return () => setStderrSink(undefined);
  }, [writeStderr]);
  // Ink 8 types `stdout` as a plain Node stream, so the terminal's dimensions
  // come from useWindowSize() rather than stdout.columns / stdout.rows — and
  // it drives the re-layout on resize by itself. Kritya used to wipe the screen
  // and remount <Static> on every column change, because Ink erased its live
  // region against a stale line count after the terminal reflowed already-
  // printed lines. Ink 8 fixed that class of bug itself: it redraws the frame
  // when the terminal loses rows, keeps the content above the frame when rows
  // shrink, and preserves scrollback — which the old `\x1b[3J` clear threw
  // away. So the workaround is gone and nothing here watches for resizes.
  const windowSize = useWindowSize();
  const columns = terminalColumns(windowSize);
  const rows = terminalRows(windowSize);
  // The transcript column's real width, measured rather than assumed. The
  // wrapped renderers lay out to this, so if the chrome around them ever gains
  // padding the prose still breaks at the right column. Falls back to the
  // terminal width for the first frame, before layout has run.
  const rootRef = useRef<DOMElement | null>(null);
  const { clientWidth } = useBoxMetrics(rootRef);
  const contentWidth = clientWidth || columns;
  const [input, setInput] = useState("");
  const [inputKey, setInputKey] = useState(0);
  const [steerInput, setSteerInput] = useState("");
  const [resumeFilter, setResumeFilter] = useState("");
  const [cmdIndex, setCmdIndex] = useState(0);
  const [fileIndex, setFileIndex] = useState(0);
  const [fileList, setFileList] = useState<string[]>([]);
  const [verbose, setVerbose] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const inputHistory = useRef<string[]>([]);
  const histIndex = useRef<number>(-1); // -1 means "current, not browsing history"

  // Ctrl-chord bookkeeping used to live here: Ink delivers a keypress to every
  // `useInput` hook, and ink-text-input swallowed only Ctrl+C, so Ctrl+K and
  // Ctrl+O ran their shortcut *and* typed a bare "k"/"o" into the prompt — which
  // the next Enter would have sent as a message. Kritya's own TextInput drops
  // every ctrl/meta chord before it reaches the buffer, so there is nothing left
  // to undo and the workaround is gone.

  const refreshFileList = useCallback(() => {
    glob("**/*", {
      cwd: workspace,
      dot: false,
      onlyFiles: true,
      expandDirectories: false,
      ignore: ["**/node_modules/**", "**/.git/**", "**/dist/**", ...loadIgnorePatterns(workspace)],
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
    bypassMode,
    setBypassMode,
    autoApprovedCount,
    cycleMode,
    onAcceptEditsConfirm,
    onBypassModeConfirm,
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
    persistenceWarningCount,
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
    firstLaunch,
  });

  useEffect(() => {
    onRequestPermissionReady?.(requestPermission);
  }, [onRequestPermissionReady, requestPermission]);

  useEffect(() => {
    onRequestElicitationReady?.(requestElicitation);
  }, [onRequestElicitationReady, requestElicitation]);

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

  // Detail moved out of the always-visible status line (see StatusLine.tsx) —
  // surfaced instead via the /status command, on demand.
  const statusReport = useCallback((): string => {
    const sandboxActive =
      (config.sandboxExec ?? defaultSandboxMode()) !== "off" && sandboxAvailable();
    const cachedPct =
      (totalUsage.cachedPromptTokens ?? 0) > 0
        ? ` (${Math.round(((totalUsage.cachedPromptTokens ?? 0) / totalUsage.promptTokens) * 100)}% cached)`
        : "";
    const lines = [
      `workspace: ${workspace}`,
      `sandbox: ${sandboxActive ? "active" : "inactive"}`,
      `context used: ${ctxPct}%`,
      `token budget: ${budgetPct}% of ${tokenBudget.toLocaleString()} (${budgetUsed.toLocaleString()} used)${budgetStopped ? " — stopped" : ""}`,
      `tokens: ${totalUsage.estimated ? "~" : ""}${totalUsage.promptTokens.toLocaleString()} in${cachedPct} / ${totalUsage.completionTokens.toLocaleString()} out`,
      tasks.length > 0
        ? `tasks: ${tasks.filter((t) => t.status === "done").length}/${tasks.length} done`
        : null,
      phase === "working" && elapsed > 0 ? `elapsed: ${elapsed}s` : null,
      verbose ? "verbose: on" : null,
    ].filter((l): l is string => l !== null);
    return lines.join("\n");
  }, [
    config,
    workspace,
    ctxPct,
    budgetPct,
    tokenBudget,
    budgetUsed,
    budgetStopped,
    totalUsage,
    tasks,
    phase,
    elapsed,
    verbose,
  ]);

  const allCommands = [
    ...BUILTIN_COMMANDS,
    ...customCommands.map((c) => ({
      name: c.name,
      description: c.description,
      category: "Custom",
    })),
    // Servers can contribute slash commands too (MCP prompts).
    ...mcpPrompts().map((p) => ({ name: p.command, description: p.description, category: "MCP" })),
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

  // Ctrl+E opens the file the agent touched most recently in the user's
  // $EDITOR, suspending the UI while the editor owns the terminal. Ink
  // restores everything and repaints from scratch on resume; a hand-edit is
  // reported by the undo stack's watcher via onExternalEdit like any other
  // outside edit. Guarded against double presses — suspending twice throws.
  const editorBusy = useRef(false);
  const openInEditorFlow = useCallback(async () => {
    if (editorBusy.current) return;
    const target = undoStack.lastTouchedFile();
    if (!target) {
      addItem({
        kind: "info",
        text: "Ctrl+E: the agent hasn't touched any file yet this session.",
      });
      return;
    }
    editorBusy.current = true;
    try {
      await openInEditor(suspendTerminal, target.absPath);
    } finally {
      editorBusy.current = false;
    }
  }, [suspendTerminal, undoStack, addItem]);

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
      setActivity("cancelling…");
      abortRef.current?.abort();
    }
    // Ctrl+O toggles showing full tool output.
    if (key.ctrl && _input === "o") {
      setVerbose((v) => !v);
      return;
    }
    // Ctrl+E opens the most recently agent-touched file in $EDITOR. Only
    // from the idle prompt — never mid-turn, so the editor can't race the
    // agent over the same file.
    if (key.ctrl && _input === "e") {
      if (phase !== "input") {
        setActivity("Ctrl+E works from the idle prompt — stop the current turn first.");
        return;
      }
      void openInEditorFlow();
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
    // First-time auto/bypass-mode confirmation: Yes proceeds, anything else cancels.
    if (phase === "confirmBypassMode") {
      const c = _input.toLowerCase();
      if (c === "y" || key.return) onBypassModeConfirm(true);
      else if (c === "n" || key.escape) onBypassModeConfirm(false);
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
      bypassMode,
      setBypassMode,
      tokenBudget,
      budgetPct,
      budgetUsed,
      budgetStopped,
      resetBudget,
      setBudgetLimit,
      addItem,
      setPhase,
      setActivity,
      setRunningPhase,
      refreshWorkflow,
      setCtxPct,
      setTasks,
      setPlanMode,
      killed,
      killReason,
      engageKill,
      releaseKill,
      setModelEverywhere,
      provider,
      model,
      setProviderEverywhere,
      refreshFileList,
      runAgent,
      runWebSearch,
      expandMentions,
      costReport,
      statusReport,
      gitDiffStat,
      exit: exitAfterFlush,
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
    <Box ref={rootRef} flexDirection="column">
      <Static items={items}>
        {(item) => (
          <TranscriptItem key={item.id} item={item} verbose={verbose} contentWidth={contentWidth} />
        )}
      </Static>

      {firstLaunch && items.length <= 1 && phase === "input" && (
        <Box flexDirection="column" marginBottom={1} paddingLeft={2}>
          <Text dimColor>Try asking:</Text>
          <Text dimColor> · Explain this codebase</Text>
          <Text dimColor> · Find and fix failing tests</Text>
          <Text dimColor> · Review my uncommitted changes</Text>
          <Text dimColor> · Add a new feature</Text>
          <Text dimColor> · /help for commands</Text>
        </Box>
      )}

      {stream ? (
        <StreamViewport rows={rows}>
          <Markdown text={stream} streaming width={contentWidth} />
        </StreamViewport>
      ) : null}

      {tasks.length > 0 && (
        <Box
          flexDirection="column"
          borderStyle="round"
          borderColor="blue"
          paddingX={1}
          width={Math.min(columns - 2, Math.max(...tasks.map((t) => stringWidth(t.text))) + 6)}
        >
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
              // The workflow prefix rides on every branch, not just "thinking":
              // during a phase you want to know which phase a tool call belongs
              // to just as much as which phase is being reasoned about.
              (runningPhase ? `${workflow?.name ?? ""} · ${runningPhase} phase · ` : "") +
              (inFlight.length > 1
                ? `${inFlight.length} tools running (Esc to cancel)`
                : inFlight.length === 1
                  ? `${inFlight[0].status ? `${inFlight[0].summary} — ${inFlight[0].status}` : inFlight[0].summary} (Esc to cancel)`
                  : activity
                    ? activity
                    : thinking
                      ? "thinking… (Esc to cancel)"
                      : "working… (Esc to cancel)")
            }
          />
          {inFlight.length > 1 && (
            <Box flexDirection="column" marginLeft={2}>
              {inFlight.map((t) => (
                <Text key={t.id} dimColor>
                  · {t.status ? `${t.summary} — ${t.status}` : t.summary}
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

      {phase === "elicitation" && elicitation && (
        <ElicitationPrompt
          message={elicitation.message}
          fields={elicitation.fields}
          onDecision={onElicitationDecision}
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
          <Text dimColor>Shift+Tab again moves to dry-run mode; once more back to normal.</Text>
          <Box marginTop={1}>
            <Text>
              <Text color="green">Yes (y)</Text> · No (n/Esc)
            </Text>
          </Box>
        </Box>
      )}

      {phase === "confirmBypassMode" && (
        <Box flexDirection="column" borderStyle="round" borderColor="red" paddingX={1}>
          <Text bold color="red">
            Switch to auto mode? (sandbox-gated)
          </Text>
          <Text>
            EVERY tool call will auto-approve, including destructive shell commands (rm -rf,
            force-push, etc.) — nothing will ask first.
          </Text>
          <Text dimColor>
            The sandbox — not a human — is what contains any damage this mode causes.
          </Text>
          <Text dimColor>Shift+Tab again goes back to normal.</Text>
          <Box marginTop={1}>
            <Text>
              <Text color="red">Yes (y)</Text> · No (n/Esc)
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
              {(() => {
                // Group headers only earn their keep once more than one
                // category is actually on screen — once typing has filtered
                // down to a single family, a lone header is just noise.
                const showHeaders = new Set(suggestions.map((c) => c.category)).size > 1;
                let lastCategory: string | undefined;
                return suggestions.map((c, i) => {
                  const showHeader = showHeaders && c.category !== lastCategory;
                  lastCategory = c.category;
                  return (
                    <Fragment key={c.name}>
                      {showHeader && <Text dimColor>{c.category ?? "Other"}</Text>}
                      <Text color={i === selectedCmd ? "cyan" : undefined}>
                        {i === selectedCmd ? "❯ " : "  "}
                        <Text bold={i === selectedCmd}>{c.name}</Text>
                        <Text dimColor> — {c.description}</Text>
                      </Text>
                    </Fragment>
                  );
                });
              })()}
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
        <StatusLine
          killed={killed}
          killReason={killReason}
          dryRunMode={dryRunMode}
          planMode={planMode}
          acceptEdits={acceptEdits}
          bypassMode={bypassMode}
          autoApprovedCount={autoApprovedCount}
          provider={provider}
          model={
            servedModel && servedModel !== model
              ? `${model}-${modelDisplaySlug(servedModel)}`
              : model
          }
          workflow={workflow}
          branch={branch}
          budgetPct={budgetPct}
          budgetStopped={budgetStopped}
          totalCost={totalCost}
          sandboxActive={
            (config.sandboxExec ?? defaultSandboxMode()) !== "off" && sandboxAvailable()
          }
          persistenceWarningCount={persistenceWarningCount}
          privacyMode={privacyMode}
        />
      </Box>
    </Box>
  );
}
