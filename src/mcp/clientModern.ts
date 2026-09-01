import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Transport, JsonRpcMessage } from "./transport.js";
import { modernMeta } from "./eraDetect.js";
import type {
  McpToolSpec,
  McpPromptSpec,
  McpResourceSpec,
  McpConnectionOptions,
  SamplingRequest,
} from "./client.js";
import { toElicitationFields } from "./client.js";
import type { ElicitationResult } from "../types.js";

interface Pending {
  resolve(value: unknown): void;
  reject(err: Error): void;
  timer: NodeJS.Timeout;
}

/**
 * Split the same way legacy McpConnection splits its timeouts: connect-time
 * calls (the three list calls during initialize()) get a short ceiling since
 * a hung server there should fail fast, while tools/call — which can
 * legitimately run long — gets the generous one.
 */
const CONNECT_TIMEOUT_MS = 15_000;
const CALL_TIMEOUT_MS = 120_000;

/** MRTR round-trip ceiling — a misbehaving server can't loop us forever. */
const MAX_MRTR_ROUNDS = 10;

interface McpContentBlock {
  type: string;
  text?: string;
}

/** A full JSON-RPC request object, as carried inside `inputRequests` (MRTR). */
interface McpInputRequest {
  method: string;
  params?: Record<string, unknown>;
}

/** A modern response that needs sampling/elicitation/roots before it can complete. */
interface McpInputRequiredResult {
  resultType: "input_required";
  inputRequests: Record<string, McpInputRequest>;
}

/**
 * The minimal surface `connectServer()` needs from either transport era, so
 * it can hold `McpConnection | ModernMcpConnection` through one interface
 * instead of a bare union everywhere. See the design spec's Architecture
 * section (docs/superpowers/specs/2026-08-30-mcp-modern-protocol-design.md).
 */
export interface McpServerConnection {
  readonly name: string;
  initialize(): Promise<{
    tools: McpToolSpec[];
    prompts: McpPromptSpec[];
    resources: McpResourceSpec[];
  }>;
  getPrompt(name: string, args: Record<string, string>): Promise<string>;
  readResource(uri: string): Promise<string>;
  callTool(
    toolName: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
    tasksEnabled?: boolean,
    onProgress?: (text: string) => void
  ): Promise<string>;
  close(): void;
}

/**
 * Modern (2026-07-28+) MCP client: no `initialize`, every request carries
 * its own `_meta`. Implements the same minimal surface as the legacy
 * `McpConnection` (see docs/superpowers/specs/2026-08-30-mcp-modern-protocol-design.md)
 * so `connectServer()` can use either interchangeably.
 *
 * MRTR (sampling/elicitation/roots): a modern server never sends its own
 * JSON-RPC request for these — instead a response comes back with
 * `resultType: "input_required"` and an `inputRequests` map. `requestWithMRTR`
 * answers each entry (via `answerInputRequired`, modeled on legacy's
 * `onServerRequest`/`McpConnection.answerInputRequired`) and resends the
 * original request with `inputResponses` attached, repeating until the
 * server returns `resultType: "complete"` (or errors) — bounded by
 * `MAX_MRTR_ROUNDS` so a misbehaving server can't loop forever.
 */
export class ModernMcpConnection implements McpServerConnection {
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private closed = false;

