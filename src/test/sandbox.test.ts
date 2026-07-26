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

test("sandbox allows writes to XDG/ssh/gnupg config dirs outside the workspace", async (t) => {
  if (!sandboxAvailable() || os.platform() === "win32") {
    t.skip("no sandbox binary on this machine");
    return;
  }
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "kritya-sandbox-test-"));
  const ctx: ToolContext = { workspace, sandboxMode: "always" };
  const targets: string[] = [];
  try {
    for (const dir of [".ssh", ".config", ".local", ".gnupg"]) {
      const d = path.join(os.homedir(), dir);
      await fs.mkdir(d, { recursive: true });
      const target = path.join(d, `kritya-sandbox-writable-${process.pid}-${Date.now()}.txt`);
      targets.push(target);
      const out = await shellTool.execute({ command: `echo ok > "${target}"` }, ctx);
      assert.doesNotMatch(out, /sandbox unavailable/);
      assert.match(await fs.readFile(target, "utf8"), /ok/, `expected ~/${dir} to be writable`);
    }
  } finally {
    for (const t2 of targets) await fs.rm(t2, { force: true });
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("sandboxed git commit works inside a linked worktree (git dir lives outside it)", async (t) => {
  if (!sandboxAvailable() || os.platform() === "win32") {
    t.skip("no sandbox binary on this machine");
    return;
  }
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const { execFileSync } = await import("node:child_process");
  // Deliberately NOT under /tmp: /tmp is bound read-write in the sandbox, so a
  // repo there would have a writable git dir regardless of the worktree bind.
  const root = await fs.mkdtemp(path.join(os.homedir(), "kritya-wt-test-"));
  const main = path.join(root, "main");
  await fs.mkdir(main);
  const git = (args: string[], cwd: string) =>
    execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
    });
  try {
    git(["init", "-b", "main"], main);
    git(["config", "user.email", "t@example.com"], main);
    git(["config", "user.name", "T"], main);
    // The sandboxed `git commit` below runs with the real environment, so it
    // would otherwise pick up the developer's global commit.gpgsign setting.
    git(["config", "commit.gpgsign", "false"], main);
    await fs.writeFile(path.join(main, "a.txt"), "a\n");
    git(["add", "."], main);
    git(["commit", "-m", "init"], main);

    const linked = path.join(root, "linked");
    git(["worktree", "add", linked, "-b", "feature"], main);
    // `.git` here is a FILE pointing at main/.git/worktrees/linked — outside
    // the workspace, and read-only under the sandbox without the extra bind.
    assert.ok((await fs.stat(path.join(linked, ".git"))).isFile());

    await fs.writeFile(path.join(linked, "b.txt"), "b\n");
    const ctx: ToolContext = { workspace: linked, sandboxMode: "always" };
    const out = await shellTool.execute(
      { command: "git add b.txt && git commit -m sandboxed-commit" },
      ctx
    );
    assert.doesNotMatch(out, /sandbox unavailable/);
    assert.doesNotMatch(out, /Read-only file system/);
    assert.doesNotMatch(out, /exit code/);
    assert.match(git(["log", "-1", "--pretty=%s"], linked), /sandboxed-commit/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("a plain (non-worktree) repo gets no redundant extra bind for its git dir", async (t) => {
  if (!sandboxAvailable() || os.platform() === "win32") {
    t.skip("no sandbox binary on this machine");
    return;
  }
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const { execFileSync } = await import("node:child_process");
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), "kritya-plainrepo-test-"));
  try {
    execFileSync("git", ["init", "-b", "main"], { cwd: repo });
    const wrapped = buildSandboxedCommand("true", repo)!;
    // The common dir is repo/.git, already inside the read-write workspace
    // bind — it must not be bound a second time.
    const binds = wrapped.args.filter((a) => a.includes(path.join(repo, ".git")));
    assert.deepEqual(binds, []);
  } finally {
    await fs.rm(repo, { recursive: true, force: true });
  }
});

test("sandboxed /tmp is shared across invocations, not a fresh tmpfs", async (t) => {
  if (!sandboxAvailable() || os.platform() === "win32") {
    t.skip("no sandbox binary on this machine");
    return;
  }
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "kritya-tmpshare-test-"));
  const marker = `/tmp/kritya-tmpshare-${process.pid}-${Date.now()}.txt`;
  const ctx: ToolContext = { workspace, sandboxMode: "always" };
  try {
    await shellTool.execute({ command: `echo persisted > ${marker}` }, ctx);
    const second = await shellTool.execute({ command: `cat ${marker}` }, ctx);
    assert.match(second, /persisted/);
    // And it's the host's real /tmp, visible to this process too.
    assert.match(await fs.readFile(marker, "utf8"), /persisted/);
  } finally {
    await fs.rm(marker, { force: true });
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("shell tool redacts secrets from command output", async () => {
  const ctx: ToolContext = { workspace: os.tmpdir(), sandboxMode: "off" };
  const out = await shellTool.execute({ command: "echo AKIAABCDEFGHIJKLMNOP" }, ctx);
  assert.doesNotMatch(out, /AKIAABCDEFGHIJKLMNOP/);
  assert.match(out, /secret\(s\) redacted/);
});
