import { isContextOverflowError, type ProviderClient } from "../provider/client.js";
import type { PermissionManager } from "../permissions/permissions.js";
import type { SessionStore } from "../session/store.js";
import type { AgentHandlers, ChatMessage, ToolContext, ToolDef } from "../types.js";
import { splitForCompaction, renderTranscript, fallbackSummary } from "./compactor.js";
import { estimateHistoryTokens, estimateTokens } from "./tokens.js";
import { buildSystemPrompt } from "./systemPrompt.js";
import type { AuditLog } from "../audit/audit.js";
import { NOOP_TRACER, type AttrValue, type Span, type Tracer } from "../telemetry/tracer.js";
import { NOOP_METER, type Meter } from "../telemetry/metrics.js";
import type { HookRunner } from "../hooks/hooks.js";
import { extractMemoryFacts, mergeProjectMemory, readProjectMemory } from "./memory.js";
import { KillSwitch, KillSwitchError, linkAbort } from "./killSwitch.js";
import { ToolExecutor } from "./toolExecutor.js";
export { ToolTimeoutError } from "./toolExecutor.js";

const DEFAULT_MAX_STEPS = 40;

const COMPACT_THRESHOLD = 0.8;
/** Below this, compaction has nothing to summarize away that isn't the live tail. */
const MIN_HISTORY_TO_COMPACT = 12;
/** Default ceiling on a single tool call; see Agent.toolTimeoutMs. */
const DEFAULT_TOOL_TIMEOUT_MS = 120_000;

/** A named point in the conversation, paired with the undo turn at that moment,
 *  so /rewind can roll the transcript and the files back together. */
export interface Checkpoint {
  name: string;
  /** Number of messages in history when the checkpoint was taken. */
  historyLength: number;
  /** UndoStack turn counter then; file changes newer than this are rolled back. */
  undoTurn: number;
  createdAt: number;
}

export class Agent {
  history: ChatMessage[];
  /** Prompt size of the most recent model call, from the API's usage report. */
  lastPromptTokens = 0;
  /** Model context window in tokens; configurable via config.contextWindow. */
  contextWindow = 120_000;
  /** Max model round-trips per request before stopping to ask the user. */
  maxSteps = DEFAULT_MAX_STEPS;
  /**
   * How long one tool call may run before it's abandoned (config
   * `toolTimeoutSeconds`). A tool with its own deadline opts out via
   * `ToolDef.timeoutMs = 0`; 0 here disables the cap for every tool.
   */
  toolTimeoutMs = DEFAULT_TOOL_TIMEOUT_MS;
  /** When true, mutating tools are auto-denied (plan / read-only mode). */
  planMode = false;
  /**
   * When true, mutating tools are auto-denied — the manual Shift+Tab
   * read-only toggle. Independent of `planMode`, which the project
   * workflow's own PLAN phase owns; the two are separate gates that can be
   * on at the same time, each blocking on its own.
   */
  dryRunMode = false;
  /** When true, file-edit tools auto-approve without prompting (see ACCEPT_EDITS_TOOL_NAMES). */
  acceptEdits = false;
  /**
   * Whether a human can see and respond to a permission prompt right now.
   * True by default (the CLI and its subagents render one); headless runs
   * set this false because there is no one to answer it, so a forced
   * warning prompt there must resolve on its own rather than block forever.
   */
  interactive = true;
  /** Fires each time a tool call is auto-approved because of acceptEdits, for a UI counter. */
  onAutoApprove?: () => void;
  /**
   * When true, compaction also distills durable project facts out of the
   * summarized-away messages and merges them into KRITYA.md, so useful
   * context isn't lost once it scrolls out of the transcript. Off by
   * default — only the main interactive agent opts in; subagents (which
   * also run this same loop) should never write to the user's project
   * memory on their own.
   */
  autoMemory = false;
  /** Optional user-configured shell hooks around tool calls and turn end. */
  hooks?: HookRunner;
  /**
   * The session's emergency stop. Every agent gets its own by default so a
   * standalone one is never unguarded; whoever spawns subagents assigns the
   * parent's instance to them, so one switch halts the whole tree.
   */
  kill = new KillSwitch();
  /**
   * Append-only audit trail of permission decisions and tool executions. Left
   * unset on subagents; only the main session records an audit log.
   */
  audit?: AuditLog;
  /** OpenTelemetry-shaped tracer for the tool loop. No-op unless enabled. */
  tracer: Tracer = NOOP_TRACER;
  /** OTLP metrics recorder for tool/turn durations. No-op unless enabled. */
  meter: Meter = NOOP_METER;
  /**
   * Trace id of the most recent turn, so a caller that reports a result
   * elsewhere (headless JSON) can point the reader at the matching spans.
   * Undefined while telemetry is off, since the no-op tracer mints no ids.
   */
  lastTraceId?: string;
  /**
   * When set, the next turn's span nests under this one instead of starting a
   * fresh trace. Used to fold a subagent's spans into the parent turn's trace
   * — set by whoever spawns the subagent, using the parent's `turnSpan`.
   */
  spanParent?: Span;
  /** Extra attributes stamped on this agent's turn spans, e.g. to mark and label a subagent. */
  spanAttributes?: Record<string, AttrValue>;
  /** The span for the in-flight turn, so tool spans can nest under it, and so a caller (e.g. a subagent spawner) can pass it down as another agent's `spanParent`. */
  get turnSpan(): Span | undefined {
    return this.currentTurnSpan;
  }
  private currentTurnSpan?: Span;
  private steerQueue: string[] = [];
  /** Named points in the conversation for /rewind (in-memory, this session only). */
  private checkpoints = new Map<string, Checkpoint>();
  /** Owns permission gating and execution for a turn's tool calls; see toolExecutor.ts. */
  private toolExecutor: ToolExecutor;

