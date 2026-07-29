import crypto from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { McpServerConfig, McpToolFilter } from "../config/config.js";
import type { ToolDef } from "../types.js";
import { VERSION } from "../version.js";
import type { AuditLog } from "../audit/audit.js";
import { NOOP_TRACER, type Tracer } from "../telemetry/tracer.js";
import { McpAuthRequiredError } from "./oauth.js";
import { missingVars } from "./servers.js";
import { HttpTransport, StdioTransport, type JsonRpcMessage, type Transport } from "./transport.js";
import { isPrivateOrLoopbackHost } from "../net/urlSafety.js";

/**
 * Model Context Protocol client with two transports and no SDK dependency
 * (to keep the install lean):
 *
 *  - stdio: the server is a child process speaking newline-delimited JSON-RPC
 *    2.0 (config: `command` + `args`).
 *  - Streamable HTTP: the server is a remote endpoint (config: `url` +
 *    `headers`); each JSON-RPC message is POSTed, and the response is either
 *    a plain JSON body or a text/event-stream carrying one or more messages.
 *    The `Mcp-Session-Id` response header is captured on initialize and sent
 *    on every subsequent request, per the spec.
 *
 * Each configured server is launched/connected, initialized, and its tools
 * are wrapped as kritya ToolDefs. Tool output is treated as external
 * (untrusted) content.
 */

export const PROTOCOL_VERSION = "2026-07-28";
const CONNECT_TIMEOUT_MS = 15_000;
const CALL_TIMEOUT_MS = 120_000;

/**
 * Provider function-name ceiling. OpenAI-compatible endpoints reject the whole
 * request — every tool, not just the offending one — when any name exceeds
 * this, which surfaces as an inexplicable model failure rather than an MCP one.
 */
const MAX_TOOL_NAME_LEN = 64;

interface Pending {
  resolve(value: unknown): void;
  reject(err: Error): void;
  timer: NodeJS.Timeout;
  /** Detach the cancellation listener; run on every path that settles the request. */
  cleanup(): void;
}

/**
 * Behavioral hints a server may attach to a tool (spec 2025-06-18). They are
 * hints, not guarantees — the server is the one making the claim — so they can
 * only ever *relax* a requirement the user already accepted by trusting the
 * server, never tighten anything else.
 */
interface McpToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
}

/** A server's `sampling/createMessage` request, translated to kritya's own shape. */
export interface SamplingRequest {
  server: string;
  messages: { role: "user" | "assistant"; content: string }[];
  systemPrompt?: string;
  maxTokens?: number;
}

export type SamplingResult =
  | { ok: true; role: "assistant"; content: string; model: string; stopReason: string }
  | { ok: false; reason: string };

export interface McpConnectionOptions {
  onSampling?(server: string, req: SamplingRequest): Promise<SamplingResult>;
}

export interface McpToolSpec {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: McpToolAnnotations;
}

/** An embedded resource's payload, as carried by `resource` content blocks. */
interface McpResourceContents {
  uri?: string;
  mimeType?: string;
  text?: string;
  blob?: string;
}

interface McpContentBlock {
  type: string;
  text?: string;
  /** image/audio: base64 payload plus its media type. */
  mimeType?: string;
  data?: string;
  /** resource_link: a pointer the client can read separately. */
  uri?: string;
  name?: string;
  description?: string;
  /** resource: the payload inlined by the server. */
  resource?: McpResourceContents;
}

/** What the server said it offers, from the initialize result. */
interface McpServerCapabilities {
  tools?: unknown;
  prompts?: unknown;
  resources?: unknown;
}

interface McpPromptArgSpec {
  name: string;
  description?: string;
  required?: boolean;
}

interface McpPromptSpec {
  name: string;
  description?: string;
  arguments?: McpPromptArgSpec[];
}

interface McpResourceSpec {
  uri: string;
  name?: string;
  description?: string;
  mimeType?: string;
}

interface McpToolResult {
  content?: McpContentBlock[];
  /** Machine-readable result (spec 2025-06-18), when the tool declares an outputSchema. */
  structuredContent?: unknown;
  isError?: boolean;
}

/** Rough size of a base64 payload, for the placeholder that stands in for it. */
function base64Bytes(data: string): number {
  return Math.floor((data.length * 3) / 4);
}

