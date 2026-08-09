import fs from "node:fs";
import path from "node:path";
import type { McpServerConfig } from "../config/config.js";
import type { DiscoveredPlugin } from "./discover.js";

export interface PluginMcpServer {
  name: string;
  pluginName: string;
  cfg: McpServerConfig;
}

export interface SkippedPluginMcpServer {
  pluginName: string;
  name: string;
  reason: string;
}

export interface PluginMcpScanResult {
  loaded: PluginMcpServer[];
  skipped: SkippedPluginMcpServer[];
}

function isServerConfig(v: unknown): v is McpServerConfig {
  if (!v || typeof v !== "object") return false;
  const cfg = v as McpServerConfig;
  return typeof cfg.command === "string" || typeof cfg.url === "string";
}

/**
 * Reads each plugin's mcp.json (same `{ mcpServers: { name: config } }` shape
 * as a workspace's .mcp.json). Entries requesting the legacy HTTP+SSE
 * transport are skipped with a reason -- kritya's MCP client only speaks
 * stdio and Streamable HTTP, and that older transport is deprecated in the
 * spec itself.
 */
export function scanPluginMcpServers(plugins: DiscoveredPlugin[]): PluginMcpScanResult {
  const loaded: PluginMcpServer[] = [];
  const skipped: SkippedPluginMcpServer[] = [];
  const seen = new Set<string>();
  for (const plugin of plugins) {
    let parsed: { mcpServers?: Record<string, unknown> };
    try {
      parsed = JSON.parse(fs.readFileSync(path.join(plugin.dir, "mcp.json"), "utf8"));
    } catch {
      continue;
    }
    if (!parsed?.mcpServers || typeof parsed.mcpServers !== "object") continue;
    for (const [name, raw] of Object.entries(parsed.mcpServers)) {
      if (seen.has(name)) {
        skipped.push({
          pluginName: plugin.name,
          name,
          reason: `duplicate server name "${name}" (already loaded from another plugin)`,
        });
        continue;
      }
      const entry = raw as Record<string, unknown> | null;
      if (entry?.transport === "sse" || entry?.type === "sse") {
        skipped.push({
          pluginName: plugin.name,
          name,
          reason: "legacy HTTP+SSE transport is not supported",
        });
        continue;
      }
      if (!isServerConfig(raw)) {
        skipped.push({
          pluginName: plugin.name,
          name,
          reason: 'must include "command" or "url"',
        });
        continue;
      }
      seen.add(name);
      loaded.push({ name, pluginName: plugin.name, cfg: raw });
    }
  }
  return { loaded, skipped };
}

/**
 * Same scan as scanPluginMcpServers, but returns merge-ready shapes: a plain
 * name->config map for mergeMcpServers, and a name->plugin-name provenance
 * map for labeling `/mcp` output. Skips are reported via `warn` (defaults to
 * stderr, like scanPlugins/scanSkills).
 */
export function loadPluginMcpServers(
  plugins: DiscoveredPlugin[],
  warn: (message: string) => void = (m) => process.stderr.write(`kritya: ${m}\n`)
): { servers: Record<string, McpServerConfig>; provenance: Record<string, string> } {
  const { loaded, skipped } = scanPluginMcpServers(plugins);
  for (const s of skipped) {
    warn(`skipping mcp server "${s.name}" from plugin "${s.pluginName}": ${s.reason}`);
  }
  const servers: Record<string, McpServerConfig> = {};
  const provenance: Record<string, string> = {};
  for (const s of loaded) {
    servers[s.name] = s.cfg;
    provenance[s.name] = s.pluginName;
  }
  return { servers, provenance };
}
