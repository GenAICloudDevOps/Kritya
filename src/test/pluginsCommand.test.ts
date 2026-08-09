import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { runCommand, type CommandContext } from "../commands/registry.js";
import type { Agent } from "../agent/loop.js";
import type { ItemBody } from "../types.js";
import { pluginsDir } from "../plugins/discover.js";

function harness(): { ctx: CommandContext; workspace: string; said: string[] } {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "kritya-plugins-cmd-"));
  const said: string[] = [];
  const ctx = {
    arg: "",
    raw: "/plugins",
    agent: {} as Agent,
    workspace,
    config: {},
    customCommands: [],
    mcpToolCount: 0,
    planMode: false,
    acceptEdits: false,
    addItem(item: ItemBody) {
      said.push("text" in item && typeof item.text === "string" ? item.text : "");
    },
    killed: false,
  } as unknown as CommandContext;
  return { ctx, workspace, said };
}

function withIsolatedHome<T>(fn: () => T): T {
  const prevHome = os.homedir();
  process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), "kritya-plugins-cmd-home-"));
  try {
    return fn();
  } finally {
    process.env.HOME = prevHome;
  }
}

function writeManifest(dir: string, manifest: Record<string, unknown>): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "plugin.json"), JSON.stringify(manifest));
}

test("/plugins reports none found when there are no plugin directories", () =>
  withIsolatedHome(async () => {
    const h = harness();
    await runCommand("/plugins", h.ctx);
    assert.equal(h.said.length, 1);
    assert.match(h.said[0], /No plugins found under/);
  }));

test("/plugins lists a workspace plugin's version, source, and contributions", () =>
  withIsolatedHome(async () => {
    const h = harness();
    const pluginDir = path.join(pluginsDir(h.workspace), "finance-tools");
    writeManifest(pluginDir, { name: "finance-tools", version: "1.2.0" });
    fs.mkdirSync(path.join(pluginDir, "skills", "ratio-analysis"), { recursive: true });
    fs.writeFileSync(
      path.join(pluginDir, "skills", "ratio-analysis", "SKILL.md"),
      "---\nname: ratio-analysis\ndescription: Compute ratios\n---\n\nBody.\n"
    );
    fs.writeFileSync(
      path.join(pluginDir, "mcp.json"),
      JSON.stringify({ mcpServers: { ratios: { command: "node", args: ["server.js"] } } })
    );
    fs.mkdirSync(path.join(pluginDir, "commands"), { recursive: true });
    fs.writeFileSync(path.join(pluginDir, "commands", "audit.md"), "Run an audit.\n");

    await runCommand("/plugins", h.ctx);
    assert.equal(h.said.length, 1);
    assert.match(h.said[0], /finance-tools@1\.2\.0 \(workspace\)/);
    assert.match(h.said[0], /1 skill\(s\)/);
    assert.match(h.said[0], /1 MCP server\(s\)/);
    assert.match(h.said[0], /1 command\(s\)/);
  }));

test("/plugins notes a plugin's skipped legacy-SSE MCP server", () =>
  withIsolatedHome(async () => {
    const h = harness();
    const pluginDir = path.join(pluginsDir(h.workspace), "old-tools");
    writeManifest(pluginDir, { name: "old-tools", version: "1.0.0" });
    fs.writeFileSync(
      path.join(pluginDir, "mcp.json"),
      JSON.stringify({ mcpServers: { legacy: { transport: "sse", url: "https://x/sse" } } })
    );

    await runCommand("/plugins", h.ctx);
    assert.equal(h.said.length, 1);
    assert.match(h.said[0], /legacy HTTP\+SSE transport is not supported/);
  }));

test("/plugins reports why a malformed plugin was skipped", () =>
  withIsolatedHome(async () => {
    const h = harness();
    writeManifest(path.join(pluginsDir(h.workspace), "broken"), {
      name: "wrong-name",
      version: "1.0.0",
    });
    await runCommand("/plugins", h.ctx);
    assert.equal(h.said.length, 1);
    assert.match(
      h.said[0],
      /broken\s+SKIPPED: folder name "broken" does not match manifest name "wrong-name"/
    );
  }));