/**
 * Flatten a tool result into the text the model sees.
 *
 * Everything that wasn't a text block used to become the literal string
 * `[image content]`, which threw away three things that carry real payload
 * today: `structuredContent` (the machine-readable result), resources the
 * server inlined into the response, and links to resources it can serve. Text
 * is still the only channel a tool result has, so binary blobs stay
 * placeholders — but they now say what they are and how big, instead of
 * pretending nothing was there.
 */
function renderToolResult(result: McpToolResult): string {
  const parts: string[] = [];
  for (const block of result.content ?? []) {
    switch (block.type) {
      case "text":
        parts.push(block.text ?? "");
        break;
      case "image":
      case "audio": {
        const size = block.data ? `, ~${base64Bytes(block.data)} bytes` : "";
        parts.push(`[${block.type}: ${block.mimeType ?? "unknown type"}${size}]`);
        break;
      }
      case "resource_link":
        parts.push(
          `[resource: ${block.uri ?? "unknown"}${block.name ? ` — ${block.name}` : ""}` +
            `${block.description ? ` (${block.description})` : ""}]`
        );
        break;
      case "resource": {
        // Embedded, so the payload is already here — no second round trip.
        const r = block.resource;
        if (r?.text !== undefined) {
          parts.push(`[resource: ${r.uri ?? "inline"}]\n${r.text}`);
        } else if (r?.blob) {
          parts.push(
            `[resource: ${r.uri ?? "inline"} — ${r.mimeType ?? "binary"}, ` +
              `~${base64Bytes(r.blob)} bytes]`
          );
        }
        break;
      }
      default:
        parts.push(`[${block.type} content]`);
    }
  }

  // Servers that declare an outputSchema SHOULD send the same data as both
  // structuredContent and a serialized text block, so only fall back to it
  // when the content blocks gave us nothing — otherwise every such call would
  // pay for the payload twice.
  const text = parts.filter((p) => p !== "").join("\n");
  if (text) return text;
  if (result.structuredContent !== undefined) return JSON.stringify(result.structuredContent);
  return "";
}

class McpConnection {
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private closed = false;

  constructor(
    public readonly name: string,
    private transport: Transport,
    /** The workspace this session is working on — what `roots/list` reports. */
    private workspace: string,
    private options: McpConnectionOptions = {}
  ) {
    transport.onMessage = (msg) => this.onMessage(msg);
    transport.onError = (err) => this.fail(new Error(`MCP server "${name}": ${err.message}`));
  }

  /** Remove a pending request and release everything attached to it. */
  private take(id: number): Pending | undefined {
    const p = this.pending.get(id);
    if (!p) return undefined;
    this.pending.delete(id);
    clearTimeout(p.timer);
    p.cleanup();
    return p;
  }

  private onMessage(msg: JsonRpcMessage): void {
    if (msg.method) {
      // A request from the server (it has an id) or a notification (it doesn't).
      if (typeof msg.id === "number") this.onServerRequest(msg.id, msg.method, msg.params);
      return;
    }
    if (typeof msg.id !== "number") return;
    const p = this.take(msg.id);
    if (!p) return;
    if (msg.error) p.reject(new Error(msg.error.message ?? "MCP error"));
    else p.resolve(msg.result);
  }

