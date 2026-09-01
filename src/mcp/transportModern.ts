import type { ChildProcess } from "node:child_process";
import { McpAuthRequiredError, OAuthSession, parseWwwAuthenticate } from "./oauth.js";
import { withTimeout, type JsonRpcMessage, type Transport } from "./transport.js";
import { modernMeta, MODERN_PROTOCOL_VERSION } from "./eraDetect.js";

/** Same-origin redirects we'll follow before calling it a loop. */
const MAX_REDIRECTS = 5;

/** How much of a server's stderr to keep for diagnostics, and how much to report. */
const STDERR_KEEP_BYTES = 8_192;
const STDERR_REPORT_LINES = 5;

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

/**
 * True when a string is safe to send verbatim as an HTTP header value:
 * visible ASCII (0x21-0x7E), space, and horizontal tab only, no
 * leading/trailing whitespace, per RFC 9110 field-value rules.
 */
function isPlainAsciiHeaderSafe(s: string): boolean {
  if (s !== s.trim()) return false;
  return /^[\t\x20-\x7E]*$/.test(s);
}

const BASE64_SENTINEL_RE = /^=\?base64\?[A-Za-z0-9+/=]*\?=$/;

/**
 * Encode a value for an `Mcp-Name`/`Mcp-Param-*` header per the 2026-07-28
 * Streamable HTTP spec's Value Encoding rules: plain ASCII as-is, otherwise
 * (or if it collides with the sentinel pattern itself) base64-sentinel the
 * UTF-8 bytes.
 */
export function encodeHeaderValue(value: string): string {
  if (isPlainAsciiHeaderSafe(value) && !BASE64_SENTINEL_RE.test(value)) return value;
  return `=?base64?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

/** Pull the `Mcp-Name` source value (params.name or params.uri) for a request, if any. */
function mcpNameFor(msg: JsonRpcMessage): string | undefined {
  const params = msg.params as { name?: unknown; uri?: unknown } | undefined;
  if (typeof params?.name === "string") return params.name;
  if (typeof params?.uri === "string") return params.uri;
  return undefined;
}

/**
 * Streamable HTTP transport for the modern (2026-07-28+), stateless,
 * per-request era: no `Mcp-Session-Id`, no `initialize`, every POST carries
 * `_meta` in the body and mirrors `MCP-Protocol-Version`/`Mcp-Method`/
 * `Mcp-Name` into headers. See
 * /specification/2026-07-28/basic/transports/streamable-http.
 */
export class ModernHttpTransport implements Transport {
  onMessage: (msg: JsonRpcMessage) => void = () => {};
  onError: (err: Error) => void = () => {};
  private oauth: OAuthSession;

  constructor(
    private url: string,
    private headers: Record<string, string>
  ) {
    this.oauth = new OAuthSession(url);
  }

  private async buildHeaders(msg: JsonRpcMessage): Promise<Record<string, string>> {
    const headers: Record<string, string> = {
      ...this.headers,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": MODERN_PROTOCOL_VERSION,
      "mcp-method": msg.method ?? "",
    };
    const name = mcpNameFor(msg);
    if (name !== undefined) headers["mcp-name"] = encodeHeaderValue(name);
    const hasExplicitAuth = Object.keys(headers).some((k) => k.toLowerCase() === "authorization");
    if (!hasExplicitAuth) {
      const token = await this.oauth.accessToken();
      if (token) headers.authorization = `Bearer ${token}`;
    }
    return headers;
  }

  private withMeta(msg: JsonRpcMessage): JsonRpcMessage {
    const params = (msg.params ?? {}) as Record<string, unknown>;
    return { ...msg, params: { ...params, _meta: modernMeta() } };
  }

  async send(msg: JsonRpcMessage, timeoutMs: number, signal?: AbortSignal): Promise<void> {
    const body = this.withMeta(msg);
    let res = await this.post(body, timeoutMs, signal);

    if (res.status === 401) {
      const refreshed = await this.oauth.handleUnauthorized();
      if (refreshed) {
        await res.body?.cancel().catch(() => {});
        res = await this.post(body, timeoutMs, signal);
      }
      if (res.status === 401) {
        const challenge = parseWwwAuthenticate(res.headers.get("www-authenticate"));
        await res.body?.cancel().catch(() => {});
        throw new McpAuthRequiredError(this.url, challenge);
      }
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      let parsed: JsonRpcMessage | undefined;
      try {
        parsed = JSON.parse(text);
      } catch {
        // not JSON — fall through to the generic HTTP error below
      }
      if (parsed?.error) {
        this.onMessage(parsed);
        return;
      }
      throw new Error(`HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ""}`);
    }
    const contentType = res.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      const parsed = (await res.json()) as JsonRpcMessage;
      this.onMessage(parsed);
    } else if (contentType.includes("text/event-stream")) {
      await this.readSse(res);
    }
  }

  private async post(
    msg: JsonRpcMessage,
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<Response> {
    const body = JSON.stringify(msg);
    let url = this.url;
    for (let hop = 0; ; hop++) {
      const res = await fetch(url, {
        method: "POST",
        headers: await this.buildHeaders(msg),
        body,
        redirect: "manual",
        signal: withTimeout(timeoutMs, signal),
      });
      if (!isRedirect(res.status)) return res;
      const location = res.headers.get("location");
      await res.body?.cancel().catch(() => {});
      if (!location) throw new Error(`HTTP ${res.status} redirect with no Location header`);
      if (hop >= MAX_REDIRECTS) throw new Error(`too many redirects from ${this.url}`);
      const target = new URL(location, url);
      if (target.origin !== new URL(url).origin) {
        throw new Error(
          `refusing redirect to a different origin (${target.origin}) — ` +
            `it would send this server's credentials there.`
        );
      }
      url = target.toString();
    }
  }

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
        // ignore non-JSON events (comments, keep-alives)
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
    // No session to terminate — modern mode never sends DELETE.
  }
}