  constructor(
    private client: ProviderClient,
    private getModel: () => string,
    private tools: ToolDef[],
    // Not private: read directly by ToolExecutor (see toolExecutor.ts), which
    // is constructed with `this` as its host.
    readonly ctx: ToolContext,
    readonly permissions: PermissionManager,
    private session: SessionStore,
    initialHistory: ChatMessage[] = []
  ) {
    this.history = initialHistory;
    this.toolExecutor = new ToolExecutor(this.tools, this);
  }

  /**
   * Add tools to the live tool set. Used when an MCP server comes up after
   * startup (e.g. `/mcp login` finished, or `/mcp add`), so a new server is
   * usable in the current conversation instead of after a restart. Names are
   * deduplicated: reconnecting a server must replace its tools, not shadow
   * them with a second set pointing at a dead connection.
   */
  addTools(defs: ToolDef[]): void {
    for (const def of defs) {
      const idx = this.tools.findIndex((t) => t.name === def.name);
      if (idx >= 0) this.tools[idx] = def;
      else this.tools.push(def);
    }
  }

  /** Drop tools by name (a server was removed or logged out of). */
  removeTools(predicate: (name: string) => boolean): number {
    let removed = 0;
    for (let i = this.tools.length - 1; i >= 0; i--) {
      if (predicate(this.tools[i].name)) {
        this.tools.splice(i, 1);
        removed++;
      }
    }
    return removed;
  }

  reset(): void {
    this.history = [];
    this.checkpoints.clear();
    this.session.rotate();
  }

  /** Save (or overwrite) a named checkpoint at the current point in the
   *  conversation, paired with the undo turn so /rewind can restore both
   *  the transcript and the files together. */
  saveCheckpoint(name: string, undoTurn: number): void {
    this.checkpoints.set(name, {
      name,
      historyLength: this.history.length,
      undoTurn,
      createdAt: Date.now(),
    });
  }

  getCheckpoint(name: string): Checkpoint | undefined {
    return this.checkpoints.get(name);
  }

  /** Saved checkpoints, oldest first. */
  listCheckpoints(): Checkpoint[] {
    return [...this.checkpoints.values()].sort((a, b) => a.createdAt - b.createdAt);
  }

