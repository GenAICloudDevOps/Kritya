import { spawn, type ChildProcess } from "node:child_process";
import type { McpServerConfig } from "../config/config.js";
import type { ToolDef } from "../types.js";
import { VERSION } from "../version.js";
import type { AuditLog } from "../audit/audit.js";
import { NOOP_TRACER, type Tracer } from "../telemetry/tracer.js";
import { McpAuthRequiredError, OAuthSession, parseWwwAuthenticate } from "./oauth.js";
import { missingVars } from "./servers.js";
import { planSpawn } from "./spawnWin.js";

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

const PROTOCOL_VERSION = "2025-06-18";
const CONNECT_TIMEOUT_MS = 15_000;
const CALL_TIMEOUT_MS = 120_000;

/** How much of a server's stderr to keep for diagnostics, and how much to report. */
const STDERR_KEEP_BYTES = 8_192;
const STDERR_REPORT_LINES = 5;

/** Env vars an MCP server's own OS/runtime needs to start up at all, without inheriting API keys. */
const PASSTHROUGH_ENV_VARS = [
  "PATH",
  "HOME",
  "USERPROFILE",
  "SystemRoot",
  "windir",
  "TEMP",
  "TMP",
  "APPDATA",
  "LOCALAPPDATA",
  "NODE_PATH",
];

function minimalEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of PASSTHROUGH_ENV_VARS) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { message?: string };
}

interface Pending {
  resolve(value: unknown): void;
  reject(err: Error): void;
  timer: NodeJS.Timeout;
  /** Detach the cancellation listener; run on every path that settles the request. */
  cleanup(): void;
}

interface McpToolSpec {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

/**
 * A transport delivers JSON-RPC messages to the server and feeds messages
 * coming back through onMessage. `send` resolves once the message (and, for
 * HTTP, its response body) has been fully handled; connection-level failures
 * surface through onError. `signal` aborts the in-flight delivery when the
 * user cancels.
 */
interface Transport {
  onMessage: (msg: JsonRpcMessage) => void;
  onError: (err: Error) => void;
  send(msg: JsonRpcMessage, timeoutMs: number, signal?: AbortSignal): Promise<void>;
  close(): void;
}

/**
 * A signal that fires on either the per-request timeout or the user's cancel.
 * `AbortSignal.any` only landed in Node 20 and we support 18, hence the manual
 * bridge.
 */
function withTimeout(timeoutMs: number, signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  if (!signal) return timeout;
  const any = (AbortSignal as unknown as { any?(s: AbortSignal[]): AbortSignal }).any;
  if (any) return any.call(AbortSignal, [signal, timeout]);
  const ctrl = new AbortController();
  const abort = () => ctrl.abort();
  if (signal.aborted || timeout.aborted) ctrl.abort();
  else {
    signal.addEventListener("abort", abort, { once: true });
    timeout.addEventListener("abort", abort, { once: true });
  }
  return ctrl.signal;
}

class StdioTransport implements Transport {
  onMessage: (msg: JsonRpcMessage) => void = () => {};
  onError: (err: Error) => void = () => {};
  private proc: ChildProcess;
  private buffer = "";
  /** Tail of the server's stderr, kept for the exit message (see below). */
  private stderrTail = "";

  constructor(command: string, args: string[], env: Record<string, string> | undefined) {
    const plan = planSpawn(command, args);
    this.proc = spawn(plan.command, plan.args, {
      // Minimal env, not the full process env: every provider API key lives
      // in process.env, and an MCP server is third-party code the user opted
      // into but shouldn't automatically receive credentials it never asked
      // for. Servers that need extra vars declare them in their own `env`.
      env: { ...minimalEnv(), ...env },
      stdio: ["pipe", "pipe", "pipe"],
      windowsVerbatimArguments: plan.windowsVerbatimArguments,
    });
    this.proc.stdout?.setEncoding("utf8");
    this.proc.stdout?.on("data", (chunk: string) => this.onData(chunk));
    // Draining stderr is not optional: we asked for a pipe, and a server that
    // logs more than the ~64KB pipe buffer blocks in write() forever if nobody
    // reads it. Keeping the tail also means a server that dies on a bad token
    // can say why, instead of just "exited".
    this.proc.stderr?.setEncoding("utf8");
    this.proc.stderr?.on("data", (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-STDERR_KEEP_BYTES);
    });
    // Report on "close" (all stdio flushed), not "exit", so the stderr that
    // explains the exit has actually arrived. "close" can be held open by a
    // grandchild inheriting the pipes, so "exit" still arms a short fallback —
    // a slightly thinner message beats never reporting at all.
    let reported = false;
    const report = (code: number | null, signal: NodeJS.Signals | null) => {
      if (reported) return;
      reported = true;
      const how = signal ? `killed by ${signal}` : `exited with code ${code ?? 0}`;
      this.onError(new Error(`server process ${how}${this.stderrDetail()}`));
    };
    this.proc.on("close", report);
    this.proc.on("exit", (code, signal) => {
      setTimeout(() => report(code, signal), 200).unref();
    });
    this.proc.on("error", (err) => this.onError(new Error(`${err.message}${this.stderrDetail()}`)));
  }

