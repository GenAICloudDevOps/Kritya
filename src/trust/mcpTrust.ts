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
 * if its command, args, cwd, url, tool filter, or env/header key names change,
 * the fingerprint changes and it's treated as new. Approvals are not permanent:
 * `/mcp trust` lists them and `/mcp trust revoke` withdraws them, so the store
 * drains as well as fills.
 */

const MCP_TRUST_FILE = path.join(CONFIG_DIR, "mcp-trusted.json");

export interface McpTrustEntry {
  name: string;
  fingerprint: string;
  trustedAt: string;
  /** Hash of the tool shape observed the first time this fingerprint connected. */
  toolsHash?: string;
}

/** The subset of a tool spec that defines what it does, for shape hashing. */
interface ToolShapeInput {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

/** Stable identity for a server's declared config — structural shape only, never secret values. */
export function serverFingerprint(cfg: McpServerConfig): string {
  const shape = {
    command: cfg.command,
    args: cfg.args ?? [],
    // Part of the identity, not a detail: cwd decides what a filesystem-style
    // server can reach. Leaving it out would let a .mcp.json edit widen a
    // server approved for ./docs to the whole disk without re-prompting.
    cwd: cfg.cwd,
    url: cfg.url,
    envKeys: cfg.env ? Object.keys(cfg.env).sort() : [],
    headerKeys: cfg.headers ? Object.keys(cfg.headers).sort() : [],
    // Also scope-defining: an edit relaxing `allow` from ["search"] to ["*"]
    // exposes tools the user never saw when they approved the server.
    tools: cfg.tools ?? null,
  };
  return crypto.createHash("sha256").update(JSON.stringify(shape)).digest("hex");
}

/** Stable identity for a server's live tool list — what it actually does, not where it runs. */
export function toolsShapeHash(tools: ToolShapeInput[]): string {
  const shape = tools
    .map((t) => ({
      name: t.name,
      description: t.description ?? "",
      inputSchema: t.inputSchema ?? null,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
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

/** The full manifest, as shown by `/mcp trust`. */
export function loadMcpAllowlist(storeFile = MCP_TRUST_FILE): McpTrustEntry[] {
  return loadStore(storeFile);
}

/**
 * Withdraw trust from every entry recorded under `name`. Returns the entries
 * that were dropped, so the caller can report what it actually did.
 *
 * An allowlist that only grows is a ratchet: approvals accumulate for servers
 * the user has long since stopped using, and because trust is matched by
 * fingerprint across all workspaces, a stale entry silently approves the same
 * server the next time any repo declares it. Revoking is the drain.
 *
 * Matched by name rather than fingerprint because that is what the user has:
 * the same name can hold several entries if the config changed over time, and
 * "stop trusting linear" plainly means all of them.
 */
export function revokeServer(name: string, storeFile = MCP_TRUST_FILE): McpTrustEntry[] {
  const entries = loadStore(storeFile);
  const removed = entries.filter((e) => e.name === name);
  if (removed.length)
    saveStore(
      storeFile,
      entries.filter((e) => e.name !== name)
    );
  return removed;
}

/** Withdraw trust from one exact config. Used when a server is removed outright. */
export function revokeFingerprint(fingerprint: string, storeFile = MCP_TRUST_FILE): boolean {
  const entries = loadStore(storeFile);
  const rest = entries.filter((e) => e.fingerprint !== fingerprint);
  if (rest.length === entries.length) return false;
  saveStore(storeFile, rest);
  return true;
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

/**
 * Approving a server's *config* (command, url, env keys, ...) only promises
 * the user reviewed where it runs and what it can reach — not what tools it
 * actually exposes to the model, which a compromised or malicious server can
 * change on any connection without touching its declared config at all. This
 * compares a freshly-connected server's live tool shape (names, descriptions,
 * input schemas) against what was recorded the first time its config was
 * trusted.
 *
 * There is nothing to compare on that first connection (or after upgrading
 * from a version that didn't record this), so it's recorded rather than
 * flagged — otherwise every existing approval would start failing the moment
 * this check shipped.
 */
export function checkToolsShape(
  fingerprint: string,
  tools: ToolShapeInput[],
  storeFile = MCP_TRUST_FILE
): { ok: boolean; recorded: boolean } {
  const entries = loadStore(storeFile);
  const entry = entries.find((e) => e.fingerprint === fingerprint);
  if (!entry) return { ok: true, recorded: false };

  const hash = toolsShapeHash(tools);
  if (!entry.toolsHash) {
    saveStore(
      storeFile,
      entries.map((e) => (e === entry ? { ...e, toolsHash: hash } : e))
    );
    return { ok: true, recorded: true };
  }
  return { ok: entry.toolsHash === hash, recorded: false };
}