  /**
   * Drop every message after the first `length` and rewrite the session file
   * to match. repairDanglingToolCalls patches any tool call the cut left
   * without its result, so the trimmed history is still a valid request.
   * Clamped to the current length: a checkpoint taken before a /compact can
   * only ever be a no-op here, never grow history back.
   */
  truncateHistory(length: number): void {
    if (length >= this.history.length) return;
    this.history = this.history.slice(0, length);
    this.repairDanglingToolCalls(false);
    this.session.overwrite(this.history);
  }

  /**
   * Swap the underlying provider client mid-session — e.g. after the active
   * provider exhausts its retries (see RetryExhaustedError in
   * provider/client.ts) and the user picks a fallback via /provider. History
   * lives on `this.history`/`this.session`, not the client, so nothing about
   * the conversation is lost.
   */
  setClient(client: ProviderClient): void {
    this.client = client;
  }

  /** Record a user-side event (e.g. /undo, /web-search results) in the conversation. */
  addUserNote(text: string): void {
    const msg: ChatMessage = { role: "user", content: text };
    this.history.push(msg);
    this.session.append(msg);
  }

  /** Replace history with a resumed session's messages. */
  loadHistory(messages: ChatMessage[]): void {
    this.history = messages;
    this.repairDanglingToolCalls(false);
    this.session.start(this.history);
  }

  /**
   * Insert stub results for tool calls that never got one (a cancelled or
   * crashed turn, or a truncated session file). OpenAI-compatible APIs reject
   * a history where an assistant message's tool_calls lack matching tool
   * messages, so an unrepaired history would break every subsequent request.
   */
  private repairDanglingToolCalls(appendToSession: boolean): void {
    for (let i = 0; i < this.history.length; i++) {
      const msg = this.history[i];
      if (msg.role !== "assistant" || !("tool_calls" in msg) || !msg.tool_calls?.length) continue;
      const answered = new Set<string>();
      let j = i + 1;
      while (j < this.history.length && this.history[j].role === "tool") {
        answered.add((this.history[j] as { tool_call_id: string }).tool_call_id);
        j++;
      }
      for (const call of msg.tool_calls) {
        if (answered.has(call.id)) continue;
        const stub: ChatMessage = {
          role: "tool",
          tool_call_id: call.id,
          content: "[interrupted — this tool call was cancelled before producing a result]",
        };
        this.history.splice(j, 0, stub);
        if (appendToSession) this.session.append(stub);
        j++;
      }
      i = j - 1;
    }
  }

  /** Queue a user correction typed while the agent is working; it is absorbed before the next model call. */
  queueSteer(text: string): void {
    this.steerQueue.push(text);
  }

  /** Fraction of the context window used by the last model call (0..1). */
  contextUsage(): number {
    return Math.min(1, this.lastPromptTokens / this.contextWindow);
  }

  private drainSteerQueue(): void {
    while (this.steerQueue.length) {
      const msg: ChatMessage = {
        role: "user",
        content: `[Mid-task instruction from the user — adjust course accordingly]\n${this.steerQueue.shift()!}`,
      };
      this.history.push(msg);
      this.session.append(msg);
    }
  }

  /**
   * Summarize older history into one message, keeping the recent tail. This
   * discards the original messages permanently (only the summary survives),
   * so it's recorded as a lifecycle event — both a span and an audit record —
   * distinct from the `llm.chat` span for the summarization call itself.
   */
  async compact(signal?: AbortSignal): Promise<string> {
    // Compaction calls the model directly rather than going through runTurn,
    // so it needs its own gate.
    this.kill.assertLive();
    const compactSpan = this.tracer.startSpan("agent.compact", { parent: this.currentTurnSpan });
    const tokensBefore = this.lastPromptTokens;
    try {
      const note = await this.doCompact(signal, compactSpan);
      compactSpan.setStatus("OK");
      return note;
    } catch (err) {
      compactSpan.setStatus("ERROR", err instanceof Error ? err.message : String(err));
      throw err;
    } finally {
      compactSpan.setAttribute("kritya.prompt_tokens_before", tokensBefore);
      compactSpan.setAttribute("kritya.prompt_tokens_after", this.lastPromptTokens);
      compactSpan.end();
    }
  }

