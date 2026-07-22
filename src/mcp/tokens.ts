import fs from "node:fs";
import path from "node:path";
import { CONFIG_DIR } from "../config/config.js";
import { debugLog } from "../config/debug.js";
import { hardenWindowsDir } from "../config/winAcl.js";

/**
 * Persistent OAuth state for remote MCP servers, in `~/.kritya/mcp-auth.json`.
 *
 * This file holds live bearer tokens for third-party accounts (Linear, Notion,
 * Sentry, …), so it is the single most sensitive file kritya writes — more so
 * than config.json, whose provider keys the user can at least rotate from one
 * place. It gets the same 0600 + Windows-ACL treatment as the rest of
 * CONFIG_DIR, and never travels with the workspace.
 *
 * Records are keyed by the server's canonical URL rather than its configured
 * name: the same endpoint is often called different things in a user's global
 * config and a repo's .mcp.json, and renaming a server in config shouldn't
 * silently orphan a token and force a fresh browser round-trip.
 */

/**
 * Where the store lives. Read per call rather than captured at import time so
 * KRITYA_MCP_AUTH_FILE can be set after this module loads — the test suite must
 * never touch a developer's real tokens, and ESM import hoisting makes
 * "set the env first" unreliable otherwise.
 */
export function authFilePath(): string {
  return process.env.KRITYA_MCP_AUTH_FILE || path.join(CONFIG_DIR, "mcp-auth.json");
}

export interface StoredAuth {
  /** Canonical resource URI of the MCP server this grant is scoped to. */
  resource: string;
  /** Authorization server that issued it, for refresh/revoke without re-discovery. */
  issuer: string;
  tokenEndpoint: string;
  revocationEndpoint?: string;
  /** From dynamic client registration — reused so we register once per AS, not once per login. */
  clientId: string;
  clientSecret?: string;
  /** The loopback URI this client_id was registered with; a new port means re-registering. */
  redirectUri?: string;
  accessToken: string;
  refreshToken?: string;
  /** Epoch ms; absent when the server didn't say (treat as "valid until a 401 says otherwise"). */
  expiresAt?: number;
  scope?: string;
  /** Display only — which config name this was last logged in as. */
  serverName?: string;
}

type AuthStore = Record<string, StoredAuth>;

/** Normalize a server URL so trivial spelling differences map to one record. */
export function authKey(url: string): string {
  try {
    const u = new URL(url);
    u.hash = "";
    u.search = "";
    // A trailing slash on the path is not a different resource.
    if (u.pathname.length > 1 && u.pathname.endsWith("/")) u.pathname = u.pathname.slice(0, -1);
    return u.toString();
  } catch {
    return url;
  }
}

function loadStore(file: string): AuthStore {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" ? (parsed as AuthStore) : {};
  } catch (err) {
    debugLog(`mcp tokens loadStore(${file})`, err);
    return {};
  }
}

function saveStore(file: string, store: AuthStore): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  hardenWindowsDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(store, null, 2) + "\n", { mode: 0o600 });
  // `mode` only applies when writeFileSync creates the file; enforce it even if
  // mcp-auth.json already existed with looser permissions (e.g. restored from a
  // backup, or written by an older build).
  try {
    fs.chmodSync(file, 0o600);
  } catch (err) {
    debugLog(`mcp tokens chmod(${file})`, err);
  }
}

export function loadAuth(url: string, file = authFilePath()): StoredAuth | undefined {
  return loadStore(file)[authKey(url)];
}

export function saveAuth(url: string, auth: StoredAuth, file = authFilePath()): void {
  const store = loadStore(file);
  store[authKey(url)] = auth;
  saveStore(file, store);
}

/** Forget a server's grant locally. Returns what was removed, for revocation. */
export function deleteAuth(url: string, file = authFilePath()): StoredAuth | undefined {
  const store = loadStore(file);
  const key = authKey(url);
  const existing = store[key];
  if (!existing) return undefined;
  delete store[key];
  saveStore(file, store);
  return existing;
}

/** Every stored grant, for `/mcp` status display. */
export function listAuth(file = authFilePath()): { url: string; auth: StoredAuth }[] {
  return Object.entries(loadStore(file)).map(([url, auth]) => ({ url, auth }));
}

/**
 * Whether an access token is close enough to expiry to refresh proactively.
 * The 60s skew keeps a token from dying mid-request after passing this check.
 */
export function isExpired(auth: StoredAuth, now = Date.now()): boolean {
  return auth.expiresAt !== undefined && auth.expiresAt - 60_000 <= now;
}
