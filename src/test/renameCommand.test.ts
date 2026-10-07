import assert from "node:assert/strict";
import { test } from "node:test";
import { runCommand, type CommandContext } from "../commands/registry.js";
import type { ItemBody } from "../types.js";

function makeCtx(arg: string, agent: object) {
  const said: string[] = [];
  const ctx = {
    arg,
    raw: `/rename${arg ? ` ${arg}` : ""}`,
    agent,
    addItem(item: ItemBody) {
      said.push("text" in item && typeof item.text === "string" ? item.text : "");
    },
  } as unknown as CommandContext;
  return { ctx, said };
}

test("/rename with a name renames the session and says how to resume it", async () => {
  const agent = {
    renameSession(name: string) {
      assert.equal(name, "Fix the signup flow");
      return "fix-the-signup-flow";
    },
  };
  const { ctx, said } = makeCtx("Fix the signup flow", agent);

  await runCommand("/rename", ctx);

  assert.deepEqual(said, [
    'Session renamed to "fix-the-signup-flow". Resume it later with: kritya -r fix-the-signup-flow',
  ]);
});

test("/rename with no name shows the current session name", async () => {
  const agent = {
    sessionName() {
      return "fix-the-login-bug";
    },
  };
  const { ctx, said } = makeCtx("", agent);

  await runCommand("/rename", ctx);

  assert.deepEqual(said, ['This session is named "fix-the-login-bug".']);
});

test("/rename explains when the name has nothing usable in it", async () => {
  const agent = {
    renameSession() {
      return undefined;
    },
  };
  const { ctx, said } = makeCtx("!!!", agent);

  await runCommand("/rename", ctx);

  assert.deepEqual(said, [`Couldn't make a session name out of "!!!" — try letters and numbers.`]);
});