  /**
   * Answer a request the server made of us.
   *
   * Only `roots/list` for now. Without it a filesystem-style server has no way
   * to learn where the user's project is and falls back to whatever its own
   * config guessed; with it, one workspace root is all most servers need. Every
   * other method gets a proper "method not found" rather than silence, so a
   * server can tell the difference between an unsupported client and a hung one.
   */
  private onServerRequest(id: number, method: string, params?: unknown): void {
    const reply = (body: Partial<JsonRpcMessage>) =>
      this.transport.send({ jsonrpc: "2.0", id, ...body }, CONNECT_TIMEOUT_MS).catch(() => {});

    if (method === "roots/list") {
      reply({
        result: {
          roots: [{ uri: pathToFileURL(this.workspace).href, name: path.basename(this.workspace) }],
        },
      });
      return;
    }

    if (method === "sampling/createMessage") {
      if (!this.options.onSampling) {
        reply({
          error: { code: -32601, message: `method "${method}" is not supported by kritya` },
        });
        return;
      }
      const p = params as {
        messages?: { role: string; content: { type: string; text: string } }[];
        systemPrompt?: string;
        maxTokens?: number;
      };
      const req: SamplingRequest = {
        server: this.name,
        messages: (p?.messages ?? []).map((m) => ({
          role: m.role === "assistant" ? "assistant" : "user",
          content: m.content?.text ?? "",
        })),
        systemPrompt: p?.systemPrompt,
        maxTokens: p?.maxTokens,
      };
      this.options
        .onSampling(this.name, req)
        .then((result) => {
          if (!result.ok) {
            reply({ error: { code: -32603, message: result.reason } });
            return;
          }
          reply({
            result: {
              role: "assistant",
              content: { type: "text", text: result.content },
              model: result.model,
              stopReason: result.stopReason,
            },
          });
        })
        .catch((err: Error) => reply({ error: { code: -32603, message: err.message } }));
      return;
    }

    reply({ error: { code: -32601, message: `method "${method}" is not supported by kritya` } });
  }

  private fail(err: Error): void {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.cleanup();
      p.reject(err);
    }
    this.pending.clear();
  }

  request(
    method: string,
    params: unknown,
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error(`MCP server "${this.name}" is not running`));
    if (signal?.aborted) {
      return Promise.reject(new Error(`MCP request "${method}" was cancelled`));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        const p = this.take(id);
        if (!p) return;
        // Tell the server to stop: without this it runs the request to
        // completion on the far side long after the user has moved on. This is
        // what notifications/cancelled is for.
        this.notify("notifications/cancelled", { requestId: id, reason: "cancelled by user" });
        p.reject(new Error(`MCP request "${method}" was cancelled`));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      const timer = setTimeout(() => {
        const p = this.take(id);
        p?.reject(new Error(`MCP request "${method}" timed out`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve,
        reject,
        timer,
        cleanup: () => signal?.removeEventListener("abort", onAbort),
      });
      this.transport
        .send({ jsonrpc: "2.0", id, method, params }, timeoutMs, signal)
        .catch((err: Error) => {
          // Transport-level failure for this request (HTTP error, closed pipe):
          // reject it directly rather than waiting for the timeout.
          const p = this.take(id);
          p?.reject(err);
        });
    });
  }

  notify(method: string, params?: unknown): void {
    this.transport.send({ jsonrpc: "2.0", method, params }, CONNECT_TIMEOUT_MS).catch(() => {});
  }

  async initialize(): Promise<{
    tools: McpToolSpec[];
    prompts: McpPromptSpec[];
    resources: McpResourceSpec[];
  }> {
    const init = (await this.request(
      "initialize",
      {
        protocolVersion: PROTOCOL_VERSION,
        // Declaring roots is what lets a server scope itself to the user's
        // project instead of whatever its own config guessed.
        capabilities: { roots: {}, sampling: {} },
        clientInfo: { name: "kritya", version: VERSION },
      },
      CONNECT_TIMEOUT_MS
    )) as { protocolVersion?: string; capabilities?: McpServerCapabilities };
    if (this.transport instanceof HttpTransport) {
      this.transport.protocolVersion = init.protocolVersion ?? PROTOCOL_VERSION;
    }
    this.notify("notifications/initialized");

    const caps = init.capabilities ?? {};
    // Tools are always asked for, declared or not: servers in the wild are
    // sloppy about announcing capabilities, and a missing `tools` key is far
    // more often an oversight than a server with no tools. Prompts and
    // resources are gated, because there asking costs a round trip (and an
    // error on strict servers) for something most servers genuinely lack.
    const [tools, prompts, resources] = await Promise.all([
      this.listTools(),
      caps.prompts ? this.listPrompts() : Promise.resolve([]),
      caps.resources ? this.listResources() : Promise.resolve([]),
    ]);
    return { tools, prompts, resources };
  }

  private async listTools(): Promise<McpToolSpec[]> {
    const listed = (await this.request("tools/list", {}, CONNECT_TIMEOUT_MS)) as {
      tools?: McpToolSpec[];
    };
    return listed.tools ?? [];
  }

  /** Prompts and resources are extras: a server that fails to list them still connects. */
  private async listPrompts(): Promise<McpPromptSpec[]> {
    try {
      const listed = (await this.request("prompts/list", {}, CONNECT_TIMEOUT_MS)) as {
        prompts?: McpPromptSpec[];
      };
      return listed.prompts ?? [];
    } catch {
      return [];
    }
  }

  private async listResources(): Promise<McpResourceSpec[]> {
    try {
      const listed = (await this.request("resources/list", {}, CONNECT_TIMEOUT_MS)) as {
        resources?: McpResourceSpec[];
      };
      return listed.resources ?? [];
    } catch {
      return [];
    }
  }

  async getPrompt(name: string, args: Record<string, string>): Promise<string> {
    const result = (await this.request(
      "prompts/get",
      { name, arguments: args },
      CALL_TIMEOUT_MS
    )) as { description?: string; messages?: { role?: string; content?: McpContentBlock }[] };
    const messages = result.messages ?? [];
    // A prompt is normally a single user message; when it isn't, keep the roles
    // visible rather than silently flattening a scripted exchange into one voice.
    const multiRole = new Set(messages.map((m) => m.role ?? "user")).size > 1;
    return messages
      .map((m) => {
        const body = m.content ? renderToolResult({ content: [m.content] }) : "";
        return multiRole ? `[${m.role ?? "user"}] ${body}` : body;
      })
      .filter(Boolean)
      .join("\n\n");
  }

  async readResource(uri: string): Promise<string> {
    const result = (await this.request("resources/read", { uri }, CALL_TIMEOUT_MS)) as {
      contents?: McpResourceContents[];
    };
    return (result.contents ?? [])
      .map((c) =>
        c.text !== undefined
          ? c.text
          : `[binary resource: ${c.mimeType ?? "unknown"}, ~${base64Bytes(c.blob ?? "")} bytes]`
      )
      .join("\n");
  }

  async callTool(
    toolName: string,
    args: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<string> {
    const result = (await this.request(
      "tools/call",
      { name: toolName, arguments: args },
      CALL_TIMEOUT_MS,
      signal
    )) as McpToolResult;
    const text = renderToolResult(result);
    if (result.isError) throw new Error(text || "MCP tool reported an error");
    return text || "(no output)";
  }

  close(): void {
    this.closed = true;
    this.transport.close();
  }
}

