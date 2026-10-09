import assert from "node:assert/strict";
import { test } from "node:test";
import { isSlashCommandPrompt } from "../headless.js";

test("a slash command is recognised, however it is spaced", () => {
  assert.equal(isSlashCommandPrompt("/flow-brainstorm a habit tracker"), true);
  assert.equal(isSlashCommandPrompt("/help"), true);
  assert.equal(isSlashCommandPrompt("  /flow"), true);
  assert.equal(isSlashCommandPrompt("\t/project goto spec"), true);
});

test("ordinary prompts are not mistaken for commands", () => {
  assert.equal(isSlashCommandPrompt("brainstorm a habit tracker"), false);
  assert.equal(isSlashCommandPrompt(""), false);
  assert.equal(isSlashCommandPrompt("   "), false);
  // A path is not a command, even though it contains a slash.
  assert.equal(isSlashCommandPrompt("read src/ui/App.tsx and summarize it"), false);
  assert.equal(isSlashCommandPrompt("what does 1/2 + 1/3 equal?"), false);
});
