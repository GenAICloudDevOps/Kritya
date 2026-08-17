import assert from "node:assert/strict";
import { test } from "node:test";
import { runCommand, type CommandContext } from "../commands/registry.js";
import type { ItemBody } from "../types.js";

/** A minimal CommandContext stub — `/commit` only reads a handful of fields. */
function harness(overrides: Partial<CommandContext> = {}) {
  const prompts: string[] = [];
  const said: string[] = [];
  const ctx = {
    arg: "",
    raw: "/commit",
    provider: "nvidia",
    model: "qwen/qwen3-coder-480b-a35b-instruct",
    config: {},
    killed: false,
    addItem(item: ItemBody) {
      said.push("text" in item && typeof item.text === "string" ? item.text : "");
    },
    async runAgent(text: string) {
      prompts.push(text);
    },
    ...overrides,
  } as unknown as CommandContext;
  return { ctx, prompts, said };
}

test("/commit asks the agent to add a Generated-By trailer by default", async () => {
  const { ctx, prompts } = harness();
  await runCommand("/commit", ctx);
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /Generated-By: kritya \(nvidia\/qwen\/qwen3-coder-480b-a35b-instruct\)/);
});

test("/commit omits the trailer instruction when commitAttribution is false", async () => {
  const { ctx, prompts } = harness({ config: { commitAttribution: false } });
  await runCommand("/commit", ctx);
  assert.equal(prompts.length, 1);
  assert.doesNotMatch(prompts[0], /Generated-By/);
});
