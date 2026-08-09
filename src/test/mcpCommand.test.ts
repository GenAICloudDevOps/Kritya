import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { resolveServer, runMcpCommand } from "../commands/mcpCommand.js";
import type { CommandContext } from "../commands/registry.js";
import type { Agent } from "../agent/loop.js";
import { forgetStatus, replaceStatus } from "../mcp/client.js";
import { pluginsDir } from "../plugins/discover.js";

/**
 * These tests deliberately stay on branches of mcpCommand.ts that never call
 * saveConfig() or touch the network: /mcp add|remove|login|logout all read the
 * user's real ~/.kritya/config.json (CONFIG_DIR isn't overridable per-test),
 * so only the validation/usage/"not found" paths — which return before any
 * write — are safe to exercise here without risking the developer's real
 * config or making a live connection attempt.
 */
function workspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kritya-mcp-cmd-test-"));
  return dir;
}

function fakeCtx(overrides: Partial<CommandContext> & { workspace: string }): CommandContext {
  const items: unknown[] = [];
  const base: Partial<CommandContext> = {
    arg: "",
    addItem: (item) => {
      items.push(item);
    },
    agent: { removeTools: () => 0, addTools: () => {} } as unknown as Agent,
    setActivity: () => {},
  };
  const ctx = { ...base, ...overrides } as CommandContext;
  (ctx as unknown as { _items: unknown[] })._items = items;
  return ctx;
}

function lastText(ctx: CommandContext): string {
  const items = (ctx as unknown as { _items: { text?: string }[] })._items;
  return items[items.length - 1]?.text ?? "";
}

test("resolveServer finds a server declared in the workspace's .mcp.json", () => {
  const ws = workspace();
  fs.writeFileSync(
    path.join(ws, ".mcp.json"),
    JSON.stringify({ mcpServers: { "kritya-test-server": { url: "https://example.invalid/mcp" } } })
  );
  const resolved = resolveServer("kritya-test-server", ws);
  assert.ok(resolved);
  assert.equal(resolved!.provenance, "project");
  assert.equal(resolved!.cfg.url, "https://example.invalid/mcp");
});

test("resolveServer returns undefined for a name declared nowhere", () => {
  const ws = workspace();
  assert.equal(resolveServer("kritya-test-definitely-nowhere-xyz", ws), undefined);
});

test("/mcp with an unknown subcommand shows the usage text", async () => {
  const ctx = fakeCtx({ arg: "not-a-real-subcommand", workspace: workspace() });
  await runMcpCommand(ctx);
  assert.match(lastText(ctx), /Unknown \/mcp subcommand/);
  assert.match(lastText(ctx), /Usage:/);
});

test("/mcp add with no arguments shows usage", async () => {
  const ctx = fakeCtx({ arg: "add", workspace: workspace() });
  await runMcpCommand(ctx);
  assert.match(lastText(ctx), /Usage: \/mcp add/);
});

test("/mcp add rejects a server name with invalid characters", async () => {
  const ctx = fakeCtx({ arg: "add bad!name https://example.invalid", workspace: workspace() });
  await runMcpCommand(ctx);
  assert.match(lastText(ctx), /Invalid server name/);
});

test("/mcp add rejects a malformed URL", async () => {
  const ctx = fakeCtx({ arg: "add mytool not-a-valid-url", workspace: workspace() });
  await runMcpCommand(ctx);
  assert.match(lastText(ctx), /not a valid URL/);
});

test("/mcp add refuses plain http for a non-loopback host", async () => {
  const ctx = fakeCtx({ arg: "add mytool http://example.invalid/mcp", workspace: workspace() });
  await runMcpCommand(ctx);
  assert.match(lastText(ctx), /Refusing to add/);
});

test("/mcp remove with no name shows usage", async () => {
  const ctx = fakeCtx({ arg: "remove", workspace: workspace() });
  await runMcpCommand(ctx);
  assert.match(lastText(ctx), /Usage: \/mcp remove/);
});

test("/mcp remove for a name that exists nowhere reports there's nothing to remove", async () => {
  const ctx = fakeCtx({
    arg: "remove kritya-test-remove-nowhere-xyz",
    workspace: workspace(),
  });
  await runMcpCommand(ctx);
  assert.match(lastText(ctx), /No server named/);
});