/**
 * Match a tool name against one `*`-wildcard pattern, e.g. `github_*`.
 * Everything else is literal — these are tool names, not paths.
 */
function matchesPattern(name: string, pattern: string): boolean {
  const rx = pattern
    .split("*")
    .map((literal) => literal.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${rx}$`).test(name);
}

/**
 * Whether a server's tool passes its configured allow/deny lists. Deny wins,
 * so a broad allow can be trimmed without rewriting it; an absent or empty
 * allow means everything.
 */
export function toolAllowed(name: string, filter: McpToolFilter | undefined): boolean {
  if (!filter) return true;
  if (filter.deny?.some((p) => matchesPattern(name, p))) return false;
  if (!filter.allow?.length) return true;
  return filter.allow.some((p) => matchesPattern(name, p));
}

/** Loopback is exempt from the https requirement: there's no network to sniff. */
function isLoopback(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, "");
  return h === "localhost" || h === "127.0.0.1" || h === "::1" || h.endsWith(".localhost");
}

/**
 * Reject a remote server reachable only over plaintext. `/mcp add` already
 * refuses these, but that guards one entrance: a server hand-written into
 * ~/.kritya/config.json or a repo's .mcp.json never passes through it and
 * would happily POST a bearer token in the clear. This is the choke point all
 * three sources share.
 */
export function assertSafeUrl(name: string, url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`server "${name}" has an invalid url: ${url}`);
  }
  // https alone doesn't mean the traffic (incl. any bearer token in headers)
  // stays where the user intends — a config pointing at 169.254.169.254 or
  // another private/internal address would still ship credentials there.
  // Loopback is exempt: that's this app talking to itself, nothing to leak to.
  if (!isLoopback(parsed.hostname) && isPrivateOrLoopbackHost(parsed.hostname)) {
    throw new Error(
      `server "${name}" points at a private/internal address (${parsed.hostname}) — refusing to connect.`
    );
  }
  if (parsed.protocol === "https:") return parsed;
  if (parsed.protocol === "http:" && isLoopback(parsed.hostname)) return parsed;
  if (parsed.protocol !== "http:") {
    throw new Error(`server "${name}" uses unsupported scheme "${parsed.protocol}" — use https://`);
  }
  throw new Error(
    `server "${name}" uses plain http:// (${parsed.host}) — an MCP session carries ` +
      `your credentials in cleartext over it. Use https:// (localhost is exempt).`
  );
}

