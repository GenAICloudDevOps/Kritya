import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { scanPluginMcpServers, loadPluginMcpServers } from "../plugins/mcp.js";
import { mergeMcpServers } from "../mcp/servers.js";
import type { DiscoveredPlugin } from "../plugins/discover.js";

function tmpWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "kritya-plugins-mcp-test-"));
}

function writePluginMcp(dir: string, mcpServers: Record<string, unknown>): DiscoveredPlugin {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "mcp.json"), JSON.stringify({ mcpServers }));
  return { name: path.basename(dir), dir, manifest: {} };
}

test("scanPluginMcpServers loads a valid stdio server from a plugin's mcp.json", () => {
  const root = tmpWorkspace();
  const plugin = writePluginMcp(path.join(root, "finance-tools"), {
    ratios: { command: "node", args: ["server.js"] },
  });
  const { loaded, skipped } = scanPluginMcpServers([plugin]);
  assert.equal(skipped.length, 0);
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].name, "ratios");
  assert.equal(loaded[0].pluginName, "finance-tools");
  assert.equal(loaded[0].cfg.command, "node");
});

test("scanPluginMcpServers loads a valid remote (Streamable HTTP) server", () => {
  const root = tmpWorkspace();
  const plugin = writePluginMcp(path.join(root, "linear-tools"), {
    linear: { url: "https://mcp.linear.app/mcp" },
  });
  const { loaded } = scanPluginMcpServers([plugin]);
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].cfg.url, "https://mcp.linear.app/mcp");
});

test("scanPluginMcpServers skips a legacy HTTP+SSE entry with a clear reason", () => {
  const root = tmpWorkspace();
  const plugin = writePluginMcp(path.join(root, "old-tools"), {
    legacy: { transport: "sse", url: "https://example.invalid/sse" },
  });
  const { loaded, skipped } = scanPluginMcpServers([plugin]);
  assert.equal(loaded.length, 0);
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].name, "legacy");
  assert.equal(skipped[0].pluginName, "old-tools");
  assert.match(skipped[0].reason, /legacy HTTP\+SSE transport is not supported/);
});

test("scanPluginMcpServers skips an entry with neither command nor url", () => {
  const root = tmpWorkspace();
  const plugin = writePluginMcp(path.join(root, "broken-tools"), {
    nothing: { foo: "bar" },
  });
  const { loaded, skipped } = scanPluginMcpServers([plugin]);
  assert.equal(loaded.length, 0);
  assert.equal(skipped.length, 1);
  assert.match(skipped[0].reason, /must include "command" or "url"/);
});

test("scanPluginMcpServers ignores plugins with no mcp.json", () => {
  const root = tmpWorkspace();
  const dir = path.join(root, "no-mcp");
  fs.mkdirSync(dir, { recursive: true });
  const plugin: DiscoveredPlugin = { name: "no-mcp", dir, manifest: {} };
  const { loaded, skipped } = scanPluginMcpServers([plugin]);
  assert.equal(loaded.length, 0);
  assert.equal(skipped.length, 0);
});

test("scanPluginMcpServers keeps the first plugin's server on a name clash across plugins", () => {
  const root = tmpWorkspace();
  const a = writePluginMcp(path.join(root, "plugin-a"), { shared: { command: "a-bin" } });
  const b = writePluginMcp(path.join(root, "plugin-b"), { shared: { command: "b-bin" } });
  const { loaded, skipped } = scanPluginMcpServers([a, b]);
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].cfg.command, "a-bin");
  assert.equal(skipped.length, 1);
  assert.match(skipped[0].reason, /duplicate server name "shared"/);
});

test("loadPluginMcpServers returns merge-ready servers plus a name->plugin provenance map, warning on skips", () => {
  const root = tmpWorkspace();
  const plugin = writePluginMcp(path.join(root, "finance-tools"), {
    ratios: { command: "node", args: ["server.js"] },
    legacy: { transport: "sse", url: "https://example.invalid/sse" },
  });
  const warnings: string[] = [];
  const { servers, provenance } = loadPluginMcpServers([plugin], (m) => warnings.push(m));
  assert.deepEqual(Object.keys(servers), ["ratios"]);
  assert.equal(servers.ratios.command, "node");
  assert.equal(provenance.ratios, "finance-tools");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /legacy HTTP\+SSE transport is not supported/);
});

test("mergeMcpServers gives plugin servers lowest precedence: project beats plugin, global beats project", () => {
  const merged = mergeMcpServers(
    { shared: { command: "global-bin" } },
    { shared: { command: "project-bin" }, projectOnly: { command: "p" } },
    { shared: { command: "plugin-bin" }, pluginOnly: { command: "pl" } }
  );
  assert.equal(merged.shared.command, "global-bin");
  assert.equal(merged.projectOnly.command, "p");
  assert.equal(merged.pluginOnly.command, "pl");
});
