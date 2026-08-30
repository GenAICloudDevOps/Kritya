import { VERSION } from "../version.js";

/**
 * Era detection and the modern (2026-07-28+) per-request `_meta` shape.
 *
 * Modern MCP has no `initialize` handshake: every request carries its
 * protocol version, capabilities, and identity in `_meta`, and the server
 * answers each request independently. See
 * /specification/2026-07-28/basic/versioning for the era model this file
 * implements detection for.
 */

export const MODERN_PROTOCOL_VERSION = "2026-07-28";

export type Era = "modern" | "legacy";

export interface DiscoverResult {
  supportedVersions: string[];
  capabilities: Record<string, unknown>;
  serverInfo?: { name: string; version: string };
  instructions?: string;
}

/** The `_meta` block every modern request carries, per spec's "Per-request protocol fields". */
export function modernMeta(
  clientCapabilities: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    "io.modelcontextprotocol/protocolVersion": MODERN_PROTOCOL_VERSION,
    "io.modelcontextprotocol/clientInfo": { name: "kritya", version: VERSION },
    "io.modelcontextprotocol/clientCapabilities": clientCapabilities,
  };
}

/** The three error codes the 2026-07-28 spec reserves for version/capability/header mismatches. */
const MODERN_ERROR_CODES = new Set([-32020, -32021, -32022]);

export function isRecognizedModernError(err: { code?: number } | undefined): boolean {
  return typeof err?.code === "number" && MODERN_ERROR_CODES.has(err.code);
}

/** Parse a raw JSON-RPC `result` into a DiscoverResult; undefined if the shape doesn't match. */
export function parseDiscoverResult(result: unknown): DiscoverResult | undefined {
  if (!result || typeof result !== "object") return undefined;
  const r = result as {
    supportedVersions?: unknown;
    capabilities?: unknown;
    instructions?: unknown;
    _meta?: { "io.modelcontextprotocol/serverInfo"?: { name: string; version: string } };
  };
  if (
    !Array.isArray(r.supportedVersions) ||
    !r.supportedVersions.every((v) => typeof v === "string")
  ) {
    return undefined;
  }
  if (!r.capabilities || typeof r.capabilities !== "object") return undefined;
  return {
    supportedVersions: r.supportedVersions,
    capabilities: r.capabilities as Record<string, unknown>,
    serverInfo: r._meta?.["io.modelcontextprotocol/serverInfo"],
    instructions: typeof r.instructions === "string" ? r.instructions : undefined,
  };
}

import { spawn, type ChildProcess } from "node:child_process";
import { planSpawn } from "./spawnWin.js";

export interface StdioProbeResult {
  era: Era;
  process?: ChildProcess;
  discover?: DiscoverResult;
}

const DEFAULT_PROBE_TIMEOUT_MS = 5_000;

/**
 * Probe a stdio server with `server/discover`, per
 * /specification/2026-07-28/basic/transports/stdio#backward-compatibility.
 * Three outcomes: a DiscoverResult (modern, process kept alive for reuse), a
 * recognized modern error (modern, but report — don't fall back), or
 * anything else / a timeout (legacy — the caller launches its own process).
 */
export function probeStdioEra(
  command: string,
  args: string[],
  env: Record<string, string> | undefined,
  cwd: string,
  timeoutMs = DEFAULT_PROBE_TIMEOUT_MS
): Promise<StdioProbeResult> {
  return new Promise((resolve) => {
    const plan = planSpawn(command, args);
    const proc = spawn(plan.command, plan.args, {
      env: { ...process.env, ...env } as Record<string, string>,
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      windowsVerbatimArguments: plan.windowsVerbatimArguments,
    });

    let buffer = "";
    let settled = false;
    const finish = (result: StdioProbeResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      proc.stdout?.removeAllListeners("data");
      if (result.era === "legacy") proc.kill();
      resolve(result);
    };

    const timer = setTimeout(() => finish({ era: "legacy" }), timeoutMs);
    timer.unref?.();

    proc.on("error", () => finish({ era: "legacy" }));
    proc.stdout?.setEncoding("utf8");
    proc.stdout?.on("data", (chunk: string) => {
      buffer += chunk;
      const idx = buffer.indexOf("\n");
      if (idx < 0) return;
      const line = buffer.slice(0, idx).trim();
      if (!line) return;
      let msg: { result?: unknown; error?: { code?: number } };
      try {
        msg = JSON.parse(line);
      } catch {
        finish({ era: "legacy" });
        return;
      }
      if (msg.result !== undefined) {
        const discover = parseDiscoverResult(msg.result);
        if (discover) {
          finish({ era: "modern", process: proc, discover });
          return;
        }
      }
      if (isRecognizedModernError(msg.error)) {
        proc.kill();
        finish({ era: "modern" });
        return;
      }
      finish({ era: "legacy" });
    });

    proc.stdin?.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "discover-probe",
        method: "server/discover",
        params: { _meta: modernMeta() },
      }) + "\n"
    );
  });
}

export interface HttpProbeResult {
  era: Era;
  discover?: DiscoverResult;
}

const DEFAULT_HTTP_PROBE_TIMEOUT_MS = 10_000;

/**
 * Probe an HTTP server by attempting a modern `server/discover` POST, per
 * /specification/2026-07-28/basic/transports/streamable-http#backward-compatibility.
 */
export async function probeHttpEra(
  url: string,
  headers: Record<string, string>,
  timeoutMs = DEFAULT_HTTP_PROBE_TIMEOUT_MS
): Promise<HttpProbeResult> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": MODERN_PROTOCOL_VERSION,
        "mcp-method": "server/discover",
        ...headers,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "discover-probe",
        method: "server/discover",
        params: { _meta: modernMeta() },
      }),
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return { era: "legacy" };
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { era: "legacy" };
  }
  const msg = body as { result?: unknown; error?: { code?: number } };

  if (res.ok) {
    const discover = parseDiscoverResult(msg.result);
    if (discover) return { era: "modern", discover };
    return { era: "legacy" };
  }
  if (isRecognizedModernError(msg.error)) return { era: "modern" };
  return { era: "legacy" };
}