function makeTransport(name: string, cfg: McpServerConfig, workspace: string): Transport {
  if (cfg.url) {
    if (cfg.command) {
      throw new Error(`server "${name}" sets both "command" and "url"; pick one`);
    }
    assertSafeUrl(name, cfg.url);
    return new HttpTransport(cfg.url, cfg.headers ?? {});
  }
  if (!cfg.command) {
    throw new Error(`server "${name}" needs either "command" (stdio) or "url" (HTTP)`);
  }
  // Relative to the workspace, so a checked-in .mcp.json stays portable.
  const cwd = cfg.cwd ? path.resolve(workspace, cfg.cwd) : workspace;
  return new StdioTransport(cfg.command, cfg.args ?? [], cfg.env, cwd);
}

/**
 * Cross-cutting inputs for connecting servers. `tracer`/`audit` are optional so
 * callers that don't care (tests, ad-hoc loads) can omit them; `workspace` is
 * what a stdio server's relative `cwd` resolves against, defaulting to the
 * process cwd only because a caller that omits it has no better answer.
 */
export interface McpLoadOptions {
  tracer: Tracer;
  audit?: AuditLog;
  workspace?: string;
  onSampling?(server: string, req: SamplingRequest): Promise<SamplingResult>;
}

/** What /mcp reports for one configured server. */
export interface McpServerStatus {
  name: string;
  transport: "stdio" | "http";
  /** The command line or URL, for display. */
  target: string;
  ok: boolean;
  error?: string;
  /** The server is reachable but needs an OAuth login (`/mcp login <name>`). */
  needsAuth?: boolean;
  /** resource_metadata URL from the 401 challenge, so login skips re-discovery. */
  authMetadataUrl?: string;
  tools: string[];
  /** Prompt names the server contributes as slash commands. */
  prompts: string[];
  /** Resource names the server contributes as @-attachments. */
  resources: string[];
  /** How many of the server's tools the config's allow/deny lists held back. */
  hiddenTools?: number;
}

const connections: McpConnection[] = [];
let statuses: McpServerStatus[] = [];
/**
 * Exposed tool name -> the identity that claimed it, so a second tool whose
 * sanitized form lands on the same string doesn't silently shadow the first.
 */
const registeredNames = new Map<string, string>();
/** Server -> the exposed tool names it currently owns, for withdrawal and reuse. */
const serverToolNames = new Map<string, Set<string>>();

/**
 * A server-contributed slash command, backed by `prompts/get`.
 *
 * MCP prompts are user-initiated templates, which is exactly what kritya's
 * slash commands already are — so a Linear server can contribute
 * `/linear-triage` without the user writing a command file for it.
 */
export interface McpPrompt {
  server: string;
  /** The prompt's own name, as the server knows it. */
  name: string;
  /** The slash command it's exposed as, e.g. "/linear-triage". */
  command: string;
  description: string;
  args: McpPromptArgSpec[];
  /** Expand the prompt into the text to send, given whatever the user typed after it. */
  expand(argText: string): Promise<string>;
}

/** A document a server can hand over, attachable with @. */
export interface McpResource {
  server: string;
  uri: string;
  /** The @-mention that refers to it, e.g. "mcp:docs/handbook". */
  mention: string;
  description: string;
  read(): Promise<string>;
}

const prompts: McpPrompt[] = [];
const resources: McpResource[] = [];

/** Slash commands contributed by connected MCP servers. */
export function mcpPrompts(): McpPrompt[] {
  return prompts;
}

/** Attachable documents contributed by connected MCP servers. */
export function mcpResources(): McpResource[] {
  return resources;
}

function forgetContributions(server: string): void {
  for (const list of [prompts, resources] as { server: string }[][]) {
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i].server === server) list.splice(i, 1);
    }
  }
}

