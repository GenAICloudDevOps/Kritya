import assert from "node:assert/strict";
import os from "node:os";
import { test } from "node:test";
import {
  buildSandboxedCommand,
  defaultSandboxMode,
  mxcPolicyJson,
  requiresSandbox,
  resetSandboxToolCache,
  sandboxAvailable,
  sandboxPathVariants,
  sandboxSharedTmpDir,
  sandboxUnavailableReason,
  shouldSandbox,
} from "../shell/sandbox.js";
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
    // On Windows the backend (MXC) is an optional install, so "auto" follows
    // availability rather than claiming unconditionally: with MXC present
    // every command is sandboxed, and without it only the commands
    // classifyDanger flags — otherwise every shell call would show a
    // spurious "[sandbox unavailable]" note.
    assert.equal(shouldSandbox("auto", "npm test"), sandboxAvailable());
    assert.equal(shouldSandbox("auto", "rm -rf /tmp/x"), true); // flagged either way
    assert.equal(shouldSandbox("always", "npm test"), true);
    return;
  }
  assert.equal(shouldSandbox("auto", "npm test"), true);
  assert.equal(shouldSandbox("auto", "git status"), true);
  assert.equal(shouldSandbox("auto", "rm -rf /tmp/x"), true);
});

test("defaultSandboxMode: strict on Windows (the mode that fails closed), auto elsewhere", (t) => {
  t.mock.method(os, "platform", () => "win32");
  assert.equal(defaultSandboxMode(), "strict");

  t.mock.method(os, "platform", () => "linux");
  assert.equal(defaultSandboxMode(), "auto");

  t.mock.method(os, "platform", () => "darwin");
  assert.equal(defaultSandboxMode(), "auto");
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
    t.skip("POSIX shell semantics — the Windows/MXC path is covered by the mxc* tests below");
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

test("sandbox allows writes to the narrow XDG/ssh/gnupg paths outside the workspace", async (t) => {
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
    // Directory allowances that survived the narrowing.
    for (const dir of [path.join(".config", "gh"), path.join(".local", "share"), ".gnupg"]) {
      const d = path.join(os.homedir(), dir);
      await fs.mkdir(d, { recursive: true });
      const target = path.join(d, `kritya-sandbox-writable-${process.pid}-${Date.now()}.txt`);
      targets.push(target);
      const out = await shellTool.execute({ command: `echo ok > "${target}"` }, ctx);
      assert.doesNotMatch(out, /sandbox unavailable/);
      assert.match(await fs.readFile(target, "utf8"), /ok/, `expected ~/${dir} to be writable`);
    }
    // ~/.ssh/known_hosts is a *file* bind: appending to it must work, which is
    // what a first connection to a new host does.
    const sshDir = path.join(os.homedir(), ".ssh");
    await fs.mkdir(sshDir, { recursive: true });
    const knownHosts = path.join(sshDir, "known_hosts");
    const before = await fs.readFile(knownHosts, "utf8").catch(() => null);
    const marker = `# kritya-sandbox-test-${process.pid}-${Date.now()}`;
    try {
      const out = await shellTool.execute({ command: `echo '${marker}' >> "${knownHosts}"` }, ctx);
      assert.doesNotMatch(out, /sandbox unavailable/);
      assert.match(await fs.readFile(knownHosts, "utf8"), new RegExp(marker));
    } finally {
      if (before === null) await fs.rm(knownHosts, { force: true });
      else await fs.writeFile(knownHosts, before, { mode: 0o600 });
    }
  } finally {
    for (const t2 of targets) await fs.rm(t2, { force: true });
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("sandbox blocks the RCE-capable paths inside ~/.ssh, ~/.local and ~/.config", async (t) => {
  if (!sandboxAvailable() || os.platform() === "win32") {
    t.skip("no sandbox binary on this machine");
    return;
  }
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "kritya-sandbox-test-"));
  const ctx: ToolContext = { workspace, sandboxMode: "always" };
  // Each of these is arbitrary code execution outside the sandbox if writable:
  // an ssh ProxyCommand, a PATH-shadowing binary, a `!sh -c ...` git alias.
  const blocked = [
    path.join(os.homedir(), ".ssh", `kritya-blocked-config-${process.pid}`),
    path.join(os.homedir(), ".local", "bin", `kritya-blocked-bin-${process.pid}`),
    path.join(os.homedir(), ".config", "git", `kritya-blocked-config-${process.pid}`),
    path.join(os.homedir(), ".local", "state", `kritya-blocked-state-${process.pid}`),
  ];
  try {
    for (const target of blocked) {
      await fs.mkdir(path.dirname(target), { recursive: true });
      await shellTool.execute({ command: `echo bad > "${target}"` }, ctx);
      await assert.rejects(fs.access(target), `expected ${target} to be unwritable in the sandbox`);
    }
  } finally {
    for (const b of blocked) await fs.rm(b, { force: true });
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
  // Deliberately NOT under /tmp: the sandbox replaces /tmp with a tmpfs, so a
  // repo there would be invisible rather than exercising the worktree bind.
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

test("the dedicated shared temp dir persists across sandboxed invocations", async (t) => {
  if (!sandboxAvailable() || os.platform() === "win32") {
    t.skip("no sandbox binary on this machine");
    return;
  }
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "kritya-tmpshare-test-"));
  const marker = path.join(
    sandboxSharedTmpDir(),
    `kritya-tmpshare-${process.pid}-${Date.now()}.txt`
  );
  const ctx: ToolContext = { workspace, sandboxMode: "always" };
  try {
    await shellTool.execute({ command: `echo persisted > ${marker}` }, ctx);
    const second = await shellTool.execute({ command: `cat ${marker}` }, ctx);
    assert.match(second, /persisted/);
    // And it's the host's real directory, visible to this process too.
    assert.match(await fs.readFile(marker, "utf8"), /persisted/);
  } finally {
    await fs.rm(marker, { force: true });
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("a squatted shared temp dir (symlink) is never bound into the sandbox", async (t) => {
  if (!sandboxAvailable() || os.platform() === "win32") {
    t.skip("no sandbox binary on this machine");
    return;
  }
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const shared = sandboxSharedTmpDir();
  // Stand-in for "somewhere sensitive" — the point is only that the sandbox
  // must refuse to bind ANY symlink at the shared-dir path, not that this
  // particular target is sensitive.
  const symlinkTarget = await fs.mkdtemp(path.join(os.tmpdir(), "kritya-squat-target-"));
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "kritya-squat-test-"));
  // Preserve whatever legitimately lives at the shared-dir path so later
  // tests in this file aren't left with a dangling symlink.
  const hadRealDir = await fs
    .stat(shared)
    .then((s) => s.isDirectory())
    .catch(() => false);
  let cleanup: { cleanup?: () => void } | undefined;
  try {
    // recursive is required when `shared` is a real directory (the common
    // case); it's irrelevant for a symlink, which rm never recurses into.
    await fs.rm(shared, { recursive: true, force: true });
    await fs.symlink(symlinkTarget, shared);
    const wrapped = buildSandboxedCommand("true", workspace);
    assert.ok(wrapped, "sandbox should still run, just without the shared-dir bind");
    cleanup = wrapped!;
    if (wrapped!.cmd === "bwrap") {
      const bindIdx = wrapped!.args.findIndex(
        (a, i) => a === "--bind" && wrapped!.args[i + 1] === shared
      );
      assert.equal(bindIdx, -1, "squatted shared dir must not be bound into bwrap");
    } else {
      // sandbox-exec (macOS): the profile is a file passed via `-f <path>`.
      const fIdx = wrapped!.args.indexOf("-f");
      assert.ok(fIdx >= 0);
      const profile = await fs.readFile(wrapped!.args[fIdx + 1], "utf8");
      assert.doesNotMatch(
        profile,
        new RegExp(shared.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
        "squatted shared dir must not be referenced in the sandbox profile"
      );
    }
  } finally {
    cleanup?.cleanup?.();
    await fs.rm(shared, { recursive: true, force: true }); // unlink the symlink (or dir) left behind
    await fs.rm(symlinkTarget, { recursive: true, force: true });
    await fs.rm(workspace, { recursive: true, force: true });
    if (hadRealDir) await fs.mkdir(shared, { recursive: true, mode: 0o700 });
  }
});

test("the rest of /tmp stays isolated per invocation and hidden from the sandbox", async (t) => {
  if (!sandboxAvailable() || os.platform() === "win32") {
    t.skip("no sandbox binary on this machine");
    return;
  }
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "kritya-tmpiso-test-"));
  const ctx: ToolContext = { workspace, sandboxMode: "always" };
  // NOT inside the shared dir: this is the regression test for binding all of
  // the real /tmp read-write.
  const stray = `/tmp/kritya-tmpiso-${process.pid}-${Date.now()}.txt`;
  // Stand-in for another agent's worktree under os.tmpdir()/kritya-worktrees.
  const hostSecret = path.join(os.tmpdir(), `kritya-tmpiso-host-${process.pid}-${Date.now()}.txt`);
  await fs.writeFile(hostSecret, "host-only\n");
  try {
    await shellTool.execute({ command: `echo leaked > ${stray}` }, ctx);
    // It never reached the host's /tmp...
    await assert.rejects(fs.access(stray), "stray /tmp write escaped the tmpfs");
    // ...and it isn't visible to the next sandboxed invocation either.
    const second = await shellTool.execute({ command: `cat ${stray} 2>&1 || true` }, ctx);
    assert.doesNotMatch(second, /leaked/);
    // A pre-existing host file under the real temp dir is invisible too.
    const third = await shellTool.execute({ command: `cat ${hostSecret} 2>&1 || true` }, ctx);
    assert.doesNotMatch(third, /host-only/);
  } finally {
    await fs.rm(stray, { force: true });
    await fs.rm(hostSecret, { force: true });
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("sandboxPathVariants covers both the symlinked and the real spelling of a path", async () => {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "kritya-variants-")));
  try {
    // Mirrors macOS's /var -> /private/var: the path a caller hands us goes
    // through a symlink, but the kernel (and sandbox-exec's `subpath` matcher)
    // only ever sees the resolved spelling.
    await fs.mkdir(path.join(base, "real", "deep"), { recursive: true });
    await fs.symlink(path.join(base, "real"), path.join(base, "link"));

    const existing = path.join(base, "link", "deep");
    assert.deepEqual(
      new Set(sandboxPathVariants(existing)),
      new Set([existing, path.join(base, "real", "deep")])
    );

    // Not-yet-created paths matter too: ~/.ssh/known_hosts and per-run scratch
    // dirs are named before they exist, and must still resolve.
    const missing = path.join(base, "link", "deep", "not-there");
    assert.deepEqual(
      new Set(sandboxPathVariants(missing)),
      new Set([missing, path.join(base, "real", "deep", "not-there")])
    );

    // A path with nothing to resolve stays a single entry.
    assert.deepEqual(sandboxPathVariants(path.join(base, "real")), [path.join(base, "real")]);
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});

test("the macOS profile allows the resolved spelling of every path it opens up", async (t) => {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  // A workspace under os.tmpdir() is exactly the case CI hit: on macOS that is
  // /var/folders/... whose real path is /private/var/folders/..., and the
  // tmp-root deny rules are written against the resolved spelling.
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "kritya-profile-test-"));
  const wrapped = buildSandboxedCommand("true", workspace);
  if (!wrapped || wrapped.cmd !== "sandbox-exec") {
    await fs.rm(workspace, { recursive: true, force: true });
    t.skip("no sandbox-exec profile on this platform");
    return;
  }
  try {
    const profile = await fs.readFile(wrapped.args[wrapped.args.indexOf("-f") + 1], "utf8");
    for (const p of sandboxPathVariants(workspace)) {
      assert.ok(
        profile.includes(`(allow file-write* (subpath "${p}"))`),
        `profile must allow writes to ${p}`
      );
      assert.ok(
        profile.includes(`(allow file-read* (subpath "${p}"))`),
        `profile must allow reads from ${p}`
      );
    }
  } finally {
    wrapped.cleanup?.();
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("shell tool redacts secrets from command output", async () => {
  const ctx: ToolContext = { workspace: os.tmpdir(), sandboxMode: "off" };
  const out = await shellTool.execute({ command: "echo AKIAABCDEFGHIJKLMNOP" }, ctx);
  assert.doesNotMatch(out, /AKIAABCDEFGHIJKLMNOP/);
  assert.match(out, /secret\(s\) redacted/);
});

// --- MXC (Windows) ---------------------------------------------------------
// These do not need MXC installed: `mxcPolicyJson` is pure, and discovery is
// driven through the documented `KRITYA_MXC_EXEC` override.

test("mxcPolicyJson builds a versioned ProcessContainer request", () => {
  const policy = JSON.parse(mxcPolicyJson("echo hi", "/work/proj", ["/home/u/.npm"]));
  // The version marker is part of MXC's contract, not a comment: wxc-exec
  // rejects a request without it.
  assert.equal(policy.version, "1.0.0");
  assert.equal(policy.containment, "processcontainer");
  assert.deepEqual(policy.process, { commandLine: "echo hi", cwd: "/work/proj" });
  // The drive root is the read-everything entry, and it rides in the
  // *readwrite* list — see mxcPolicyJson for why that is not a loosening.
  assert.deepEqual(policy.filesystem.readwritePaths, ["/home/u/.npm", "/work/proj", "C:\\"]);
  // `readonlyPaths` is deliberately absent: naming the drive root there makes
  // wxc-exec create the process and then have it exit 1 with no output, so the
  // command silently never runs.
  assert.equal(policy.filesystem.readonlyPaths, undefined);
  // Left open on purpose, matching bwrap/sandbox-exec — see mxcPolicyJson.
  assert.equal(policy.network.egress.default, "allow");
  assert.equal(policy.network.ingress.default, "allow");
  // UI access stays on. MXC's default blocks Win32k, and a contained process
  // that cannot reach it dies with STATUS_DLL_INIT_FAILED before running any of
  // its own code — so omitting this section silently breaks every command.
  assert.equal(policy.ui.disable, false);
  assert.equal(policy.telemetry.enabled, false);
});

test("mxcPolicyJson always makes the workspace writable, without duplicating it", () => {
  const policy = JSON.parse(mxcPolicyJson("true", "/work/proj", ["/work/proj", "/home/u/.npm"]));
  assert.deepEqual(policy.filesystem.readwritePaths, ["/work/proj", "/home/u/.npm", "C:\\"]);
});

test("mxcPolicyJson keeps the drive root out of readonlyPaths", () => {
  // Regression: the drive root used to be emitted as `readonlyPaths: ["C:\\"]`,
  // which is the spelling MXC's own getPowerShellPolicy uses. On Windows 11
  // 24H2 wxc-exec accepts it, logs `process created (PID …)`, and then the
  // child exits 1 with no output — every sandboxed command silently did
  // nothing. Granting the same path through readwritePaths is harmless and
  // restores the intended read access to `C:\`, so the two lists must stay the
  // way round they are now.
  const policy = JSON.parse(mxcPolicyJson("dir", "C:\\work\\proj", []));
  assert.equal(policy.filesystem.readonlyPaths, undefined);
  assert.ok(policy.filesystem.readwritePaths.includes("C:\\"));
  assert.ok(policy.filesystem.readwritePaths.includes("C:\\work\\proj"));
});

test("mxcPolicyJson survives a workspace path that needs JSON escaping", () => {
  // Windows workspaces are full of backslashes; a policy that mangles them
  // would confine the command to the wrong directory.
  const workspace = "C:\\Users\\dev\\proj";
  const policy = JSON.parse(mxcPolicyJson("dir", workspace, []));
  assert.equal(policy.process.cwd, workspace);
  assert.ok(policy.filesystem.readwritePaths.includes(workspace));
});

test("mxcPolicyJson emits readonlyPaths only when there is something to add", () => {
  // Omitting the key rather than sending `[]` keeps a policy built without any
  // read grants byte-identical to what this function produced before the
  // parameter existed.
  const bare = JSON.parse(mxcPolicyJson("dir", "/work/proj", []));
  assert.equal(bare.filesystem.readonlyPaths, undefined);

  const granted = JSON.parse(
    mxcPolicyJson("dir", "/work/proj", [], ["/opt/tools", "/opt/tools", "/usr/local/bin"])
  );
  // Deduplicated, and never the drive root — see mxcPolicyJson.
  assert.deepEqual(granted.filesystem.readonlyPaths, ["/opt/tools", "/usr/local/bin"]);
  assert.ok(!granted.filesystem.readonlyPaths.includes("C:\\"));
});

test("the MXC read grants skip PATH entries that would abort container creation", async (t) => {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  t.mock.method(os, "platform", () => "win32");
  const previousExec = process.env.KRITYA_MXC_EXEC;
  const previousPath = process.env.PATH;
  // A real tree, so the "exists and is a directory" filter has something to
  // keep: `root/tools` is a genuine tool directory, `root` is its parent and
  // contains the workspace, and the home directory's parent contains home —
  // granting either of those two aborts container creation outright.
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "kritya-toolpath-"));
  const tools = path.join(root, "tools");
  const workspace = path.join(root, "ws");
  await fs.mkdir(tools);
  await fs.mkdir(workspace);
  const homeParent = path.dirname(os.homedir());
  process.env.KRITYA_MXC_EXEC = process.execPath;
  process.env.PATH = [root, tools, homeParent].join(path.delimiter);
  resetSandboxToolCache();
  try {
    const wrapped = buildSandboxedCommand("echo hi", workspace);
    assert.ok(wrapped, "MXC backend should produce a wrapper");
    const policy = JSON.parse(Buffer.from(wrapped!.args[1], "base64").toString("utf8"));
    const granted: string[] = policy.filesystem.readonlyPaths ?? [];
    assert.ok(granted.includes(tools), "a real tool directory should be granted");
    assert.ok(!granted.includes(root), "a PATH entry containing the workspace must not be granted");
    assert.ok(!granted.includes(homeParent), "a PATH entry containing home must not be granted");
    // The drive root is the read-everything entry, and belongs in readwritePaths.
    assert.ok(!granted.includes(path.parse(root).root));
  } finally {
    if (previousExec === undefined) delete process.env.KRITYA_MXC_EXEC;
    else process.env.KRITYA_MXC_EXEC = previousExec;
    process.env.PATH = previousPath;
    resetSandboxToolCache();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("MXC is discovered on Windows and wraps the command for wxc-exec", (t) => {
  const previous = process.env.KRITYA_MXC_EXEC;
  t.mock.method(os, "platform", () => "win32");
  // Point at a file that certainly exists. Nothing is executed here — the
  // wrapper is only built, never spawned.
  process.env.KRITYA_MXC_EXEC = process.execPath;
  resetSandboxToolCache();
  try {
    assert.equal(sandboxAvailable(), true);
    // With a backend present, "auto" means what it means on other platforms.
    assert.equal(shouldSandbox("auto", "npm test"), true);

    const workspace = os.tmpdir();
    const wrapped = buildSandboxedCommand("echo hi", workspace);
    assert.ok(wrapped, "MXC backend should produce a wrapper");
    assert.equal(wrapped!.cmd, process.execPath);
    assert.equal(wrapped!.args[0], "--config-base64");

    const policy = JSON.parse(Buffer.from(wrapped!.args[1], "base64").toString("utf8"));
    assert.equal(policy.version, "1.0.0");
    assert.equal(policy.containment, "processcontainer");
    // The command goes to cmd.exe rather than straight to CreateProcess: this
    // branch has no `sh -c` to give it a shell, so without the wrapper `a && b`
    // would reach the first program as literal arguments and pipes, redirects
    // and `cd … && …` would silently do nothing.
    assert.equal(policy.process.commandLine, 'cmd.exe /d /s /c "echo hi"');
    assert.ok(policy.filesystem.readwritePaths.includes(workspace));

    // The policy travels as base64, so unlike the macOS branch there is no
    // profile file to clean up and no temp dir was created.
    assert.equal(wrapped!.cleanup, undefined);
    assert.equal(wrapped!.args.length, 2, "just the flag and its payload");
  } finally {
    if (previous === undefined) delete process.env.KRITYA_MXC_EXEC;
    else process.env.KRITYA_MXC_EXEC = previous;
    resetSandboxToolCache();
  }
});

test("a strict run with MXC present is contained rather than refused", async (t) => {
  const previous = process.env.KRITYA_MXC_EXEC;
  t.mock.method(os, "platform", () => "win32");
  process.env.KRITYA_MXC_EXEC = process.execPath;
  resetSandboxToolCache();
  try {
    const mode = defaultSandboxMode();
    assert.equal(mode, "strict");
    // This is the behaviour change that matters: on Windows "strict" used to
    // refuse every command, because there was no backend to run it in.
    assert.equal(shouldSandbox(mode, "echo hi"), true);
    assert.ok(buildSandboxedCommand("echo hi", os.tmpdir()));
  } finally {
    if (previous === undefined) delete process.env.KRITYA_MXC_EXEC;
    else process.env.KRITYA_MXC_EXEC = previous;
    resetSandboxToolCache();
  }
});

test("a nonexistent KRITYA_MXC_EXEC override is ignored, not trusted", async (t) => {
  const path = await import("node:path");
  const previous = process.env.KRITYA_MXC_EXEC;
  const bogus = path.join(os.tmpdir(), "kritya-not-a-real-wxc-exec.exe");
  t.mock.method(os, "platform", () => "win32");
  process.env.KRITYA_MXC_EXEC = bogus;
  resetSandboxToolCache();
  try {
    const wrapped = buildSandboxedCommand("echo hi", os.tmpdir());
    if (wrapped) {
      // Something else on this host served the request; it must not be the
      // override path that does not exist.
      assert.notEqual(wrapped.cmd, bogus);
    } else {
      assert.equal(sandboxAvailable(), false);
    }
  } finally {
    if (previous === undefined) delete process.env.KRITYA_MXC_EXEC;
    else process.env.KRITYA_MXC_EXEC = previous;
    resetSandboxToolCache();
  }
});

test("without MXC, Windows fails closed under strict rather than running unconfined", (t) => {
  const previous = process.env.KRITYA_MXC_EXEC;
  t.mock.method(os, "platform", () => "win32");
  delete process.env.KRITYA_MXC_EXEC;
  resetSandboxToolCache();
  try {
    // "strict" is a hard requirement regardless of what is installed — that is
    // what keeps the Windows default safe when no backend can be found.
    assert.equal(requiresSandbox("strict"), true);
    assert.match(sandboxUnavailableReason(), /wxc-exec\.exe/);
    if (!sandboxAvailable()) {
      assert.equal(buildSandboxedCommand("echo hi", os.tmpdir()), null);
      assert.equal(shouldSandbox("strict", "echo hi"), true);
    }
  } finally {
    if (previous !== undefined) process.env.KRITYA_MXC_EXEC = previous;
    resetSandboxToolCache();
  }
});
