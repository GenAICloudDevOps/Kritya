import assert from "node:assert/strict";
import { test } from "node:test";
import { runCommand, type CommandContext } from "../commands/registry.js";
import type { ItemBody } from "../types.js";

test("/clear resets the agent, clears tasks, and clears the visible transcript", async () => {
  const calls: string[] = [];
  const said: string[] = [];
  const agent = {
    reset() {
      calls.push("agent.reset");
    },
  };
  const ctx = {
    arg: "",
    raw: "/clear",
    agent,
    setTasks(tasks: unknown[]) {
      calls.push(`setTasks:${tasks.length}`);
    },
    clearItems() {
      calls.push("clearItems");
    },
    addItem(item: ItemBody) {
      said.push("text" in item && typeof item.text === "string" ? item.text : "");
    },
  } as unknown as CommandContext;

  await runCommand("/clear", ctx);

  assert.deepEqual(calls, ["agent.reset", "setTasks:0", "clearItems"]);
  assert.deepEqual(said, ["Conversation cleared."]);
});