  private async doCompact(signal: AbortSignal | undefined, compactSpan: Span): Promise<string> {
    const { toSummarize, keep } = splitForCompaction(this.history);
    if (!toSummarize.length) {
      compactSpan.setAttribute("kritya.skipped", true);
      return "Nothing to compact yet.";
    }
    // Compaction is a recovery action, and it is reached almost exclusively
    // when things are already going badly — a nearly-full context, often a
    // provider that is rate-limiting or timing out. Letting the summarization
    // call's failure propagate would abort the turn at exactly the point the
    // user most needs it to survive, so a failure degrades to a mechanical
    // record of the dropped messages instead. Cancellation is not a failure of
    // this kind and still propagates: the user asked to stop.
    let summarized: string;
    let degraded = false;
    try {
      const result = await this.client.chat(
        this.getModel(),
        [
          {
            role: "system",
            content:
              "You summarize coding-session transcripts. Produce a dense briefing: the user's goals, " +
              "key decisions, files created/modified (with paths), commands run and their outcomes, " +
              "current state, and open items. Plain text, no preamble.",
          },
          { role: "user", content: renderTranscript(toSummarize) },
        ],
        [],
        { onTextDelta: () => {}, onReasoningDelta: () => {} },
        signal,
        { tracer: this.tracer, parent: compactSpan }
      );
      summarized = result.text.trim() || "(summary unavailable)";
    } catch (err) {
      if (
        signal?.aborted ||
        (err as Error)?.name === "AbortError" ||
        err instanceof KillSwitchError
      )
        throw err;
      this.kill.assertLive();
      degraded = true;
      summarized = fallbackSummary(toSummarize);
      compactSpan.addEvent("compact.degraded", {
        "kritya.reason": err instanceof Error ? err.message : String(err),
      });
    }

    const summary = summarized;
    this.history = [
      {
        role: "user",
        content: degraded ? summary : `[Conversation summary of earlier work]\n${summary}`,
      },
      ...keep,
    ];
    this.session.rotate();
    this.session.start(this.history);
    // Rough size estimate until the next model call reports real usage.
    this.lastPromptTokens = estimateHistoryTokens(this.history);
    const note = degraded
      ? `Compacted context WITHOUT a summary (the summarization request failed): dropped ` +
        `${toSummarize.length} messages, kept the last ${keep.length}. Earlier detail is lost — ` +
        `re-read anything the next step depends on.`
      : `Compacted context: summarized ${toSummarize.length} messages, kept the last ${keep.length}.`;
    compactSpan.setAttribute("kritya.messages_summarized", toSummarize.length);
    compactSpan.setAttribute("kritya.messages_kept", keep.length);
    compactSpan.setAttribute("kritya.degraded", degraded);
    this.audit?.logTool({
      tool: "compact",
      summary: degraded
        ? `dropped ${toSummarize.length} message(s) without a summary, kept ${keep.length}`
        : `summarized ${toSummarize.length} message(s), kept ${keep.length}`,
      outcome: degraded ? "error" : "ok",
    });

    // No point asking the model for memory facts when it just failed to
    // summarize, and no honest source to distill them from either.
    if (!this.autoMemory || degraded) return note;
    // Best-effort: memory distillation is a nice-to-have, never let it fail
    // (or block on) the compaction it's piggybacking on.
    try {
      const existing = readProjectMemory(this.ctx.workspace);
      const facts = await extractMemoryFacts(
        this.client,
        this.getModel(),
        toSummarize,
        renderTranscript(toSummarize),
        existing,
        signal
      );
      const added = mergeProjectMemory(this.ctx.workspace, facts);
      if (added.length) {
        return `${note}\nUpdated KRITYA.md with ${added.length} new project fact(s):\n${added.map((f) => `  - ${f}`).join("\n")}`;
      }
    } catch {
      // memory distillation is best-effort; compaction itself still succeeded
    }
    return note;
  }