  constructor(
    public readonly name: string,
    private transport: Transport,
    /** The workspace this session is working on — what `roots/list` reports. */
    private workspace: string = process.cwd(),
    private options: McpConnectionOptions = {}
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

  /** The capabilities this connection can actually back, for `_meta.clientCapabilities` —
   *  only claim what a callback is actually configured to answer, plus roots (always local). */
  private clientCapabilities(): Record<string, unknown> {
    const caps: Record<string, unknown> = { roots: {} };
    if (this.options.onSampling) caps.sampling = {};
    if (this.options.onElicitation) caps.elicitation = {};
    return caps;
  }

  private request(
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error(`MCP server "${this.name}" is not running`));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request "${method}" timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.transport
        .send(
          {
            jsonrpc: "2.0",
            id,
            method,
            params: { ...params, _meta: modernMeta(this.clientCapabilities()) },
          },
          timeoutMs,
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

  /**
   * Send `method`/`params`, answering any `input_required` rounds (MRTR) and
   * resending with `inputResponses` until the server completes or errors.
   */
  private async requestWithMRTR<T>(
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<T> {
    let currentParams = params;
    for (let round = 0; round < MAX_MRTR_ROUNDS; round++) {
      const result = await this.request(method, currentParams, timeoutMs, signal);
      const r = result as { resultType?: string };
      if (r.resultType === undefined || r.resultType === "complete") {
        return result as T;
      }
      if (r.resultType === "input_required") {
        const inputRequired = result as McpInputRequiredResult;
        const inputResponses = await this.answerInputRequired(inputRequired.inputRequests ?? {});
        currentParams = { ...params, inputResponses };
        continue;
      }
      throw new Error(
        `MCP server "${this.name}" returned an unrecognized resultType "${r.resultType}"`
      );
    }
    throw new Error(
      `MCP server "${this.name}" requested input more than ${MAX_MRTR_ROUNDS} times in a row for ` +
        `"${method}" — giving up`
    );
  }

  /**
   * Answer every `inputRequests` entry (sampling/elicitation/roots), same
   * capability dispatch and field/result shapes as legacy's
   * `McpConnection.onServerRequest` — but building an `inputResponses` map
   * to send back in the retry rather than replying to a server-sent request.
   */
  private async answerInputRequired(
    inputRequests: Record<string, McpInputRequest>
  ): Promise<Record<string, unknown>> {
    const inputResponses: Record<string, unknown> = {};
    for (const [key, req] of Object.entries(inputRequests)) {
      if (req.method === "roots/list") {
        inputResponses[key] = {
          roots: [{ uri: pathToFileURL(this.workspace).href, name: path.basename(this.workspace) }],
        };
        continue;
      }

      if (req.method === "sampling/createMessage") {
        if (!this.options.onSampling) {
          throw new Error(
            `MCP server "${this.name}" requires sampling, but sampling is not supported here`
          );
        }
        const p = req.params as {
          messages?: { role: string; content: { type: string; text: string } }[];
          systemPrompt?: string;
          maxTokens?: number;
        };
        const samplingReq: SamplingRequest = {
          server: this.name,
          messages: (p?.messages ?? []).map((m) => ({
            role: m.role === "assistant" ? "assistant" : "user",
            content: m.content?.text ?? "",
          })),
          systemPrompt: p?.systemPrompt,
          maxTokens: p?.maxTokens,
        };
        const result = await this.options.onSampling(this.name, samplingReq);
        if (!result.ok) {
          inputResponses[key] = { error: { code: -32603, message: result.reason } };
          continue;
        }
        inputResponses[key] = {
          role: "assistant",
          content: { type: "text", text: result.content },
          model: result.model,
          stopReason: result.stopReason,
        };
        continue;
      }

      if (req.method === "elicitation/create") {
        if (!this.options.onElicitation) {
          throw new Error(
            `MCP server "${this.name}" requires elicitation, but elicitation is not supported here`
          );
        }
        const p = req.params as {
          message?: string;
          requestedSchema?: {
            properties?: Record<string, { type?: string; title?: string; enum?: string[] }>;
          };
        };
        let fields;
        try {
          fields = toElicitationFields(p?.requestedSchema ?? {});
        } catch (err) {
          throw new Error(
            `MCP server "${this.name}" sent an unsupported elicitation schema: ` +
              (err instanceof Error ? err.message : String(err)),
            { cause: err }
          );
        }
        const result: ElicitationResult = await this.options.onElicitation(
          this.name,
          p?.message ?? "",
          fields
        );
        inputResponses[key] = result;
        continue;
      }

      throw new Error(
        `MCP server "${this.name}" requires unsupported input method "${req.method}"`
      );
    }
    return inputResponses;
  }

  async initialize(): Promise<{
    tools: McpToolSpec[];
    prompts: McpPromptSpec[];
    resources: McpResourceSpec[];
  }> {
    const listed = await this.requestWithMRTR<{ tools?: McpToolSpec[] }>(
      "tools/list",
      {},
      CONNECT_TIMEOUT_MS
    );
    let prompts: McpPromptSpec[] = [];
    let resources: McpResourceSpec[] = [];
    try {
      const p = await this.requestWithMRTR<{ prompts?: McpPromptSpec[] }>(
        "prompts/list",
        {},
        CONNECT_TIMEOUT_MS
      );
      prompts = p.prompts ?? [];
    } catch {
      // prompts unsupported by this server — non-fatal, same as legacy behavior
    }
    try {
      const r = await this.requestWithMRTR<{ resources?: McpResourceSpec[] }>(
        "resources/list",
        {},
        CONNECT_TIMEOUT_MS
      );
      resources = r.resources ?? [];
    } catch {
      // resources unsupported — non-fatal
    }
    return { tools: listed.tools ?? [], prompts, resources };
  }

  async getPrompt(name: string, args: Record<string, string>): Promise<string> {
    const result = await this.requestWithMRTR<{
      messages?: { role?: string; content?: McpContentBlock }[];
    }>("prompts/get", { name, arguments: args }, CALL_TIMEOUT_MS);
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
    const result = await this.requestWithMRTR<{ contents?: { text?: string }[] }>(
      "resources/read",
      { uri },
      CALL_TIMEOUT_MS
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
    const result = await this.requestWithMRTR<{ content?: McpContentBlock[]; isError?: boolean }>(
      "tools/call",
      { name: toolName, arguments: args },
      CALL_TIMEOUT_MS,
      signal
    );
    const text = (result.content ?? [])
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join("\n");
    if (result.isError) throw new Error(text || "MCP tool reported an error");
    return text || "(no output)";
  }

  close(): void {
    this.fail(new Error(`MCP server "${this.name}" connection closed`));
    this.transport.close();
  }
}
