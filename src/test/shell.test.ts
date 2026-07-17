import assert from "node:assert";
import os from "node:os";
import { test } from "node:test";
import { backgroundManager } from "../shell/background.js";
import { matchesRule } from "../permissions/rules.js";
import { truncateTail } from "../tools/common.js";
import { shellTool } from "../tools/shell.js";
import type { ToolContext } from "../types.js";

const ctx: ToolContext = { workspace: os.tmpdir() };

test("truncateTail keeps the end of long output", () => {
  const s = "start" + "x".repeat(100) + "END";
  const out = truncateTail(s, 20);
  assert.ok(out.endsWith("END"));
  assert.match(out, /truncated/);
  assert.ok(!out.includes("start"));
});

test("shell honors timeout_seconds", async () => {
  const sleeper =
    os.platform() === "win32" ? "ping -n 6 127.0.0.1 >NUL" : "sleep 5";
  const start = Date.now();
  const out = await shellTool.execute({ command: sleeper, timeout_seconds: 1 }, ctx);
  assert.ok(Date.now() - start < 4000, "returned well before the 5s command finished");
  assert.match(out, /timed out after 1s/);
});

test("background process runs, reports output, and can be killed", async () => {
  const { id } = backgroundManager.start(
    `node -e "console.log('bg-hello'); setInterval(() => {}, 1000)"`,
    os.tmpdir()
  );
  await new Promise((r) => setTimeout(r, 800));
  const info = backgroundManager.read(id);
  assert.ok(info, "process is registered");
  assert.match(info!.output, /bg-hello/);
  assert.strictEqual(info!.running, true);
  assert.strictEqual(backgroundManager.kill(id), true);
  await new Promise((r) => setTimeout(r, 500));
  assert.strictEqual(backgroundManager.read(id)!.running, false);
});

test("shell background:true returns an id immediately", async () => {
  const out = await shellTool.execute(
    { command: `node -e "setTimeout(() => {}, 2000)"`, background: true },
    ctx
  );
  assert.match(out, /Started background process bg_\d+/);
  const idMatch = /bg_\d+/.exec(out);
  backgroundManager.kill(idMatch![0]);
});

test("allowlist rules match safely", () => {
  assert.ok(matchesRule("shell(npm test)", "shell", { command: "npm test" }));
  assert.ok(!matchesRule("shell(npm test)", "shell", { command: "npm test && rm -rf /" }));
  assert.ok(matchesRule("shell(git *)", "shell", { command: "git status" }));
  assert.ok(!matchesRule("shell(git *)", "shell", { command: "gitx danger" }));
  assert.ok(matchesRule("write_file", "write_file", { path: "a.txt" }));
  assert.ok(!matchesRule("write_file", "shell", { command: "rm x" }));
  assert.ok(!matchesRule("", "shell", { command: "ls" }));
});
