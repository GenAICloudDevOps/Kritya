import { spawn, type ChildProcess } from "node:child_process";
import { McpAuthRequiredError, OAuthSession, parseWwwAuthenticate } from "./oauth.js";
import { planSpawn } from "./spawnWin.js";

/** Same-origin redirects we'll follow before calling it a loop. */
const MAX_REDIRECTS = 5;

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

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

export interface JsonRpcMessage {
  jsonrpc?: string;
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string };
}

/**
 * A transport delivers JSON-RPC messages to the server and feeds messages
 * coming back through onMessage. `send` resolves once the message (and, for
 * HTTP, its response body) has been fully handled; connection-level failures
 * surface through onError. `signal` aborts the in-flight delivery when the
 * user cancels.
 */
export interface Transport {
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

export class StdioTransport implements Transport {
  onMessage: (msg: JsonRpcMessage) => void = () => {};
  onError: (err: Error) => void = () => {};
  private proc: ChildProcess;
  private buffer = "";
  /** Tail of the server's stderr, kept for the exit message (see below). */
  private stderrTail = "";

  constructor(
    command: string,
    args: string[],
    env: Record<string, string> | undefined,
    cwd: string
  ) {
    const plan = planSpawn(command, args);
    this.proc = spawn(plan.command, plan.args, {
      // Minimal env, not the full process env: every provider API key lives
      // in process.env, and an MCP server is third-party code the user opted
      // into but shouldn't automatically receive credentials it never asked
      // for. Servers that need extra vars declare them in their own `env`.
      env: { ...minimalEnv(), ...env },
      // Always explicit. Inheriting kritya's cwd makes a server's scope depend
      // on which directory the user launched from — see McpServerConfig.cwd.
      cwd,
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

export class HttpTransport implements Transport {
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
    const body = JSON.stringify(msg);
    let url = this.url;
    // Bounded, because a redirect chain is otherwise a free loop.
    for (let hop = 0; ; hop++) {
      const res = await fetch(url, {
        method: "POST",
        headers: await this.buildHeaders(),
        body,
        // Following redirects automatically re-sends every header — including
        // Authorization — to whatever Location names. A compromised server, or
        // anyone able to rewrite a plaintext hop, could point that at their own
        // origin and collect the token. Handle them here so we can look first.
        redirect: "manual",
        // Cancelling has to tear the socket down too, or the request stays in
        // flight for the full timeout after the user has walked away.
        signal: withTimeout(timeoutMs, signal),
      });
      if (!isRedirect(res.status)) return res;

      const location = res.headers.get("location");
      await res.body?.cancel().catch(() => {});
      if (!location) throw new Error(`HTTP ${res.status} redirect with no Location header`);
      if (hop >= MAX_REDIRECTS) throw new Error(`too many redirects from ${this.url}`);

      const target = new URL(location, url);
      // Same-origin only. A cross-origin redirect may be entirely legitimate
      // (a vendor moving endpoints), but we cannot tell that from an attack,
      // and the cost of guessing wrong is the user's bearer token. Refuse, and
      // name the destination so a real migration is a one-line config edit.
      if (target.origin !== new URL(url).origin) {
        throw new Error(
          `refusing redirect to a different origin (${target.origin}) — ` +
            `it would send this server's credentials there. ` +
            `If that endpoint is genuine, point the server's "url" at it directly.`
        );
      }
      url = target.toString();
    }
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
          redirect: "manual",
          signal: AbortSignal.timeout(3_000),
        })
      )
      .catch(() => {});
  }
}
