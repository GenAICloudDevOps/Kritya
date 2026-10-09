import { useCallback, useEffect, useRef, useState } from "react";
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
import { buildPaletteItems } from "./palette.js";
import { searchHistory } from "./historySearch.js";
import { extractLastCodeBlock, type CodeBlock } from "./codeBlock.js";
import { copyToClipboard } from "./clipboard.js";
import { loadCommandRecency, type CommandRecency } from "./recentCommands.js";
import { Spinner } from "./Spinner.js";
import { StatusLine } from "./StatusLine.js";
import { StreamViewport } from "./StreamViewport.js";
import { TextInput } from "./TextInput.js";
import { TranscriptItem } from "./TranscriptItem.js";
import { terminalColumns, terminalRows } from "./viewport.js";
import { fitRow, listRows, ROW_GUTTER, ROW_SEPARATOR, windowList } from "./windowList.js";
import type { CustomCommand } from "../commands/custom.js";
import { BUILTIN_COMMANDS, runCommand, type CommandContext } from "../commands/registry.js";
import { mcpPrompts, mcpResources } from "../mcp/client.js";
import { useAgent, type Item } from "./useAgent.js";

export type { UiBridge };

export interface AppProps {
  agent: Agent;
  workspace: string;
  modelRef: { current: string };
  providerRef: { current: string };
  config: CliConfig;
  resumedCount: number;
  /** Short name of the session opened by `-r <name>`, so the transcript can name it. */
  resumedName?: string;
  /** Updates the client subagents (spawn_agent) construct with, so a /provider switch applies to them too. */
  onSwitchClient(client: ProviderClient): void;
  /** Task checklist saved alongside the resumed session (via -c), if any. */
  initialTasks?: TaskItem[];
  undoStack: UndoStack;
  uiBridge: UiBridge;
  resumeSessions?: SessionMeta[];
  customCommands?: CustomCommand[];
  mcpToolCount?: number;
  /**
   * Whether this workspace has never been opened before. The full ASCII banner
   * shows on *every* launch (see Banner.tsx); this flag now only gates the
   * first-run "Try asking:" hints, which would be noise once you know the tool.
   * See bannerSeen.ts.
   */
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

/**
 * The most recent complete code block the *agent* wrote, newest first.
 *
 * Walks the transcript backwards so the newest block wins — the user asking
 * "copy that" almost always means the one just shown — and reads only
 * `assistant` items, because a block the user pasted is not the agent's.
 * `extractLastCodeBlock` returns null for a still-open fence, so a block that
 * is mid-stream is skipped rather than copied half-written.
 */
function findLastAssistantCodeBlock(items: Item[]): CodeBlock | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item.kind !== "assistant") continue;
    const block = extractLastCodeBlock(item.text);
    if (block) return block;
  }
  return null;
}

