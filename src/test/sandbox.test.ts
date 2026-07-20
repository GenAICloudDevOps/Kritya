import assert from "node:assert/strict";
import os from "node:os";
import { test } from "node:test";
import { buildSandboxedCommand, sandboxAvailable, shouldSandbox } from "../shell/sandbox.js";
import { shellTool } from "../tools/shell.js";
import type { ToolContext } from "../types.js";

test("shouldSandbox: off never sandboxes", () => {
  assert.equal(shouldSandbox("off", "rm -rf /tmp/x"), false);
  assert.equal(shouldSandbox(undefined, "rm -rf /tmp/x"), false);
});

test("shouldSandbox: always sandboxes everything", () => {
  assert.equal(shouldSandbox("always", "npm test"), true);
  assert.equal(shouldSandbox("always", "rm -rf /tmp/x"), true);
});

test("shouldSandbox: auto only sandboxes destructive commands", () => {
  assert.equal(shouldSandbox("auto", "npm test"), false);
  assert.equal(shouldSandbox("auto", "git status"), false);
  assert.equal(shouldSandbox("auto", "rm -rf /tmp/x"), true);
  assert.equal(shouldSandbox("auto", "git push --force origin main"), true);
});

test("buildSandboxedCommand returns null when unavailable, else a runnable wrapper", () => {
  const wrapped = buildSandboxedCommand("echo hi", os.tmpdir());
  if (!sandboxAvailable()) {
    assert.equal(wrapped, null);
    return;
  }
  assert.ok(wrapped);
  assert.ok(wrapped!.cmd.length > 0);
  assert.ok(wrapped!.args.includes("echo hi"));
});

test("shell tool sandboxes destructive commands in auto mode when available, else falls back with a note", async (t) => {
  if (os.platform() === "win32") {
    t.skip("no sandbox support on Windows");
    return;
  }
  const ctx: ToolContext = { workspace: os.tmpdir(), sandboxMode: "auto" };
  const out = await shellTool.execute({ command: "echo destructive-marker; rm -rf" }, ctx);
  if (!sandboxAvailable()) {
    assert.match(out, /sandbox unavailable/);
  } else {
    assert.match(out, /destructive-marker/);
  }
});

test("shell tool leaves ordinary commands unsandboxed in auto mode", async () => {
  const ctx: ToolContext = { workspace: os.tmpdir(), sandboxMode: "auto" };
  const out = await shellTool.execute({ command: "echo plain-run" }, ctx);
  assert.match(out, /plain-run/);
  assert.doesNotMatch(out, /sandbox unavailable/);
});

test("sandboxed command can write inside the workspace but is blocked outside it", async (t) => {
  if (!sandboxAvailable()) {
    t.skip("no sandbox binary on this machine");
    return;
  }
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "kritya-sandbox-test-"));
  const ctx: ToolContext = { workspace, sandboxMode: "always" };

  const inside = await shellTool.execute({ command: "echo ok > inside.txt" }, ctx);
  assert.doesNotMatch(inside, /sandbox unavailable/);
  assert.ok(await fs.readFile(path.join(workspace, "inside.txt"), "utf8"));

  // Outside both the workspace and the (sandbox-writable) system temp dir —
  // this is the write the sandbox exists to block.
  const outsideTarget = path.join(os.homedir(), `kritya-sandbox-outside-${Date.now()}.txt`);
  try {
    await shellTool.execute({ command: `echo bad > "${outsideTarget}"` }, ctx);
    await assert.rejects(fs.access(outsideTarget));
  } finally {
    await fs.rm(outsideTarget, { force: true });
    await fs.rm(workspace, { recursive: true, force: true });
  }
});