  /** The last few non-blank stderr lines, formatted for an error message. */
  private stderrDetail(): string {
    const lines = this.stderrTail
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .slice(-STDERR_REPORT_LINES);
    return lines.length ? ` — stderr: ${lines.join(" | ")}` : "";
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let idx: number;
    while ((idx = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      try {
        this.onMessage(JSON.parse(line) as JsonRpcMessage);
      } catch {
        // ignore non-JSON (some servers log to stdout)
      }
    }
  }

  send(msg: JsonRpcMessage): Promise<void> {
    this.proc.stdin?.write(JSON.stringify(msg) + "\n");
    return Promise.resolve();
  }

  close(): void {
    this.proc.kill();
  }
}

class HttpTransport implements Transport {
  onMessage: (msg: JsonRpcMessage) => void = () => {};
  onError: (err: Error) => void = () => {};
  /** Assigned by the server on initialize (Mcp-Session-Id header), echoed thereafter. */
  private sessionId: string | undefined;
  /** Negotiated on initialize; sent as MCP-Protocol-Version on later requests. */
  protocolVersion: string | undefined;
  /** OAuth state for this endpoint, when the user has logged in (see oauth.ts). */
  private oauth: OAuthSession;

  constructor(
    private url: string,
    private headers: Record<string, string>
  ) {
    this.oauth = new OAuthSession(url);
  }