export function App({
  agent,
  workspace,
  modelRef,
  providerRef,
  config,
  resumedCount,
  resumedName,
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
  const [paletteFilter, setPaletteFilter] = useState("");
  const [historyFilter, setHistoryFilter] = useState("");
  const [cmdIndex, setCmdIndex] = useState(0);
  const [fileIndex, setFileIndex] = useState(0);
  const [fileList, setFileList] = useState<string[]>([]);
  const [verbose, setVerbose] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const inputHistory = useRef<string[]>([]);
  const histIndex = useRef<number>(-1); // -1 means "current, not browsing history"
  // The Ctrl+R cursor: an index into the *filtered* history list (0 = newest
  // match). A ref, not `cmdIndex`, so the palette's suggestion cursor and the
  // history cursor can never clobber each other.
  const historyCursor = useRef<number>(0);
  // Command recency for the palette's ordering. Read lazily when the palette
  // opens rather than at mount: /doctor and a long session both run commands,
  // and the file on disk is the source of truth. A ref (not state) because it
  // only feeds the palette's sort — nothing else re-renders on it.
  const commandRecency = useRef<CommandRecency>({});

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
    clearItems,
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
    resumedName,
    initialTasks,
    resumeSessions,
    refreshFileList,
    onSwitchClient,
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

  /** One rendered line of the suggestion list: a group heading or a command. */
  type SuggestionLine =
    { kind: "header"; label: string } | { kind: "cmd"; cmd: (typeof suggestions)[number] };

  /**
   * The suggestion list flattened to rendered lines, so a group heading costs
   * a row like any other — windowing the commands alone would still let the
   * headings push real rows off the bottom of the screen.
   *
   * `lineOfCmd[i]` is the line `suggestions[i]` landed on. The cursor indexes
   * commands, because that is what the arrow keys move through; this is what
   * maps it onto a line.
   */
  const suggestionLines: SuggestionLine[] = [];
  const lineOfCmd: number[] = [];
  {
    // Group headers only earn their keep once more than one category is
    // actually on screen — once typing has filtered down to a single family,
    // a lone header is just noise.
    const showHeaders = new Set(suggestions.map((c) => c.category)).size > 1;
    let lastCategory: string | undefined;
    for (const c of suggestions) {
      if (showHeaders && c.category !== lastCategory) {
        suggestionLines.push({ kind: "header", label: c.category ?? "Other" });
        lastCategory = c.category;
      }
      lineOfCmd.push(suggestionLines.length);
      suggestionLines.push({ kind: "cmd", cmd: c });
    }
  }
  // The transcript above is static; this reserves the prompt box, the hint
  // line and the status line, which is what has to stay visible.
  const suggestionWindow = windowList(
    suggestionLines,
    lineOfCmd[selectedCmd] ?? 0,
    listRows(rows, 8)
  );
  // The list is indented by its own paddingLeft, then by the row's marker.
  const suggestionRowWidth = contentWidth - 2 - ROW_GUTTER;

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

  // Ctrl+B: copy the agent's most recent complete code block. Scans the
  // transcript backwards so the newest block wins, and only assistant text is
  // considered — a user's own pasted block is not "the agent's most recent".
  const copyLastCodeBlock = useCallback(async () => {
    const block = findLastAssistantCodeBlock(items);
    if (!block) {
      addItem({
        kind: "info",
        text: "Ctrl+B: no code block in this transcript yet.",
      });
      return;
    }
    const ok = await copyToClipboard(block.code);
    const lines = block.code.split("\n").length;
    if (ok) {
      addItem({
        kind: "info",
        text: `Copied the last code block (${lines} line${lines === 1 ? "" : "s"}${block.lang ? `, ${block.lang}` : ""}) to the clipboard.`,
      });
    } else {
      addItem({
        kind: "info",
        text: "Ctrl+B: no clipboard tool found (Linux needs wl-copy, xclip or xsel).",
      });
    }
  }, [items, addItem]);

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
    // Ctrl+P opens the command palette — fuzzy-find commands and checkpoints.
    // Idle prompt only, like Ctrl+E: opening it mid-turn would race the agent,
    // and the kill switch above must keep its chord unshared.
    if (key.ctrl && _input === "p") {
      if (phase === "input") {
        setPaletteFilter("");
        // Re-read on each open so a command run earlier in this session is
        // reflected; a failed read degrades to the previous map, never throws.
        commandRecency.current = loadCommandRecency();
        setPhase("palette");
      } else if (phase === "palette") {
        setPhase("input");
      }
      return;
    }
    // Ctrl+R opens reverse history search — the whole in-memory history,
    // filtered by fragment. ↑/↓ already walks history one entry at a time,
    // which is no help for an entry forty back. Toggles closed like Ctrl+P.
    // Idle prompt only, so it can't race a running turn.
    if (key.ctrl && _input === "r") {
      if (phase === "input") {
        setHistoryFilter("");
        histIndex.current = -1;
        historyCursor.current = 0;
        setPhase("history");
      } else if (phase === "history") {
        setPhase("input");
      }
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
    // Ctrl+B copies the agent's most recent code block to the clipboard. Works
    // from any phase: it reads the transcript, not the input line, so it is
    // safe mid-turn (and useful exactly then — the block just appeared) and
    // unlike Ctrl+E it cannot race the agent over a shared resource.
    if (key.ctrl && _input === "b") {
      void copyLastCodeBlock();
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
    if (phase === "palette") {
      if (key.backspace || key.delete) setPaletteFilter((f) => f.slice(0, -1));
      else if (_input && !key.upArrow && !key.downArrow && !key.return && !key.escape && !key.tab) {
        setPaletteFilter((f) => f + _input);
      }
    }
    if (phase === "history") {
      // Newest-first, so index 0 is the most recent match.
      const matches = searchHistory([...inputHistory.current].reverse(), historyFilter);
      if (key.backspace || key.delete) {
        setHistoryFilter((f) => f.slice(0, -1));
        historyCursor.current = 0; // a changed query invalidates the old selection
      } else if (key.upArrow) {
        historyCursor.current = Math.max(historyCursor.current - 1, 0);
      } else if (key.downArrow) {
        historyCursor.current = Math.min(
          historyCursor.current + 1,
          Math.max(matches.length - 1, 0)
        );
      } else if (key.return) {
        const picked = matches[Math.min(historyCursor.current, matches.length - 1)];
        if (picked) {
          setInput(picked.text);
          setInputKey((k) => k + 1);
        }
        histIndex.current = -1; // the ↑/↓ browser starts fresh from the input
        setPhase("input");
      } else if (key.escape) {
        setPhase("input");
      } else if (_input && !key.tab) {
        setHistoryFilter((f) => f + _input);
        historyCursor.current = 0;
      }
      return;
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
      clearItems,
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

  // Command palette selection. Commands are inserted into the input line —
  // never executed blind: a fuzzy finder that runs on Enter is how
  // conversations get cleared by accident. Checkpoints rewind immediately;
  // the name is complete and unambiguous, exactly like /rewind <name>.
  const onPaletteSelect = (value: string) => {
    if (value.startsWith("checkpoint:")) {
      const name = value.slice("checkpoint:".length);
      setPhase("input");
      handleSlash(`/rewind ${name}`);
      return;
    }
    if (value.startsWith("cmd:")) {
      setInput(`${value.slice("cmd:".length)} `);
      setInputKey((k) => k + 1);
      setPhase("input");
    }
  };

  const paletteItems = buildPaletteItems(
    allCommands,
    agent.listCheckpoints(),
    paletteFilter,
    commandRecency.current
  );

  // Reverse history search rows. Built from the in-memory history (there is no
  // disk history), newest first, which is why the list is reversed: the entry
  // just typed is the one Ctrl+R should offer first.
  const historyMatches = searchHistory([...inputHistory.current].reverse(), historyFilter);
  const historySelected = Math.min(historyCursor.current, Math.max(historyMatches.length - 1, 0));

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
            Resume a session{" "}
            <Text dimColor>
              (type to search · Esc for a fresh one · -r &lt;name&gt; to skip this)
            </Text>
          </Text>
          {resumeFilter ? (
            <Text>
              <Text dimColor>filter: </Text>
              {resumeFilter}
            </Text>
          ) : null}
          <SelectList
            items={(resumeSessions ?? [])
              .filter((s) => {
                const f = resumeFilter.toLowerCase();
                return (
                  s.title.toLowerCase().includes(f) ||
                  s.name.toLowerCase().includes(f) ||
                  SessionStore.matchesContent(s.file, resumeFilter)
                );
              })
              .map((s) => ({
                label: s.name || s.title,
                value: s.file,
                hint: `${s.shortId} · ${s.date} · ${s.count} msgs`,
              }))}
            onSelect={onResumeSelect}
            onCancel={() => onResumeSelect("")}
          />
        </Box>
      )}

      {phase === "palette" && (
        <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
          <Text bold color="cyan">
            Command palette{" "}
            <Text dimColor>
              (type to filter · ↑↓ navigate · Enter selects · Esc closes · Ctrl+P toggles)
            </Text>
          </Text>
          {paletteFilter ? (
            <Text>
              <Text dimColor>filter: </Text>
              {paletteFilter}
            </Text>
          ) : null}
          <SelectList
            items={paletteItems}
            onSelect={onPaletteSelect}
            onCancel={() => setPhase("input")}
          />
        </Box>
      )}

      {phase === "history" && (
        <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
          <Text bold color="yellow">
            History{" "}
            <Text dimColor>
              (type to search · ↑↓ navigate · Enter selects · Esc closes · Ctrl+R toggles)
            </Text>
          </Text>
          <Text>
            <Text dimColor>query: </Text>
            {historyFilter || <Text dimColor>(all recent prompts)</Text>}
          </Text>
          {/* Rendered by hand rather than via SelectList: this list is driven
              by the App-level cursor (a ref), and a second `useInput` inside
              SelectList would double-handle the same arrows. */}
          {historyMatches.length === 0 ? (
            <Text dimColor> no matches</Text>
          ) : (
            historyMatches.slice(0, 10).map((m, i) => (
              <Text
                key={`${m.index}:${m.text}`}
                color={i === historySelected ? "green" : undefined}
              >
                {i === historySelected ? "❯ " : "  "}
                {m.text}
              </Text>
            ))
          )}
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
              {suggestionWindow.visible.map((line, i) => {
                if (line.kind === "header") {
                  return (
                    <Text key={`header:${line.label}`} dimColor wrap="truncate">
                      {line.label}
                    </Text>
                  );
                }
                const c = line.cmd;
                const selected = i === suggestionWindow.cursor;
                const row = fitRow(c.name, c.description, suggestionRowWidth);
                return (
                  // truncate is a backstop: the row must never grow a second
                  // line, whatever the width arithmetic does with odd glyphs.
                  <Text key={c.name} color={selected ? "cyan" : undefined} wrap="truncate">
                    {selected ? "❯ " : "  "}
                    <Text bold={selected}>{row.label}</Text>
                    {row.hint ? (
                      <Text dimColor>
                        {ROW_SEPARATOR}
                        {row.hint}
                      </Text>
                    ) : null}
                  </Text>
                );
              })}
              {suggestionWindow.clipped ? (
                <Text dimColor>
                  {"  "}
                  {suggestionWindow.from}–{suggestionWindow.to} of {suggestionWindow.total} · ↑↓ to
                  scroll
                </Text>
              ) : null}
              <Text dimColor>↑↓ select · Tab/Enter insert · Esc cancel</Text>
            </Box>
          )}
          {/* A fragment that matches nothing used to make the list vanish with
              no explanation, which reads as a broken menu rather than a miss. */}
          {phase === "input" &&
            input.startsWith("/") &&
            !input.includes(" ") &&
            suggestions.length === 0 && (
              <Box paddingLeft={2}>
                <Text dimColor>no command matches {input.trim()} · Esc to clear</Text>
              </Box>
            )}
          {fileSuggestions.length > 0 && (
            <Box flexDirection="column" paddingLeft={2}>
              {fileSuggestions.map((f, i) => (
                <Text key={f} color={i === selectedFile ? "cyan" : undefined} wrap="truncate">
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
