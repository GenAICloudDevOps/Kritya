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
