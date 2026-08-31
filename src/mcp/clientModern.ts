import type { Transport, JsonRpcMessage } from "./transport.js";
import { modernMeta } from "./eraDetect.js";
import type { McpToolSpec, McpPromptSpec, McpResourceSpec } from "./client.js";

interface Pending {
  resolve(value: unknown): void;
  reject(err: Error): void;
  timer: NodeJS.Timeout;
}

const REQUEST_TIMEOUT_MS = 120_000;

interface McpContentBlock {
  type: string;
  text?: string;
}

/**
 * Modern (2026-07-28+) MCP client: no `initialize`, every request carries
 * its own `_meta`. Implements the same minimal surface as the legacy
 * `McpConnection` (see docs/superpowers/specs/2026-08-30-mcp-modern-protocol-design.md)
 * so `connectServer()` can use either interchangeably. `resultType:
 * "input_required"` (MRTR — sampling/elicitation/roots) is rejected with a
 * clear error here; Sub-project 2 replaces this with the real retry loop.
 */
export class ModernMcpConnection {
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private closed = false;

  constructor(
    public readonly name: string,
    private transport: Transport
  ) {
    transport.onMessage = (msg) => this.onMessage(msg);
    transport.onError = (err) => this.fail(new Error(`MCP server "${name}": ${err.message}`));
  }

  private fail(err: Error): void {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }

  private onMessage(msg: JsonRpcMessage): void {
    if (typeof msg.id !== "number") return;
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.error) p.reject(new Error(msg.error.message ?? "MCP error"));
    else p.resolve(msg.result);
  }

  private request(
    method: string,
    params: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error(`MCP server "${this.name}" is not running`));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request "${method}" timed out`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      this.transport
        .send(
          { jsonrpc: "2.0", id, method, params: { ...params, _meta: modernMeta() } },
          REQUEST_TIMEOUT_MS,
          signal
        )
        .catch((err: Error) => {
          const p = this.pending.get(id);
          if (!p) return;
          this.pending.delete(id);
          clearTimeout(p.timer);
          p.reject(err);
        });
    });
  }

  /** Unwrap a modern result's resultType, throwing for input_required (MRTR — Sub-project 2). */
  private unwrap<T>(result: unknown): T {
    const r = result as { resultType?: string };
    if (r.resultType === "input_required") {
      throw new Error(
        `MCP server "${this.name}" requires an interactive capability (sampling, elicitation, ` +
          `or roots) that modern-mode kritya does not yet support`
      );
    }
    if (r.resultType !== undefined && r.resultType !== "complete") {
      throw new Error(
        `MCP server "${this.name}" returned an unrecognized resultType "${r.resultType}"`
      );
    }
    return result as T;
  }

  async initialize(): Promise<{
    tools: McpToolSpec[];
    prompts: McpPromptSpec[];
    resources: McpResourceSpec[];
  }> {
    const listed = this.unwrap<{ tools?: McpToolSpec[] }>(await this.request("tools/list", {}));
    let prompts: McpPromptSpec[] = [];
    let resources: McpResourceSpec[] = [];
    try {
      const p = this.unwrap<{ prompts?: McpPromptSpec[] }>(await this.request("prompts/list", {}));
      prompts = p.prompts ?? [];
    } catch {
      // prompts unsupported by this server — non-fatal, same as legacy behavior
    }
    try {
      const r = this.unwrap<{ resources?: McpResourceSpec[] }>(
        await this.request("resources/list", {})
      );
      resources = r.resources ?? [];
    } catch {
      // resources unsupported — non-fatal
    }
    return { tools: listed.tools ?? [], prompts, resources };
  }

  async getPrompt(name: string, args: Record<string, string>): Promise<string> {
    const result = this.unwrap<{ messages?: { role?: string; content?: McpContentBlock }[] }>(
      await this.request("prompts/get", { name, arguments: args })
    );
    const messages = result.messages ?? [];
    const multiRole = new Set(messages.map((m) => m.role ?? "user")).size > 1;
    return messages
      .map((m) => {
        const text = m.content?.text ?? "";
        return multiRole ? `[${m.role ?? "user"}] ${text}` : text;
      })
      .filter(Boolean)
      .join("\n\n");
  }

  async readResource(uri: string): Promise<string> {
    const result = this.unwrap<{ contents?: { text?: string }[] }>(
      await this.request("resources/read", { uri })
    );
    return (result.contents ?? []).map((c) => c.text ?? "").join("\n");
  }

  async callTool(
    toolName: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
    _tasksEnabled?: boolean,
    _onProgress?: (text: string) => void
  ): Promise<string> {
    // Tasks-under-modern is out of scope for this plan (see spec's "Out of
    // scope"); the params exist only so this signature matches
    // McpConnection.callTool's, which callers invoke uniformly through the
    // McpConnection | ModernMcpConnection union built in Task 6.
    const result = this.unwrap<{ content?: McpContentBlock[]; isError?: boolean }>(
      await this.request("tools/call", { name: toolName, arguments: args }, signal)
    );
    const text = (result.content ?? [])
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join("\n");
    if (result.isError) throw new Error(text || "MCP tool reported an error");
    return text || "(no output)";
  }

  close(): void {
    this.closed = true;
    this.transport.close();
  }
}
