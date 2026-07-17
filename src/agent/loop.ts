import type { NvidiaClient } from "../provider/client.js";
import type { PermissionManager } from "../permissions/permissions.js";
import type { SessionStore } from "../session/store.js";
import type { AgentHandlers, ChatMessage, ToolContext, ToolDef } from "../types.js";
import { splitForCompaction, renderTranscript } from "./compactor.js";
import { buildSystemPrompt } from "./systemPrompt.js";

const MAX_ITERATIONS = 40;
const PREVIEW_CHARS = 200;
const COMPACT_THRESHOLD = 0.8;

export class Agent {
  history: ChatMessage[];
  /** Prompt size of the most recent model call, from the API's usage report. */
  lastPromptTokens = 0;
  /** Model context window in tokens; configurable via config.contextWindow. */
  contextWindow = 120_000;
  private steerQueue: string[] = [];

  constructor(
    private client: NvidiaClient,
    private getModel: () => string,
    private tools: ToolDef[],
    private ctx: ToolContext,
    private permissions: PermissionManager,
    private session: SessionStore,
    initialHistory: ChatMessage[] = []
  ) {
    this.history = initialHistory;
  }

  reset(): void {
    this.history = [];
    this.session.rotate();
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
    this.session.start(messages);
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

  /** Summarize older history into one message, keeping the recent tail. */
  async compact(signal?: AbortSignal): Promise<string> {
    const { toSummarize, keep } = splitForCompaction(this.history);
    if (!toSummarize.length) return "Nothing to compact yet.";
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
      signal
    );
    const summary = result.text.trim() || "(summary unavailable)";
    this.history = [
      { role: "user", content: `[Conversation summary of earlier work]\n${summary}` },
      ...keep,
    ];
    this.session.rotate();
    this.session.start(this.history);
    // Rough size estimate until the next model call reports real usage.
    this.lastPromptTokens = Math.round(JSON.stringify(this.history).length / 4);
    return `Compacted context: summarized ${toSummarize.length} messages, kept the last ${keep.length}.`;
  }

  async runTurn(userText: string, handlers: AgentHandlers, signal?: AbortSignal): Promise<void> {
    this.ctx.undo?.beginTurn?.();
    const userMsg: ChatMessage = { role: "user", content: userText };
    this.history.push(userMsg);
    this.session.append(userMsg);

    const systemMsg: ChatMessage = {
      role: "system",
      content: buildSystemPrompt(this.ctx.workspace),
    };

    for (let i = 0; i < MAX_ITERATIONS; i++) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      this.drainSteerQueue();

      const result = await this.client.chat(
        this.getModel(),
        [systemMsg, ...this.history],
        this.tools,
        {
          onTextDelta: handlers.onTextDelta,
          onReasoningDelta: handlers.onReasoningDelta,
        },
        signal
      );

      if (result.usage) {
        this.lastPromptTokens = result.usage.promptTokens;
        handlers.onUsage(result.usage);
      }
      this.history.push(result.message);
      this.session.append(result.message);
      if (result.text.trim()) handlers.onAssistantText(result.text);

      if (!result.toolCalls.length) return;

      for (const call of result.toolCalls) {
        const output = await this.executeToolCall(call.name, call.argsJson, handlers, signal);
        const toolMsg: ChatMessage = {
          role: "tool",
          tool_call_id: call.id,
          content: output,
        };
        this.history.push(toolMsg);
        this.session.append(toolMsg);
      }

      if (this.contextUsage() > COMPACT_THRESHOLD && this.history.length > 12) {
        const note = await this.compact(signal);
        handlers.onToolEnd("compact", "Auto-compacted context", note, false);
      }
    }

    handlers.onAssistantText(
      `[stopped: reached the ${MAX_ITERATIONS}-step limit for a single request]`
    );
  }

  private async executeToolCall(
    name: string,
    argsJson: string,
    handlers: AgentHandlers,
    signal?: AbortSignal
  ): Promise<string> {
    const tool = this.tools.find((t) => t.name === name);
    if (!tool) return `Error: unknown tool "${name}"`;

    let args: Record<string, unknown>;
    try {
      args = JSON.parse(argsJson) as Record<string, unknown>;
    } catch {
      return `Error: tool arguments were not valid JSON: ${argsJson.slice(0, 500)}`;
    }

    let summary: string;
    try {
      summary = tool.summarize(args);
    } catch {
      summary = name;
    }

    if (this.permissions.needsPrompt(tool, args)) {
      let diff: string | undefined;
      if (tool.preview) {
        try {
          diff = (await tool.preview(args, this.ctx)) ?? undefined;
        } catch {
          diff = undefined;
        }
      }
      const decision = await handlers.requestPermission(tool.name, summary, diff);
      this.permissions.record(tool.name, decision);
      if (decision === "no") {
        handlers.onToolEnd(name, summary, "denied by user", true);
        return "The user denied permission for this tool call. Do not retry it; ask the user how to proceed or take a different approach.";
      }
    }

    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

    handlers.onToolStart(name, summary);
    try {
      const output = await tool.execute(args, this.ctx);
      handlers.onToolEnd(name, summary, output.slice(0, PREVIEW_CHARS), false);
      return output;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      handlers.onToolEnd(name, summary, msg.slice(0, PREVIEW_CHARS), true);
      return `Error: ${msg}`;
    }
  }
}