test("/mcp remove for a project-declared (not user-config) server points at .mcp.json", async () => {
  const ws = workspace();
  fs.writeFileSync(
    path.join(ws, ".mcp.json"),
    JSON.stringify({
      mcpServers: { "kritya-test-project-only": { url: "https://example.invalid/mcp" } },
    })
  );
  const ctx = fakeCtx({ arg: "remove kritya-test-project-only", workspace: ws });
  await runMcpCommand(ctx);
  assert.match(lastText(ctx), /this workspace's \.mcp\.json/);
});

test("/mcp login with no name shows usage", async () => {
  const ctx = fakeCtx({ arg: "login", workspace: workspace() });
  await runMcpCommand(ctx);
  assert.match(lastText(ctx), /Usage: \/mcp login/);
});

test("/mcp login for an unknown server reports it can't be found", async () => {
  const ctx = fakeCtx({ arg: "login kritya-test-login-nowhere-xyz", workspace: workspace() });
  await runMcpCommand(ctx);
  assert.match(lastText(ctx), /No server named/);
});

test("/mcp login for a local (stdio) server explains there's nothing to log in to", async () => {
  const ws = workspace();
  fs.writeFileSync(
    path.join(ws, ".mcp.json"),
    JSON.stringify({ mcpServers: { "kritya-test-stdio": { command: "echo", args: ["hi"] } } })
  );
  const ctx = fakeCtx({ arg: "login kritya-test-stdio", workspace: ws });
  await runMcpCommand(ctx);
  assert.match(lastText(ctx), /nothing to log in to/);
});

test("/mcp logout with no name shows usage", async () => {
  const ctx = fakeCtx({ arg: "logout", workspace: workspace() });
  await runMcpCommand(ctx);
  assert.match(lastText(ctx), /Usage: \/mcp logout/);
});

test("/mcp logout for an unknown remote server reports nothing to log out of", async () => {
  const ctx = fakeCtx({ arg: "logout kritya-test-logout-nowhere-xyz", workspace: workspace() });
  await runMcpCommand(ctx);
  assert.match(lastText(ctx), /No remote server named/);
});

test("/mcp code with missing name or code shows usage", async () => {
  const ctx = fakeCtx({ arg: "code", workspace: workspace() });
  await runMcpCommand(ctx);
  assert.match(lastText(ctx), /Usage: \/mcp code/);
});

test("/mcp code for a server with no login in progress says so", async () => {
  const ctx = fakeCtx({
    arg: "code kritya-test-no-pending-login-xyz some-code",
    workspace: workspace(),
  });
  await runMcpCommand(ctx);
  assert.match(lastText(ctx), /No login in progress/);
});

test("/mcp trust revoke for a name that was never trusted has nothing to revoke", async () => {
  const ctx = fakeCtx({
    arg: "trust revoke kritya-test-never-trusted-xyz",
    workspace: workspace(),
  });
  await runMcpCommand(ctx);
  assert.match(lastText(ctx), /isn't in the trust list/);
});

test("/mcp trust with an unrecognized sub-action shows usage", async () => {
  const ctx = fakeCtx({ arg: "trust not-a-real-action", workspace: workspace() });
  await runMcpCommand(ctx);
  assert.match(lastText(ctx), /Usage: \/mcp trust/);
});

test("/mcp status labels a server contributed by a plugin with its plugin name", async () => {
  const ws = workspace();
  const pluginDir = path.join(pluginsDir(ws), "finance-tools");
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(
    path.join(pluginDir, "plugin.json"),
    JSON.stringify({ name: "finance-tools", version: "1.0.0" })
  );
  fs.writeFileSync(
    path.join(pluginDir, "mcp.json"),
    JSON.stringify({ mcpServers: { ratios: { command: "node", args: ["server.js"] } } })
  );
  replaceStatus({
    name: "ratios",
    transport: "stdio",
    target: "node server.js",
    ok: true,
    tools: [],
    prompts: [],
    resources: [],
  });
  try {
    const ctx = fakeCtx({ arg: "", workspace: ws });
    await runMcpCommand(ctx);
    assert.match(lastText(ctx), /ratios \(stdio\) \(plugin: finance-tools\)/);
  } finally {
    forgetStatus("ratios");
  }
});
