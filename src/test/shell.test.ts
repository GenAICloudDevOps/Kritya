import assert from "node:assert";
import os from "node:os";
import { test } from "node:test";
import { backgroundManager } from "../shell/background.js";
import { matchesRule } from "../permissions/rules.js";
import { truncateTail } from "../tools/common.js";
import { shellTool } from "../tools/shell.js";
import type { ToolContext } from "../types.js";

const ctx: ToolContext = { workspace: os.tmpdir() };

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
  }
}

test("truncateTail keeps the end of long output", () => {
  const s = "start" + "x".repeat(100) + "END";
  const out = truncateTail(s, 20);
  assert.ok(out.endsWith("END"));
  assert.match(out, /truncated/);
  assert.ok(!out.includes("start"));
});

test("shell blocks commands that reference a sensitive file by name", async () => {
  await assert.rejects(
    async () => shellTool.execute({ command: "cat .env" }, ctx),
    /looks like a secret file/
  );
  await assert.rejects(
    async () => shellTool.execute({ command: "grep DATABASE_URL .env" }, ctx),
    /looks like a secret file/
  );
  await assert.rejects(
    async () => shellTool.execute({ command: "cat ~/.ssh/id_rsa" }, ctx),
    /looks like a secret file/
  );
});

test("shell does not block ordinary commands that merely mention 'secret' as a word", async () => {
  const out = await shellTool.execute({ command: "echo hello" }, ctx);
  assert.match(out, /hello/);
});

test("shell honors timeout_seconds", async () => {
  const sleeper = os.platform() === "win32" ? "ping -n 6 127.0.0.1 >NUL" : "sleep 5";
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
  await waitFor(() => backgroundManager.read(id)?.output.includes("bg-hello") ?? false);
  const info = backgroundManager.read(id);
  assert.ok(info, "process is registered");
  assert.match(info!.output, /bg-hello/);
  assert.strictEqual(info!.running, true);
  assert.strictEqual(backgroundManager.kill(id), true);
  // Process exit is reported asynchronously via the child's exit/close
  // event, and Windows in particular can take well over 500ms to deliver
  // it under CI load — poll instead of a fixed sleep so this isn't flaky.
  const deadline = Date.now() + 5000;
  while (backgroundManager.read(id)!.running && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
  }
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

test("shell summarize redacts secrets so they never reach the audit log/telemetry", () => {
  const summary = shellTool.summarize({
    command: `curl -H "Authorization: token=sk-ant-abcdefghijklmnopqrstuvwx" https://example.com`,
  });
  assert.ok(!summary.includes("sk-ant-abcdefghijklmnopqrstuvwx"), summary);
  assert.match(summary, /redacted/i);
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
