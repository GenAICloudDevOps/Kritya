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

test("shouldSandbox: auto sandboxes every command on platforms with a sandbox binary", () => {
  if (os.platform() === "win32") {
    // No sandbox binary exists on Windows — auto must not claim otherwise,
    // or every command would show a spurious "[sandbox unavailable]" note.
    assert.equal(shouldSandbox("auto", "npm test"), false);
    assert.equal(shouldSandbox("auto", "rm -rf /tmp/x"), true); // still flagged via classifyDanger fallback
    assert.equal(shouldSandbox("always", "npm test"), true);
    return;
  }
  assert.equal(shouldSandbox("auto", "npm test"), true);
  assert.equal(shouldSandbox("auto", "git status"), true);
  assert.equal(shouldSandbox("auto", "rm -rf /tmp/x"), true);
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

test("sandboxed non-destructive command can still write inside the workspace", async () => {
  if (!sandboxAvailable()) return;
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "kritya-sandbox-test-"));
  const ctx: ToolContext = { workspace, sandboxMode: "auto" };
  const out = await shellTool.execute({ command: "echo ok > inside.txt" }, ctx);
  assert.doesNotMatch(out, /sandbox unavailable/);
  assert.ok(await fs.readFile(path.join(workspace, "inside.txt"), "utf8"));
  await fs.rm(workspace, { recursive: true, force: true });
});

test("sandbox allows writes to known package-manager cache dirs outside the workspace", async () => {
  if (!sandboxAvailable() || os.platform() === "win32") return;
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const cacheDir = path.join(os.homedir(), ".npm");
  await fs.mkdir(cacheDir, { recursive: true });
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "kritya-sandbox-test-"));
  const ctx: ToolContext = { workspace, sandboxMode: "auto" };
  const target = path.join(cacheDir, `kritya-sandbox-cache-test-${Date.now()}.txt`);
  try {
    const out = await shellTool.execute({ command: `echo ok > "${target}"` }, ctx);
    assert.doesNotMatch(out, /sandbox unavailable/);
    assert.ok(await fs.readFile(target, "utf8"));
  } finally {
    await fs.rm(target, { force: true });
    await fs.rm(workspace, { recursive: true, force: true });
  }
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
