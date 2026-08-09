import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  pluginsDir,
  scanPlugins,
  scanPluginsDetailed,
  userPluginsDir,
} from "../plugins/discover.js";
import { defaultExtraSkillRoots, buildSkillsSection, scanSkills } from "../agent/skills.js";
import { loadPluginMcpServers, scanPluginMcpServers } from "../plugins/mcp.js";
import { mergeMcpServers } from "../mcp/servers.js";
import { loadCustomCommands } from "../commands/custom.js";
import { runCommand, type CommandContext } from "../commands/registry.js";
import type { Agent } from "../agent/loop.js";
import type { ItemBody } from "../types.js";

/**
 * Batch 7: a single fixture tree exercising every Agent Plugins path
 * together -- a fully valid plugin, a malformed manifest, an SSE-only MCP
 * entry, and a client-specific `com.vendor/` namespace folder -- instead of
 * each in isolation as the earlier per-batch unit tests do.
 */
function buildFixture(): string {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "kritya-plugins-integration-"));
  const root = pluginsDir(workspace);

  // A fully valid plugin: skills, mcp.json (one good server, one legacy-SSE
  // server that must be skipped), and a custom command.
  const goodDir = path.join(root, "finance-tools");
  fs.mkdirSync(path.join(goodDir, "skills", "ratio-analysis"), { recursive: true });
  fs.writeFileSync(
    path.join(goodDir, "plugin.json"),
    JSON.stringify({ name: "finance-tools", version: "1.0.0" })
  );
  fs.writeFileSync(
    path.join(goodDir, "skills", "ratio-analysis", "SKILL.md"),
    "---\nname: ratio-analysis\ndescription: Compute financial ratios\n---\n\nInstructions.\n"
  );
  fs.writeFileSync(
    path.join(goodDir, "mcp.json"),
    JSON.stringify({
      mcpServers: {
        ratios: { command: "node", args: ["server.js"] },
        legacy: { transport: "sse", url: "https://example.invalid/sse" },
      },
    })
  );
  fs.mkdirSync(path.join(goodDir, "commands"), { recursive: true });
  fs.writeFileSync(path.join(goodDir, "commands", "audit.md"), "Run a financial audit.\n");

  // A client-specific namespace folder inside the valid plugin -- per the
  // spec, portable clients ignore these; kritya never looks inside them
  // since it only reads known paths (skills/, mcp.json, commands/,
  // plugin.json), so this is here purely to prove it has no effect.
  fs.mkdirSync(path.join(goodDir, "com.example.other-client", "stuff"), { recursive: true });
  fs.writeFileSync(
    path.join(goodDir, "com.example.other-client", "config.json"),
    JSON.stringify({ some: "client-specific junk" })
  );

  // A malformed plugin: folder name doesn't match the manifest's name.
  const brokenDir = path.join(root, "broken-plugin");
  fs.mkdirSync(brokenDir, { recursive: true });
  fs.writeFileSync(
    path.join(brokenDir, "plugin.json"),
    JSON.stringify({ name: "not-the-folder-name", version: "1.0.0" })
  );

  return workspace;
}

test("Agent Plugins: a fixture tree with a valid plugin, a malformed manifest, an SSE-only server, and a com.vendor/ namespace resolves consistently across every subsystem", () => {
  const workspace = buildFixture();
  const prevHome = process.env.HOME;
  process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), "kritya-plugins-integration-home-"));

  try {
    // 1. Plugin manifest discovery: one loaded, one skipped with a reason.
    const { loaded, skipped } = scanPluginsDetailed([pluginsDir(workspace), userPluginsDir()]);
    assert.deepEqual(
      loaded.map((p) => p.name),
      ["finance-tools"]
    );
    assert.equal(skipped.length, 1);
    assert.equal(skipped[0].name, "broken-plugin");
    assert.match(skipped[0].reason, /does not match manifest name/);

    const plugins = scanPlugins([pluginsDir(workspace), userPluginsDir()]);
    assert.equal(plugins.length, 1);

    // 2. Skills: the plugin's skill is discovered and shows up in the system
    // prompt fragment; the com.vendor/ folder contributes nothing (it isn't
    // even a skills/ dir, so it's never looked at).
    const skillRoots = defaultExtraSkillRoots(workspace);
    const skills = scanSkills(skillRoots);
    assert.deepEqual(
      skills.map((s) => s.name),
      ["ratio-analysis"]
    );
    const section = buildSkillsSection(workspace);
    assert.match(section, /ratio-analysis: Compute financial ratios/);

    // 3. MCP: the good server loads, the legacy-SSE one is skipped with a
    // clear reason, and merging respects plugin-lowest precedence.
    const { loaded: mcpLoaded, skipped: mcpSkipped } = scanPluginMcpServers(plugins);
    assert.deepEqual(
      mcpLoaded.map((s) => s.name),
      ["ratios"]
    );
    assert.equal(mcpSkipped.length, 1);
    assert.match(mcpSkipped[0].reason, /legacy HTTP\+SSE transport is not supported/);

    const { servers: pluginServers, provenance } = loadPluginMcpServers(plugins, () => {});
    assert.equal(provenance.ratios, "finance-tools");
    const merged = mergeMcpServers(undefined, undefined, pluginServers);
    assert.deepEqual(Object.keys(merged), ["ratios"]);

    // 4. Commands: the plugin's command loads (workspace trusted), labeled
    // with its plugin name; it disappears if the workspace is untrusted.
    const commands = loadCustomCommands(workspace, true, plugins);
    const cmd = commands.find((c) => c.name === "/audit");
    assert.ok(cmd);
    assert.equal(cmd!.pluginName, "finance-tools");
    assert.equal(
      loadCustomCommands(workspace, false, plugins).find((c) => c.name === "/audit"),
      undefined
    );

    // 5. /plugins command output agrees with all of the above.
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

    return runCommand("/plugins", ctx).then(() => {
      assert.equal(said.length, 1);
      const text = said[0];
      assert.match(text, /finance-tools@1\.0\.0 \(workspace\)/);
      assert.match(text, /1 skill\(s\)/);
      assert.match(text, /1 MCP server\(s\)/);
      assert.match(text, /1 command\(s\)/);
      assert.match(
        text,
        /skipped MCP server\(s\): legacy \(legacy HTTP\+SSE transport is not supported\)/
      );
      assert.match(
        text,
        /broken-plugin\s+SKIPPED: folder name "broken-plugin" does not match manifest name "not-the-folder-name"/
      );
    });
  } finally {
    process.env.HOME = prevHome;
  }
});