/**
 * Wraps an already-spawned stdio child process — one `probeStdioEra` kept
 * alive after a successful `server/discover` — as a `Transport`, instead of
 * paying for a second process launch.
 *
 * Mirrors `StdioTransport`'s framing and lifecycle handling (line buffering
 * across chunk boundaries, `onError` wired to `close`/`exit`/`error`) rather
 * than a one-shot "resolve on next data event" adapter: `ModernMcpConnection`
 * can have more than one request in flight (e.g. concurrent tool calls), and
 * a naive adapter would resolve the wrong `send()` call, or drop data split
 * across multiple chunks/lines.
 */
export class ReusedProcessTransport implements Transport {
  onMessage: (msg: JsonRpcMessage) => void = () => {};
  onError: (err: Error) => void = () => {};
  private buffer = "";
  /** Tail of the server's stderr, kept for the exit message (see StdioTransport). */
  private stderrTail = "";

  constructor(private proc: ChildProcess) {
    // Attached first, before anything else: draining stderr is not optional
    // (see StdioTransport's doc comment) — a server that logs more than the
    // OS pipe buffer blocks in its own write() forever if nobody reads it,
    // and the process may already be mid-flight from probeStdioEra's own
    // (brief) probe window.
    this.proc.stderr?.setEncoding("utf8");
    this.proc.stderr?.on("data", (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-STDERR_KEEP_BYTES);
    });
    this.proc.stdout?.setEncoding("utf8");
    this.proc.stdout?.on("data", (chunk: string) => this.onData(chunk));
    let reported = false;
    const report = (code: number | null, signal: NodeJS.Signals | null) => {
      if (reported) return;
      reported = true;
      const how = signal ? `killed by ${signal}` : `exited with code ${code ?? 0}`;
      this.onError(new Error(`server process ${how}${this.stderrDetail()}`));
    };
    // Same close/exit split as StdioTransport: "close" waits for stdio to
    // flush, "exit" arms a short fallback in case a grandchild holds the
    // pipes open.
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