function toolIdentity(server: string, toolName: string): string {
  return `${server}\u0000${toolName}`;
}

/** Status of every configured MCP server from the last loadMcpTools call. */
export function mcpStatus(): McpServerStatus[] {
  return statuses;
}

function sanitize(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function shortHash(s: string): string {
  return crypto.createHash("sha256").update(s).digest("hex").slice(0, 8);
}

/**
 * The name a tool is exposed to the model under.
 *
 * Two things can go wrong with the obvious `mcp_<server>_<tool>`. sanitize is
 * lossy — `my.tool` and `my-tool` both become `my_tool`, so one tool shadows
 * the other and calls silently go to the wrong place. And the result can
 * exceed the provider's 64-character function-name limit, which fails the
 * entire request rather than the one tool, looking like a broken model.
 *
 * Both are resolved by folding a hash of the true identity into the name:
 * deterministic across runs (so allow-rules and transcripts stay valid), and
 * distinct wherever the sanitized forms are not.
 */
function exposedToolName(server: string, toolName: string): string {
  const base = `mcp_${sanitize(server)}_${sanitize(toolName)}`;
  const identity = toolIdentity(server, toolName);
  const claimed = registeredNames.get(base);
  const needsHash =
    base.length > MAX_TOOL_NAME_LEN || (claimed !== undefined && claimed !== identity);
  if (!needsHash) return base;
  const suffix = `_${shortHash(identity)}`;
  return base.slice(0, MAX_TOOL_NAME_LEN - suffix.length) + suffix;
}

/**
 * Connect to all configured MCP servers and return their tools as ToolDefs.
 * Resilient: a server that fails to start is skipped with a warning (and shows
 * as failed in /mcp), never crashing kritya. Returns an empty list when
 * nothing is configured.
 *
 * `trace` is optional so callers that don't care (tests, tools that load MCP
 * servers ad hoc) can omit it; when given, each connect attempt gets a span
 * and a failure is also written to the audit log — otherwise a failed server
 * was only ever a single stderr line that nothing else recorded.
 */
export async function loadMcpTools(
  servers: Record<string, McpServerConfig> | undefined,
  trace?: McpLoadOptions
): Promise<ToolDef[]> {
  statuses = [];
  registeredNames.clear();
  serverToolNames.clear();
  prompts.length = 0;
  resources.length = 0;
  if (!servers || Object.keys(servers).length === 0) return [];
  const tools: ToolDef[] = [];

  const results = await Promise.all(
    Object.entries(servers).map(([name, cfg]) => connectServer(name, cfg, trace))
  );
  for (const { tools: t, status } of results) {
    tools.push(...t);
    statuses.push(status);
  }

  return tools;
}

/**
 * Connect one server and wrap its tools. Split out of loadMcpTools so a login
 * can bring a server up mid-session without restarting kritya (and without
 * disturbing the servers that are already connected).
 *
 * A server that needs OAuth is *not* an error: it reports `needsAuth` and no
 * tools, so startup stays quiet and `/mcp` can tell the user what to run. The
 * alternative — opening a browser during `kritya` startup — would hijack the
 * terminal before the user has typed anything.
 */
export async function connectServer(
  name: string,
  cfg: McpServerConfig,
  trace?: McpLoadOptions
): Promise<{ tools: ToolDef[]; status: McpServerStatus }> {
  const tracer = trace?.tracer ?? NOOP_TRACER;
  const workspace = trace?.workspace ?? process.cwd();
  const tools: ToolDef[] = [];
  const status: McpServerStatus = {
    name,
    transport: cfg.url ? "http" : "stdio",
    target: cfg.url ?? [cfg.command, ...(cfg.args ?? [])].filter(Boolean).join(" "),
    ok: false,
    tools: [],
    prompts: [],
    resources: [],
  };
  const span = tracer.startSpan("mcp.connect", {
    attributes: { "kritya.mcp_server": name, "kritya.mcp_transport": status.transport },
  });
  let conn: McpConnection | undefined;
  try {
    // Checked here rather than at expansion time: this is where a per-server
    // failure has somewhere to go (`status.error`, and the /mcp table).
    const missing = missingVars(cfg);
    if (missing.length) {
      throw new Error(`missing env var${missing.length > 1 ? "s" : ""} ${missing.join(", ")}`);
    }
    conn = new McpConnection(name, makeTransport(name, cfg, workspace), workspace, {
      onSampling: trace?.onSampling,
    });
    const listed = await conn.initialize();
    const specs = listed.tools;
    connections.push(conn);
    // Reconnects re-derive names from scratch; releasing the old claims first
    // keeps a server from colliding with its own previous incarnation.
    releaseToolNames(name);
    forgetContributions(name);
    registerPrompts(conn, name, listed.prompts, status);
    registerResources(conn, name, listed.resources, status);
    const owned = new Set<string>();
    const exposed = specs.filter((s) => toolAllowed(s.name, cfg.tools));
    status.hiddenTools = specs.length - exposed.length;
    for (const spec of exposed) {
      const def = mcpToolDef(conn, name, spec, cfg);
      registeredNames.set(def.name, toolIdentity(name, spec.name));
      owned.add(def.name);
      tools.push(def);
      status.tools.push(spec.name);
    }
    serverToolNames.set(name, owned);
    status.ok = true;
    span.setAttribute("kritya.mcp_tool_count", status.tools.length);
    span.setStatus("OK");
  } catch (err) {
    conn?.close();
    if (err instanceof McpAuthRequiredError) {
      status.needsAuth = true;
      status.authMetadataUrl = err.resourceMetadataUrl;
      status.error = `needs login — run /mcp login ${name}`;
      span.setAttribute("kritya.mcp_needs_auth", true);
      span.setStatus("OK");
    } else {
      status.error = err instanceof Error ? err.message : String(err);
      process.stderr.write(`kritya: MCP server "${name}" failed to start: ${status.error}\n`);
      span.setStatus("ERROR", status.error);
      trace?.audit?.logTool({
        tool: "mcp_connect",
        summary: `server "${name}" failed to start: ${status.error}`,
        outcome: "error",
      });
    }
  } finally {
    span.end();
  }
  return { tools, status };
}

/**
 * Expose a server's prompts as slash commands.
 *
 * Named `/<server>-<prompt>` so two servers offering "triage" don't fight over
 * one command, and so it's obvious where a command came from. A server's
 * prompt never displaces a built-in or a user's own command file: those are
 * matched first, and a server that names a prompt "plan" shouldn't be able to
 * quietly redefine /plan.
 */
function registerPrompts(
  conn: McpConnection,
  server: string,
  specs: McpPromptSpec[],
  status: McpServerStatus
): void {
  for (const spec of specs) {
    const command = `/${sanitizeCommand(server)}-${sanitizeCommand(spec.name)}`;
    const args = spec.arguments ?? [];
    prompts.push({
      server,
      name: spec.name,
      command,
      description: `[MCP: ${server}] ${spec.description ?? spec.name}`,
      args,
      expand: (argText) => conn.getPrompt(spec.name, splitPromptArgs(argText, args)),
    });
    status.prompts.push(spec.name);
  }
}

/**
 * Map what the user typed after the command onto the prompt's named arguments.
 *
 * Positional by whitespace, with the last declared argument soaking up the
 * remainder — so a single-argument prompt gets the whole line, which is how
 * every slash command in kritya already behaves.
 */
function splitPromptArgs(argText: string, args: McpPromptArgSpec[]): Record<string, string> {
  const out: Record<string, string> = {};
  if (!args.length) return out;
  const rest = argText.trim();
  if (args.length === 1) {
    if (rest) out[args[0].name] = rest;
    return out;
  }
  const parts = rest.split(/\s+/).filter(Boolean);
  args.forEach((arg, i) => {
    const value = i === args.length - 1 ? parts.slice(i).join(" ") : parts[i];
    if (value) out[arg.name] = value;
  });
  return out;
}

/** Expose a server's resources as `@mcp:<server>/<name>` attachments. */
function registerResources(
  conn: McpConnection,
  server: string,
  specs: McpResourceSpec[],
  status: McpServerStatus
): void {
  for (const spec of specs) {
    const label = spec.name ?? spec.uri;
    resources.push({
      server,
      uri: spec.uri,
      mention: `mcp:${sanitizeCommand(server)}/${sanitizeCommand(label)}`,
      description: spec.description ?? spec.mimeType ?? spec.uri,
      read: () => conn.readResource(spec.uri),
    });
    status.resources.push(label);
  }
}

/** Command/mention-safe form of a name: no spaces, no leading slash confusion. */
function sanitizeCommand(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
}

/** Replace one server's entry in the /mcp status table after a reconnect. */
export function replaceStatus(status: McpServerStatus): void {
  const idx = statuses.findIndex((s) => s.name === status.name);
  if (idx >= 0) statuses[idx] = status;
  else statuses.push(status);
}

/**
 * Whether a tool can run without asking the user first.
 *
 * Marking every MCP tool as permission-requiring costs more than it looks. It
 * prompts on pure lookups (a docs fetch, an issue search), and approval fatigue
 * is exactly what trains people to accept without reading — so the blanket
 * prompt makes the prompts that matter *less* effective. It also silently
 * excluded MCP from subagents, which are only handed tools that don't prompt.
 *
 * We take readOnlyHint at face value, but only that one: it is a claim by a
 * server the user has already trusted (workspace trust + per-server trust) that
 * a tool doesn't change anything. destructiveHint being set overrides it, since
 * a server contradicting itself should get the cautious reading.
 */
function isReadOnly(spec: McpToolSpec): boolean {
  const a = spec.annotations;
  return a?.readOnlyHint === true && a.destructiveHint !== true;
}

export function mcpToolDef(
  conn: McpConnection,
  server: string,
  spec: McpToolSpec,
  cfg: Pick<McpServerConfig, "consent"> = {}
): ToolDef {
  return {
    name: exposedToolName(server, spec.name),
    description: `[MCP: ${server}] ${spec.description ?? spec.name}`,
    parameters: spec.inputSchema ?? { type: "object", properties: {} },
    requiresPermission: cfg.consent === "always-confirm" ? true : !isReadOnly(spec),
    // Self-managed: every request already carries CALL_TIMEOUT_MS, and the
    // connection rejects in-flight calls when the transport dies.
    timeoutMs: 0,
    // Read-only or not, the output came from outside the workspace and is
    // wrapped as untrusted — a lookup tool is a prime injection vector.
    external: true,
    summarize: (args) => `${server}/${spec.name}(${JSON.stringify(args).slice(0, 80)})`,
    execute: (args, _ctx, signal) => conn.callTool(spec.name, args, signal),
  };
}

/** The tool-name prefix every tool from a given server shares. */
export function toolPrefix(server: string): string {
  return `mcp_${sanitize(server)}_`;
}

/**
 * Predicate matching the tools a server currently contributes. Prefer this to
 * a bare prefix test: a name that had to be hash-shortened is a truncation of
 * `mcp_<server>_...` and can lose the prefix outright.
 */
export function isToolOf(server: string): (toolName: string) => boolean {
  const owned = serverToolNames.get(server);
  if (!owned) return (t) => t.startsWith(toolPrefix(server));
  return (t) => owned.has(t);
}

/** Release a server's claimed tool names so they can be reused. */
function releaseToolNames(server: string): void {
  for (const n of serverToolNames.get(server) ?? []) registeredNames.delete(n);
  serverToolNames.delete(server);
}

/**
 * Close one server's connection and forget it. Used by `/mcp remove`,
 * `/mcp logout`, and before a reconnect — leaving the old connection open
 * would keep a stdio child process alive and, after a logout, keep a
 * now-revoked session warm on the remote side.
 */
export function disconnectServer(name: string): void {
  for (let i = connections.length - 1; i >= 0; i--) {
    if (connections[i].name === name) {
      connections[i].close();
      connections.splice(i, 1);
    }
  }
}

/** Drop a server from the /mcp status table entirely. */
export function forgetStatus(name: string): void {
  statuses = statuses.filter((s) => s.name !== name);
  // Callers withdraw the tools first (they need isToolOf while it still
  // resolves), so this is the right point to give the names back.
  releaseToolNames(name);
  forgetContributions(name);
}

/** Kill all MCP servers (call on exit). */
export function shutdownMcp(): void {
  for (const conn of connections) conn.close();
  connections.length = 0;
  registeredNames.clear();
  serverToolNames.clear();
  prompts.length = 0;
  resources.length = 0;
}