  async runTurn(
    userText: string,
    handlers: AgentHandlers,
    signal?: AbortSignal,
    images: string[] = []
  ): Promise<void> {
    // Refuse before touching history: a killed session shouldn't accumulate
    // turns it never ran.
    this.kill.assertLive();
    this.ctx.undo?.beginTurn?.();
    // A previous turn may have been cancelled mid-tool-call; repair before the
    // next API request or the provider will reject the whole history. Stubs
    // land at the tail here, so appending them to the session keeps its order.
    this.repairDanglingToolCalls(true);
    const userMsg: ChatMessage = images.length
      ? {
          role: "user",
          content: [
            { type: "text", text: userText },
            ...images.map((url) => ({ type: "image_url" as const, image_url: { url } })),
          ],
        }
      : { role: "user", content: userText };
    this.history.push(userMsg);
    this.session.append(userMsg);

    const systemMsg: ChatMessage = {
      role: "system",
      content: buildSystemPrompt(
        this.ctx.workspace,
        this.planMode,
        this.dryRunMode,
        this.ctx.trustWorkspace !== false
      ),
    };

    const turnSpan = this.tracer.startSpan("agent.turn", {
      parent: this.spanParent,
      attributes: {
        "kritya.model": this.getModel(),
        "kritya.session_id": this.session.id,
        ...this.spanAttributes,
      },
    });
    const turnStartedAtMs = Date.now();
    this.currentTurnSpan = turnSpan;
    this.lastTraceId = turnSpan.traceId || undefined;
    // Everything below runs against a signal that fires on the caller's cancel
    // *or* the kill switch, so engaging it tears down the in-flight model
    // stream and any running tool immediately, not at the next checkpoint.
    const link = linkAbort(this.kill, signal);
    try {
      await this.runLoop(systemMsg, handlers, link.signal);
      turnSpan.setStatus("OK");
    } catch (err) {
      turnSpan.setStatus("ERROR", err instanceof Error ? err.message : String(err));
      // An abort raised by the kill switch reports itself as one, so callers
      // don't file it under "user pressed Esc".
      if (this.kill.active && !(err instanceof KillSwitchError)) {
        throw new KillSwitchError(this.kill.reason);
      }
      throw err;
    } finally {
      link.dispose();
      this.currentTurnSpan = undefined;
      turnSpan.end();
      this.meter.histogram("kritya.turn.duration_ms").record(Date.now() - turnStartedAtMs);
      await this.hooks?.runStop(turnSpan);
    }
  }

