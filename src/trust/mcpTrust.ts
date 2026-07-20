import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { CONFIG_DIR } from "../config/config.js";
import type { McpServerConfig } from "../config/config.js";
import { hardenWindowsDir } from "../config/winAcl.js";

/**
 * Per-server MCP trust. Workspace trust (see trust.ts) gates whether a
 * project's .mcp.json is read at all, but treats it as one blob alongside
 * unrelated gated content (allow rules, hooks, .env) — approving it once
 * approves every server the file names, including ones a later commit or PR
 * branch adds. MCP servers are their own attack surface: each is arbitrary
 * code (stdio) or a remote endpoint (HTTP) that runs with the user's
 * credentials the moment it's loaded. So each server also gets its own
 * first-use confirmation, fingerprinted on its declared (pre-expansion)
 * config — never on expanded env/header values, which may hold live secrets
 * — and recorded in a global manifest/allowlist (`mcp-trusted.json`), the
 * same "approve once, matched by pattern thereafter" model already used for
 * shell allow rules (see permissions/rules.ts). Once approved, the identical
 * server (by fingerprint) is trusted in any workspace without asking again;
 * if its command, args, url, or env/header key names change, the fingerprint
 * changes and it's treated as new.
 */

const MCP_TRUST_FILE = path.join(CONFIG_DIR, "mcp-trusted.json");

export interface McpTrustEntry {
  name: string;
  fingerprint: string;
  trustedAt: string;
}

/** Stable identity for a server's declared config — structural shape only, never secret values. */
export function serverFingerprint(cfg: McpServerConfig): string {
  const shape = {
    command: cfg.command,
    args: cfg.args ?? [],
    url: cfg.url,
    envKeys: cfg.env ? Object.keys(cfg.env).sort() : [],
    headerKeys: cfg.headers ? Object.keys(cfg.headers).sort() : [],
  };
  return crypto.createHash("sha256").update(JSON.stringify(shape)).digest("hex");
}

function loadStore(storeFile: string): McpTrustEntry[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(storeFile, "utf8"));
    return Array.isArray(parsed) ? (parsed as McpTrustEntry[]) : [];
  } catch {
    return [];
  }
}

function saveStore(storeFile: string, entries: McpTrustEntry[]): void {
  fs.mkdirSync(path.dirname(storeFile), { recursive: true, mode: 0o700 });
  hardenWindowsDir(path.dirname(storeFile));
  fs.writeFileSync(storeFile, JSON.stringify(entries, null, 2) + "\n", { mode: 0o600 });
}

export function isServerTrusted(fingerprint: string, storeFile = MCP_TRUST_FILE): boolean {
  return loadStore(storeFile).some((e) => e.fingerprint === fingerprint);
}

/** Record a server as trusted — the manifest/allowlist other workspaces reuse. */
export function trustServer(name: string, fingerprint: string, storeFile = MCP_TRUST_FILE): void {
  const entries = loadStore(storeFile).filter((e) => e.fingerprint !== fingerprint);
  entries.push({ name, fingerprint, trustedAt: new Date().toISOString() });
  saveStore(storeFile, entries);
}

/** The full manifest, e.g. for a future `/mcp trust list`-style display. */
export function loadMcpAllowlist(storeFile = MCP_TRUST_FILE): McpTrustEntry[] {
  return loadStore(storeFile);
}

/** Split a set of declared MCP servers into already-trusted vs needing first-use confirmation. */
export function partitionByTrust(
  servers: Record<string, McpServerConfig>,
  storeFile = MCP_TRUST_FILE
): {
  trusted: Record<string, McpServerConfig>;
  pending: Record<string, McpServerConfig>;
} {
  const trusted: Record<string, McpServerConfig> = {};
  const pending: Record<string, McpServerConfig> = {};
  for (const [name, cfg] of Object.entries(servers)) {
    if (isServerTrusted(serverFingerprint(cfg), storeFile)) trusted[name] = cfg;
    else pending[name] = cfg;
  }
  return { trusted, pending };
}
