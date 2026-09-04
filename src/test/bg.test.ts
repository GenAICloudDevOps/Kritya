import assert from "node:assert/strict";
import os from "node:os";
import { test } from "node:test";
import { backgroundManager } from "../shell/background.js";
import { sandboxAvailable } from "../shell/sandbox.js";
import { bgKillTool, bgOutputTool } from "../tools/bg.js";
import type { ToolContext } from "../types.js";

const ctx: ToolContext = { workspace: os.tmpdir() };

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
  }
}

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
    await waitFor(() => backgroundManager.read(id)?.output.includes("hello-from-bg") ?? false);
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
  await waitFor(() => backgroundManager.read(id)?.running === false);
  const out = await bgOutputTool.execute({ id }, ctx);
  assert.match(out, /exited with code 3/);
});

test("bg_kill stops a running process", async () => {
  const { id } = backgroundManager.start(`node -e "setInterval(() => {}, 1000)"`, os.tmpdir());
  const out = await bgKillTool.execute({ id }, ctx);
  assert.match(out, new RegExp(`Sent SIGTERM to ${id}`));
  await waitFor(() => backgroundManager.read(id)?.running === false);
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

test("background process is sandboxed when sandboxMode requests it and writes outside the workspace are blocked", async () => {
  if (!sandboxAvailable() || os.platform() === "win32") return;
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "kritya-bg-sandbox-test-"));
  const outsideTarget = path.join(os.homedir(), `kritya-bg-sandbox-outside-${Date.now()}.txt`);
  const { id } = backgroundManager.start(
    `echo bad > "${outsideTarget}" ; sleep 1`,
    workspace,
    "always"
  );
  try {
    await new Promise((r) => setTimeout(r, 500));
    await assert.rejects(fs.access(outsideTarget));
  } finally {
    backgroundManager.kill(id);
    await fs.rm(outsideTarget, { force: true });
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("background process without a sandboxMode runs unsandboxed, unchanged from today", async () => {
  const { id } = backgroundManager.start(`node -e "console.log('bg-plain')"`, os.tmpdir());
  await waitFor(() => backgroundManager.read(id)?.output.includes("bg-plain") ?? false);
  const info = backgroundManager.read(id);
  assert.match(info!.output, /bg-plain/);
});

test("bg_output redacts secrets from a background process's captured output", async () => {
  const { id } = backgroundManager.start(
    `node -e "console.log('AKIAABCDEFGHIJKLMNOP')"`,
    os.tmpdir()
  );
  try {
    await waitFor(() => backgroundManager.read(id)?.output.length !== 0);
    const out = await bgOutputTool.execute({ id }, ctx);
    assert.doesNotMatch(out, /AKIAABCDEFGHIJKLMNOP/);
    assert.match(out, /REDACTED/);
  } finally {
    backgroundManager.kill(id);
  }
});

test("bg_output keeps the status header even when the output is truncated", async () => {
  // Far more than truncateTail's 10k budget, so a header folded into the
  // truncated string would be cut away along with the head of the output.
  const { id } = backgroundManager.start(
    `node -e "console.log('x'.repeat(40000)); setInterval(() => {}, 1000)"`,
    os.tmpdir()
  );
  try {
    await waitFor(() => (backgroundManager.read(id)?.output.length ?? 0) >= 40_000);
    const out = await bgOutputTool.execute({ id }, ctx);
    assert.match(out, new RegExp(`^Process ${id} \\(.*\\) — still running`, "m"));
    assert.ok(out.includes("truncated") || out.length < 40000);
  } finally {
    backgroundManager.kill(id);
  }
});

test("bg_output redacts secrets from the command in both the listing and the header", async () => {
  const { id } = backgroundManager.start(
    `node -e "setInterval(() => {}, 1000)" # AKIAABCDEFGHIJKLMNOP`,
    os.tmpdir()
  );
  try {
    const listed = await bgOutputTool.execute({}, ctx);
    assert.doesNotMatch(listed, /AKIAABCDEFGHIJKLMNOP/);
    const single = await bgOutputTool.execute({ id }, ctx);
    assert.doesNotMatch(single, /AKIAABCDEFGHIJKLMNOP/);
  } finally {
    backgroundManager.kill(id);
  }
});