  private async runLoop(
    systemMsg: ChatMessage,
    handlers: AgentHandlers,
    signal?: AbortSignal
  ): Promise<void> {
    for (let i = 0; i < this.maxSteps; i++) {
      // Checked ahead of the generic abort so a kill mid-turn is reported as
      // a kill rather than an ordinary cancellation.
      this.kill.assertLive();
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      this.drainSteerQueue();

      // Pre-flight. Auto-compaction below only fires on a *reported* prompt
      // size, which is always one request behind: a single large tool result
      // can push the next request past the window, and a context overflow is a
      // hard 400 that no retry recovers. Estimating what we're about to send
      // catches that before it's sent.
      await this.compactIfPredictedOverflow(systemMsg, handlers, signal);

      const send = () =>
        this.client.chat(
          this.getModel(),
          [systemMsg, ...this.history],
          this.tools,
          {
            onTextDelta: handlers.onTextDelta,
            onReasoningDelta: handlers.onReasoningDelta,
            onRetry: handlers.onRetry,
          },
          signal,
          { tracer: this.tracer, parent: this.currentTurnSpan }
        );

      let result: Awaited<ReturnType<typeof send>>;
      try {
        result = await send();
      } catch (err) {
        // The one 400 with a remedy: the prompt doesn't fit. Compact and send
        // the (now shorter) history once more rather than failing the turn.
        // Only ever once per step — if it still doesn't fit, something is
        // wrong that compaction can't fix and the error should surface.
        if (!isContextOverflowError(err) || !this.canCompact()) throw err;
        this.currentTurnSpan?.addEvent("context.overflow_recovery");
        const note = await this.compact(signal);
        handlers.onToolEnd(
          "compact",
          "compact",
          "Context overflow — compacted and retrying",
          note,
          false
        );
        result = await send();
      }

      if (result.usage) {
        this.lastPromptTokens = result.usage.promptTokens;
        handlers.onUsage({ ...result.usage, servedModel: result.model });
      } else {
        // Some providers omit usage on streamed responses. Estimate from text
        // length so the context meter and auto-compaction don't stall at 0,
        // and still report it (marked `estimated`) so cost/budget tracking
        // isn't silently blind for the whole session — but the caller can
        // tell an estimate from a real number and show it as approximate.
        this.lastPromptTokens = estimateHistoryTokens([systemMsg, ...this.history]);
        handlers.onUsage({
          promptTokens: this.lastPromptTokens,
          completionTokens: estimateTokens(result.text),
          estimated: true,
          servedModel: result.model,
        });
      }
      this.history.push(result.message);
      this.session.append(result.message);
      if (result.text.trim()) handlers.onAssistantText(result.text);

      if (!result.toolCalls.length) return;

      const outputs = await this.toolExecutor.executeToolCalls(result.toolCalls, handlers, signal);
      for (let k = 0; k < result.toolCalls.length; k++) {
        const toolMsg: ChatMessage = {
          role: "tool",
          tool_call_id: result.toolCalls[k].id,
          content: outputs[k],
        };
        this.history.push(toolMsg);
        this.session.append(toolMsg);
      }

      if (this.contextUsage() > COMPACT_THRESHOLD && this.canCompact()) {
        await this.tryCompact("Auto-compacted context", handlers, signal);
      }
    }

    handlers.onAssistantText(
      `[Stopped after ${this.maxSteps} steps — the safety limit for one request. ` +
        `Send "continue" to keep going, or raise "maxSteps" in ~/.kritya/config.json.]`
    );
  }

  /** Whether there is enough history for compaction to actually shrink anything. */
  private canCompact(): boolean {
    return this.history.length > MIN_HISTORY_TO_COMPACT;
  }

  /**
   * Compact, treating a failure as recoverable. doCompact already degrades to
   * a summary-free record rather than throwing, so reaching the catch here
   * means something more unusual went wrong — and even then, continuing with
   * an over-full context (which may still fit, or may be caught by the
   * overflow recovery on the next call) beats destroying the turn over a
   * housekeeping step. Cancellation still propagates.
   */
  private async tryCompact(
    label: string,
    handlers: AgentHandlers,
    signal?: AbortSignal
  ): Promise<void> {
    try {
      const note = await this.compact(signal);
      handlers.onToolEnd("compact", "compact", label, note, false);
    } catch (err) {
      if (
        signal?.aborted ||
        (err as Error)?.name === "AbortError" ||
        err instanceof KillSwitchError
      )
        throw err;
      this.kill.assertLive();
      const msg = err instanceof Error ? err.message : String(err);
      this.currentTurnSpan?.addEvent("compact.failed", { "kritya.reason": msg });
      handlers.onToolEnd("compact", "compact", label, `Compaction failed: ${msg}`, true);
    }
  }

  /**
   * Compact ahead of a request whose estimated size already exceeds the
   * threshold. The estimate covers the history and system prompt but not the
   * tool schemas, which are a fixed cost the threshold's headroom absorbs.
   */
  private async compactIfPredictedOverflow(
    systemMsg: ChatMessage,
    handlers: AgentHandlers,
    signal?: AbortSignal
  ): Promise<void> {
    if (!this.canCompact()) return;
    const predicted = estimateHistoryTokens([systemMsg, ...this.history]);
    if (predicted <= this.contextWindow * COMPACT_THRESHOLD) return;
    this.currentTurnSpan?.addEvent("context.preflight_compact", {
      "kritya.predicted_prompt_tokens": predicted,
      "kritya.context_window": this.contextWindow,
    });
    await this.tryCompact(
      "Compacted context before sending (predicted overflow)",
      handlers,
      signal
    );
  }
}