  private async buildHeaders(): Promise<Record<string, string>> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...this.headers,
    };
    if (this.sessionId) headers["mcp-session-id"] = this.sessionId;
    if (this.protocolVersion) headers["mcp-protocol-version"] = this.protocolVersion;
    // A configured Authorization header wins: someone who pasted a PAT into
    // config meant to use it, and shouldn't be overridden by a stale grant.
    const hasExplicitAuth = Object.keys(headers).some((k) => k.toLowerCase() === "authorization");
    if (!hasExplicitAuth) {
      const token = await this.oauth.accessToken();
      if (token) headers.authorization = `Bearer ${token}`;
    }
    return headers;
  }

  async send(msg: JsonRpcMessage, timeoutMs: number, signal?: AbortSignal): Promise<void> {
    let res = await this.post(msg, timeoutMs, signal);

    // 401 has two meanings: an access token that just aged out (refresh and
    // retry once — silent, and the common case an hour into a session), or no
    // usable grant at all, which only a browser login can fix.
    if (res.status === 401) {
      const refreshed = await this.oauth.handleUnauthorized();
      if (refreshed) {
        await res.body?.cancel().catch(() => {});
        res = await this.post(msg, timeoutMs, signal);
      }
      if (res.status === 401) {
        const challenge = parseWwwAuthenticate(res.headers.get("www-authenticate"));
        await res.body?.cancel().catch(() => {});
        throw new McpAuthRequiredError(this.url, challenge);
      }
    }

    const sid = res.headers.get("mcp-session-id");
    if (sid) this.sessionId = sid;
    if (!res.ok) {
      // Drain to avoid leaking the connection, then surface the status.
      const body = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ""}`);
    }
    const contentType = res.headers.get("content-type") ?? "";
    if (contentType.includes("text/event-stream")) {
      await this.readSse(res);
    } else if (contentType.includes("application/json")) {
      const parsed = (await res.json()) as JsonRpcMessage | JsonRpcMessage[];
      for (const m of Array.isArray(parsed) ? parsed : [parsed]) this.onMessage(m);
    }
    // Anything else (e.g. a 202 Accepted for a notification) carries no messages.
  }

  private async post(
    msg: JsonRpcMessage,
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<Response> {
    return fetch(this.url, {
      method: "POST",
      headers: await this.buildHeaders(),
      body: JSON.stringify(msg),
      // Cancelling has to tear the socket down too, or the request stays in
      // flight for the full timeout after the user has walked away.
      signal: withTimeout(timeoutMs, signal),
    });
  }

  /** Parse an SSE body, feeding each `data:` event's JSON to onMessage. */
  private async readSse(res: Response): Promise<void> {
    if (!res.body) return;
    const decoder = new TextDecoder();
    let buffer = "";
    const dispatch = (rawEvent: string) => {
      const data = rawEvent
        .split(/\r?\n/)
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trimStart())
        .join("\n");
      if (!data) return;
      try {
        this.onMessage(JSON.parse(data) as JsonRpcMessage);
      } catch {
        // ignore non-JSON events (keep-alives, comments)
      }
    };
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true });
      let idx: number;
      while ((idx = buffer.search(/\r?\n\r?\n/)) >= 0) {
        const rawEvent = buffer.slice(0, idx);
        buffer = buffer.slice(idx).replace(/^\r?\n\r?\n/, "");
        dispatch(rawEvent);
      }
    }
    if (buffer.trim()) dispatch(buffer);
  }

  close(): void {
    // Best-effort explicit session termination, per the Streamable HTTP spec.
    if (!this.sessionId) return;
    this.buildHeaders()
      .then((headers) =>
        fetch(this.url, {
          method: "DELETE",
          headers,
          signal: AbortSignal.timeout(3_000),
        })
      )
      .catch(() => {});
  }
}

class McpConnection {
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
    if (typeof msg.id !== "number" || msg.method) return; // notification or server->client request
    const p = this.take(msg.id);
    if (!p) return;
    if (msg.error) p.reject(new Error(msg.error.message ?? "MCP error"));
    else p.resolve(msg.result);
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

  async initialize(): Promise<McpToolSpec[]> {
    const init = (await this.request(
      "initialize",
      {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "kritya", version: VERSION },
      },
      CONNECT_TIMEOUT_MS
    )) as { protocolVersion?: string };
    if (this.transport instanceof HttpTransport) {
      this.transport.protocolVersion = init.protocolVersion ?? PROTOCOL_VERSION;
    }
    this.notify("notifications/initialized");
    const listed = (await this.request("tools/list", {}, CONNECT_TIMEOUT_MS)) as {
      tools?: McpToolSpec[];
    };
    return listed.tools ?? [];
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
    )) as { content?: { type: string; text?: string }[]; isError?: boolean };
    const text = (result.content ?? [])
      .map((c) => (c.type === "text" ? (c.text ?? "") : `[${c.type} content]`))
      .join("\n");
    if (result.isError) throw new Error(text || "MCP tool reported an error");
    return text || "(no output)";
  }

  close(): void {
    this.closed = true;
    this.transport.close();
  }
}

function makeTransport(name: string, cfg: McpServerConfig): Transport {
  if (cfg.url) {
    if (cfg.command) {
      throw new Error(`server "${name}" sets both "command" and "url"; pick one`);
    }
    return new HttpTransport(cfg.url, cfg.headers ?? {});
  }
  if (!cfg.command) {
    throw new Error(`server "${name}" needs either "command" (stdio) or "url" (HTTP)`);
  }
  return new StdioTransport(cfg.command, cfg.args ?? [], cfg.env);
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
}

const connections: McpConnection[] = [];
let statuses: McpServerStatus[] = [];

/** Status of every configured MCP server from the last loadMcpTools call. */
export function mcpStatus(): McpServerStatus[] {
  return statuses;
}

function sanitize(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, "_");
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
  trace?: { tracer: Tracer; audit?: AuditLog }
): Promise<ToolDef[]> {
  statuses = [];
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
  trace?: { tracer: Tracer; audit?: AuditLog }
): Promise<{ tools: ToolDef[]; status: McpServerStatus }> {
  const tracer = trace?.tracer ?? NOOP_TRACER;
  const tools: ToolDef[] = [];
  const status: McpServerStatus = {
    name,
    transport: cfg.url ? "http" : "stdio",
    target: cfg.url ?? [cfg.command, ...(cfg.args ?? [])].filter(Boolean).join(" "),
    ok: false,
    tools: [],
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
    conn = new McpConnection(name, makeTransport(name, cfg));
    const specs = await conn.initialize();
    connections.push(conn);
    for (const spec of specs) {
      tools.push(mcpToolDef(conn, name, spec));
      status.tools.push(spec.name);
    }
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

/** Replace one server's entry in the /mcp status table after a reconnect. */
export function replaceStatus(status: McpServerStatus): void {
  const idx = statuses.findIndex((s) => s.name === status.name);
  if (idx >= 0) statuses[idx] = status;
  else statuses.push(status);
}

function mcpToolDef(conn: McpConnection, server: string, spec: McpToolSpec): ToolDef {
  const name = `mcp_${sanitize(server)}_${sanitize(spec.name)}`;
  return {
    name,
    description: `[MCP: ${server}] ${spec.description ?? spec.name}`,
    parameters: spec.inputSchema ?? { type: "object", properties: {} },
    requiresPermission: true,
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
}

/** Kill all MCP servers (call on exit). */
export function shutdownMcp(): void {
  for (const conn of connections) conn.close();
  connections.length = 0;
}
