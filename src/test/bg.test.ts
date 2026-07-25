import assert from "node:assert/strict";
import os from "node:os";
import { test } from "node:test";
import { backgroundManager } from "../shell/background.js";
import { bgKillTool, bgOutputTool } from "../tools/bg.js";
import type { ToolContext } from "../types.js";

const ctx: ToolContext = { workspace: os.tmpdir() };

test("bg_output with no id lists every background process", async () => {
  const { id } = backgroundManager.start(`node -e "setInterval(() => {}, 1000)"`, os.tmpdir());
  try {
    const out = await bgOutputTool.execute({}, ctx);
    assert.match(out, new RegExp(id));
    assert.match(out, /running|exited/);
  } finally {
    backgroundManager.kill(id);
  }
});

test("bg_output reports a running process's captured output", async () => {
  const { id } = backgroundManager.start(
    `node -e "console.log('hello-from-bg'); setInterval(() => {}, 1000)"`,
    os.tmpdir()
  );
  try {
    await new Promise((r) => setTimeout(r, 500));
    const out = await bgOutputTool.execute({ id }, ctx);
    assert.match(out, /still running/);
    assert.match(out, /hello-from-bg/);
  } finally {
    backgroundManager.kill(id);
  }
});

test("bg_output reports an unknown id as an error", async () => {
  const out = await bgOutputTool.execute({ id: "bg_does_not_exist" }, ctx);
  assert.match(out, /Error: no background process "bg_does_not_exist"/);
});

test("bg_output reports the exit code once a process has finished", async () => {
  const { id } = backgroundManager.start(`node -e "process.exit(3)"`, os.tmpdir());
  await new Promise((r) => setTimeout(r, 500));
  const out = await bgOutputTool.execute({ id }, ctx);
  assert.match(out, /exited with code 3/);
});

test("bg_kill stops a running process", async () => {
  const { id } = backgroundManager.start(`node -e "setInterval(() => {}, 1000)"`, os.tmpdir());
  const out = await bgKillTool.execute({ id }, ctx);
  assert.match(out, new RegExp(`Sent SIGTERM to ${id}`));
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(backgroundManager.read(id)!.running, false);
});

test("bg_kill on an unknown or already-finished process reports an error", async () => {
  const out = await bgKillTool.execute({ id: "bg_does_not_exist" }, ctx);
  assert.match(out, /Error: "bg_does_not_exist" is not a running background process/);
});

test("summarize describes reading a specific process vs listing all", () => {
  assert.equal(bgOutputTool.summarize({ id: "bg_3" }), "Read output of bg_3");
  assert.equal(bgOutputTool.summarize({}), "List background processes");
});

test("bgKillTool.summarize names the process being killed", () => {
  assert.equal(bgKillTool.summarize({ id: "bg_9" }), "Kill background process bg_9");
});
