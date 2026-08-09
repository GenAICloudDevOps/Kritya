import fs from "node:fs";
import path from "node:path";
import type { McpServerConfig } from "../config/config.js";

/**
 * Where MCP server definitions come from and how they combine:
 *
 *  - Global: `mcpServers` in ~/.kritya/config.json — the user's own machines.
 *  - Project: `.mcp.json` at the workspace root (the cross-tool convention
 *    also read by Claude Code, Cursor, and VS Code), shape
 *    `{ "mcpServers": { name: { command|url, ... } } }`. A repo can ship this
 *    file, and it launches processes / sends requests with the user's
 *    credentials — so it is part of the workspace trust gate and must only be
 *    loaded for trusted workspaces (the caller enforces this).
 *
 * `${VAR}` in any string value is expanded from the environment at load time,
 * so a checked-in .mcp.json never needs to contain a literal secret
 * (e.g. "Authorization": "Bearer ${LINEAR_API_KEY}").
 */

const VAR_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/** Expand ${VAR} from process.env; unknown variables are left as-is so typos stay visible. */
export function expandVars(value: string): string {
  return value.replace(VAR_RE, (whole, name: string) => {
    const v = process.env[name];
    return v !== undefined ? v : whole;
  });
}

/**
 * Names of ${VAR}s still unexpanded in an already-expanded config.
 *
 * Leaving them literal keeps typos visible, but only if something actually
 * looks: otherwise a missing LINEAR_API_KEY means we POST the literal string
 * `Bearer ${LINEAR_API_KEY}` to a third party, get an opaque 401 back, and —
 * because 401 is also how OAuth asks for a login — report it as "needs login".
 * Callers use this to fail the server with the real reason instead.
 */
export function missingVars(cfg: McpServerConfig): string[] {
  const found = new Set<string>();
  const scan = (s: string | undefined) => {
    if (!s) return;
    for (const m of s.matchAll(VAR_RE)) found.add(m[1]);
  };
  scan(cfg.command);
  cfg.args?.forEach(scan);
  scan(cfg.cwd);
  scan(cfg.url);
  for (const v of Object.values(cfg.env ?? {})) scan(v);
  for (const v of Object.values(cfg.headers ?? {})) scan(v);
  return [...found].sort();
}

function expandRecord(rec: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!rec) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(rec)) out[k] = expandVars(v);
  return out;
}

export function expandServerConfig(cfg: McpServerConfig): McpServerConfig {
  return {
    command: cfg.command !== undefined ? expandVars(cfg.command) : undefined,
    args: cfg.args?.map(expandVars),
    env: expandRecord(cfg.env),
    cwd: cfg.cwd !== undefined ? expandVars(cfg.cwd) : undefined,
    url: cfg.url !== undefined ? expandVars(cfg.url) : undefined,
    headers: expandRecord(cfg.headers),
    // Carried through verbatim: these are tool-name patterns, not values, and
    // dropping them here would silently expose a server's whole tool list.
    tools: cfg.tools,
  };
}

function isServerConfig(v: unknown): v is McpServerConfig {
  if (!v || typeof v !== "object") return false;
  const cfg = v as McpServerConfig;
  return typeof cfg.command === "string" || typeof cfg.url === "string";
}

/**
 * Read the workspace's `.mcp.json`. Malformed files and entries with neither
 * `command` nor `url` are skipped silently — a broken project file should
 * degrade to "no project servers", not break startup.
 */
export function loadProjectMcpServers(
  workspace: string
): Record<string, McpServerConfig> | undefined {
  let parsed: { mcpServers?: Record<string, unknown> };
  try {
    parsed = JSON.parse(fs.readFileSync(path.join(workspace, ".mcp.json"), "utf8"));
  } catch {
    return undefined;
  }
  if (!parsed?.mcpServers || typeof parsed.mcpServers !== "object") return undefined;
  const servers: Record<string, McpServerConfig> = {};
  for (const [name, cfg] of Object.entries(parsed.mcpServers)) {
    if (isServerConfig(cfg)) servers[name] = cfg;
  }
  return Object.keys(servers).length ? servers : undefined;
}

/**
 * Combine plugin, project, and global server definitions, expanding ${VAR} in
 * each. Precedence on a name clash: global wins over project, which wins over
 * a plugin -- a plugin is third-party-contributed, so anything the user or
 * the workspace declares explicitly takes priority.
 */
export function mergeMcpServers(
  global: Record<string, McpServerConfig> | undefined,
  project: Record<string, McpServerConfig> | undefined,
  plugin?: Record<string, McpServerConfig>
): Record<string, McpServerConfig> {
  const merged = { ...plugin, ...project, ...global };
  const out: Record<string, McpServerConfig> = {};
  for (const [name, cfg] of Object.entries(merged)) out[name] = expandServerConfig(cfg);
  return out;
}
