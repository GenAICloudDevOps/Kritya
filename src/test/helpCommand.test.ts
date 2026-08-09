import assert from "node:assert/strict";
import { test } from "node:test";
import { runCommand, type CommandContext } from "../commands/registry.js";
import type { ItemBody } from "../types.js";

function harness(customCommands: CommandContext["customCommands"]): {
  ctx: CommandContext;
  said: string[];
} {
  const said: string[] = [];
  const ctx = {
    arg: "",
    raw: "/help",
    customCommands,
    mcpToolCount: 0,
    addItem(item: ItemBody) {
      said.push("text" in item && typeof item.text === "string" ? item.text : "");
    },
  } as unknown as CommandContext;
  return { ctx, said };
}

test("/help labels a plugin-contributed custom command with its plugin name", async () => {
  const { ctx, said } = harness([
    { name: "/deploy", description: "ship it", body: "", pluginName: "deploy-tools" },
  ]);
  await runCommand("/help", ctx);
  assert.equal(said.length, 1);
  assert.match(said[0], /\/deploy\s+ship it \(plugin: deploy-tools\)/);
});

test("/help does not annotate a plain workspace-declared custom command", async () => {
  const { ctx, said } = harness([{ name: "/deploy", description: "ship it", body: "" }]);
  await runCommand("/help", ctx);
  assert.equal(said.length, 1);
  assert.match(said[0], /\/deploy\s+ship it$/);
  assert.doesNotMatch(said[0], /plugin:/);
});
