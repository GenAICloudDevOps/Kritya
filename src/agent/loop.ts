import type { NvidiaClient } from "../provider/client.js";
import type { PermissionManager } from "../permissions/permissions.js";
import type { SessionStore } from "../session/store.js";
import type { AgentHandlers, ChatMessage, ToolContext, ToolDef } from "../types.js";
import { buildSystemPrompt } from "./systemPrompt.js";

const MAX_ITERATIONS = 40;
const PREVIEW_CHARS = 200;

export class Agent {
  history: ChatMessage[];

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

  async runTurn(userText: string, handlers: AgentHandlers, signal?: AbortSignal): Promise<void> {
    const userMsg: ChatMessage = { role: "user", content: userText };
    this.history.push(userMsg);
    this.session.append(userMsg);

    const systemMsg: ChatMessage = {
      role: "system",
      content: buildSystemPrompt(this.ctx.workspace),
    };

    for (let i = 0; i < MAX_ITERATIONS; i++) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

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

      if (result.usage) handlers.onUsage(result.usage);
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

    if (this.permissions.needsPrompt(tool)) {
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
