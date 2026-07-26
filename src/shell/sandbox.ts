import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { classifyDanger } from "../permissions/danger.js";

export type SandboxMode = "auto" | "always" | "off";

export interface SandboxedCommand {
  cmd: string;
  args: string[];
  /** Env vars to overlay on top of the caller's env for this run only (e.g. a redirected TMPDIR). */
  env?: Record<string, string>;
  /** Removes any temp file/dir (e.g. a macOS sandbox profile, a per-run scratch dir) created for this run. */
  cleanup?: () => void;
}

let cachedTool: "bwrap" | "sandbox-exec" | null | undefined;

function commandExists(bin: string): boolean {
  const finder = os.platform() === "win32" ? "where" : "which";
  try {
    return spawnSync(finder, [bin], { stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
}

/** Which sandbox binary (if any) is usable on this platform, cached after the first check. */
function sandboxTool(): "bwrap" | "sandbox-exec" | null {
  if (cachedTool !== undefined) return cachedTool;
  const platform = os.platform();
  if (platform === "linux") {
    cachedTool = commandExists("bwrap") ? "bwrap" : null;
  } else if (platform === "darwin") {
    cachedTool = commandExists("sandbox-exec") ? "sandbox-exec" : null;
  } else {
    cachedTool = null;
  }
  return cachedTool;
}

export function sandboxAvailable(): boolean {
  return sandboxTool() !== null;
}

/** One-line reason sandboxing can't run here, for a fallback warning. */
export function sandboxUnavailableReason(): string {
  const platform = os.platform();
  if (platform === "win32") return "sandboxed execution isn't supported on Windows yet";
  if (platform === "linux") return "bwrap (bubblewrap) not found on PATH";
  if (platform === "darwin") return "sandbox-exec not found on PATH";
  return `sandboxed execution isn't supported on ${platform}`;
}

/** Whether `command` should run sandboxed under the given mode. */
export function shouldSandbox(mode: SandboxMode | undefined, command: string): boolean {
  if (!mode || mode === "off") return false;
  // "always" means always, on every platform — including Windows, where
  // there's no sandbox binary to back it, so every command falls back to
  // the "[sandbox unavailable]" note. That's deliberate: it's the mode for
  // someone who wants maximum enforcement/visibility even without a real
  // sandbox backing it.
  if (mode === "always") return true;
  // "auto": Windows has no sandbox binary at all — falling back to "only
  // flagged commands" (today's behavior) avoids a spurious fallback note on
  // every single shell call, which "sandbox everything" would otherwise cause.
  if (os.platform() === "win32") return classifyDanger(command) !== null;
  return true;
}

/**
 * Common tool-cache / global-install directories outside the workspace that
 * legitimate commands need to write to (package manager caches, toolchain
 * installs) even though sandboxing now applies to every command by default.
 * Kept short and explicit rather than trying to infer "safe" paths.
 */
function extraWritablePaths(): string[] {
  const home = os.homedir();
  return (
    [
      // Package-manager / toolchain caches.
      ".npm",
      ".cache",
      ".cargo",
      ".rustup",
      ".gem",
      // Deliberately NARROW entries, not whole dotfile directories: a writable
      // ~/.ssh lets a command plant a `ProxyCommand` in ~/.ssh/config, a
      // writable ~/.config lets it plant a `!sh -c ...` git alias in
      // ~/.config/git/config, and a writable ~/.local lets it shadow a real
      // binary via ~/.local/bin — each of which is arbitrary code execution
      // outside the sandbox on the next unrelated command.
      //
      // known_hosts (a *file*): git push/clone over SSH appends to it the
      // first time a host is seen. ~/.config/gh: the GitHub CLI's config.
      // ~/.local/share: the XDG data dir (pip --user site tracking, etc.).
      path.join(".ssh", "known_hosts"),
      path.join(".config", "gh"),
      path.join(".local", "share"),
      // ~/.gnupg stays whole: GPG-signed commits need to write the agent
      // socket (S.gpg-agent), trustdb.gpg and pubring.kbx, which sit directly
      // in that directory, so there's no single safe subpath to narrow to.
      // Unlike .ssh/.config/.local it holds no "run this command" config that
      // another tool executes, and GPG keeps it 0700 itself.
      ".gnupg",
    ]
      .map((d) => path.join(home, d))
      // macOS-only, but harmless elsewhere: the bwrap branch skips paths that
      // don't exist, and the macOS profile tolerates nonexistent subpaths.
      .concat([path.join(home, "Library", "Caches")])
  );
}

/**
 * The one directory under the real system temp dir that sandboxed commands can
 * write to and see again on the next invocation. The rest of /tmp is a fresh
 * per-invocation tmpfs, so a sandboxed command can't reach other agents'
 * isolated worktrees (`os.tmpdir()/kritya-worktrees`) or hardlink a host file
 * into /tmp and write through the link to dodge the read-only bind.
 */
export function sandboxSharedTmpDir(): string {
  return path.join(os.tmpdir(), "kritya-sandbox-shared");
}

/**
 * Creates (if needed) and validates the shared sandbox temp dir, returning its
 * path only if it's safe to bind read-write into every sandboxed command —
 * otherwise `null`, and callers must skip the bind rather than use it.
 *
 * On a multi-user host, `os.tmpdir()` (usually `/tmp`) is world-writable, so
 * another local user could pre-create `kritya-sandbox-shared` as a symlink to
 * somewhere sensitive (e.g. the real user's `~/.ssh`) before we ever get to
 * it. Binding that in read-write would hand every sandboxed command a path
 * back into the real filesystem — exactly what the dedicated-tmpfs isolation
 * above exists to prevent. Guarding against it requires:
 *  - creating with `mode: 0o700` so a *freshly created* dir isn't itself
 *    squattable by another user afterwards, and
 *  - `fs.lstatSync` (never `fs.statSync`, which follows symlinks) to confirm
 *    the path is a real directory we own before trusting it.
 */
function safeSandboxSharedTmpDir(): string | null {
  const shared = sandboxSharedTmpDir();
  try {
    fs.mkdirSync(shared, { recursive: true, mode: 0o700 });
  } catch {
    // May already exist (as a legitimate dir from an earlier run, or as
    // something a hostile squatter left behind) — fall through to the lstat
    // check below, which is the real safety gate either way.
  }
  let st: fs.Stats;
  try {
    st = fs.lstatSync(shared);
  } catch {
    // Doesn't exist and we couldn't create it — no bind, sandbox still runs.
    return null;
  }
  if (!st.isDirectory()) return null; // symlink, file, or anything else squatted here
  if (typeof process.getuid === "function" && st.uid !== process.getuid()) return null;
  return shared;
}

/**
 * bwrap can only bind paths that already exist, and `~/.ssh/known_hosts` is a
 * *file* that doesn't exist until the first SSH connection — so without this,
 * a first-time `git clone git@host:...` inside the sandbox could never create
 * it. Seeding an empty 0600 file (only when ~/.ssh already exists, so we never
 * create the directory ourselves) keeps first-use SSH working without falling
 * back to binding the whole ~/.ssh directory.
 */
function seedSshKnownHosts(): void {
  try {
    const sshDir = path.join(os.homedir(), ".ssh");
    if (!fs.existsSync(sshDir)) return;
    const knownHosts = path.join(sshDir, "known_hosts");
    // O_CREAT|O_EXCL ("wx"): the create is atomic, so a concurrent seeder
    // that wins the race gets EEXIST here (caught below and ignored) instead
    // of this call truncating a file that gained content in the meantime.
    fs.writeFileSync(knownHosts, "", { mode: 0o600, flag: "wx" });
  } catch {
    // Either it already exists (including the race above) or we can't create
    // it: best effort — if we can't seed it, the bind is skipped and SSH to a
    // new host fails with a clear error instead of silently escaping the
    // sandbox.
  }
}

/**
 * The git common directory for `workspace` when it lives OUTSIDE the workspace.
 *
 * In a linked worktree (or a submodule) `.git` is a *file* pointing at
 * `<main-repo>/.git/worktrees/<name>` (or `<parent>/.git/modules/<name>`),
 * which the sandbox would otherwise mount read-only — breaking `git add`,
 * `git commit`, `git stash`, and friends with "Read-only file system".
 * Returns null for a plain repo (whose common dir is `workspace/.git`, already
 * writable), for a non-repo, or if git isn't available.
 */
function externalGitCommonDir(workspace: string): string | null {
  try {
    const res = spawnSync("git", ["rev-parse", "--git-common-dir"], {
      cwd: workspace,
      encoding: "utf8",
    });
    if (res.status !== 0 || !res.stdout) return null;
    const raw = res.stdout.trim();
    if (!raw) return null;
    // Git may print this relative to the cwd we passed in.
    const abs = path.resolve(workspace, raw);
    const rel = path.relative(workspace, abs);
    // Inside the workspace already (the plain-repo case) — no extra bind needed.
    if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) return null;
    if (!fs.existsSync(abs)) return null;
    return abs;
  } catch {
    return null;
  }
}

/**
 * `fs.realpathSync`, but tolerant of paths that don't exist yet: resolves the
 * deepest existing ancestor and re-appends the missing tail. Needed because
 * several paths the profile opens up are named before they exist (a per-run
 * scratch dir, `~/.ssh/known_hosts`, cache dirs on a fresh machine).
 */
function realpathBestEffort(p: string): string {
  const abs = path.resolve(p);
  let cur = abs;
  const tail: string[] = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync(cur), ...tail);
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return abs; // reached the root with nothing resolvable
      tail.unshift(path.basename(cur));
      cur = parent;
    }
  }
}

/**
 * Every spelling of `p` a sandbox rule may need to name: the literal path and,
 * when it differs, its symlink-resolved real path.
 *
 * This matters on macOS, where `sandbox-exec` matches `subpath` against the
 * kernel-canonicalized path. `os.tmpdir()` there is `/var/folders/.../T`, whose
 * real path is `/private/var/folders/.../T` — so a rule written against the
 * `/var` spelling never matches anything. The tmp-root DENY rules already
 * resolve, which means an allow rule that doesn't resolve loses to them and the
 * path stays blocked. Exported for tests.
 */
export function sandboxPathVariants(p: string): string[] {
  const abs = path.resolve(p);
  return [...new Set([abs, realpathBestEffort(abs)])];
}

/**
 * Real filesystem locations that back "the system temp dir" on macOS: `/tmp`
 * (a symlink to `/private/tmp`), that resolved target, and `os.tmpdir()`
 * itself (usually `/private/var/folders/.../T`, but honors `$TMPDIR`).
 * Deduped and resolved through symlinks so the profile's deny rules cover
 * whichever spelling a command actually uses.
 */
function macTmpRoots(): string[] {
  return [...new Set(["/tmp", "/private/tmp", os.tmpdir()].flatMap(sandboxPathVariants))];
}

function macSandboxProfile(
  workspace: string,
  extraDirs: string[],
  shared: string | null,
  runDir: string
): string {
  const esc = (p: string) => p.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  // Every allow rule is emitted for both the literal and the symlink-resolved
  // spelling of its path — see `sandboxPathVariants`. Without that, a workspace
  // under `os.tmpdir()` (i.e. `/var/folders/...`) is silently unwritable,
  // because the tmp-root deny rules below resolve and these allows would not.
  const variants = (paths: string[]) => [...new Set(paths.flatMap(sandboxPathVariants))];
  const writeAllowDirs = variants([
    ...extraWritablePaths(),
    ...extraDirs,
    ...(shared ? [shared] : []),
    workspace,
    runDir,
  ]);
  const writeExtra = writeAllowDirs
    .map((p) => `(allow file-write* (subpath "${esc(p)}"))`)
    .join("\n");
  // Reads and process exec/fork stay open by default (matches the Linux
  // ro-bind-everything posture below) EXCEPT under the real temp-dir roots,
  // which are denied and then selectively re-opened below — see the tmp-root
  // rules. Writes are denied everywhere except the workspace, the per-run
  // scratch dir, and a short explicit allowlist, so a command can't damage
  // anything outside the project.
  const readAllowDirs = variants([workspace, runDir, ...extraDirs, ...(shared ? [shared] : [])]);
  const readExtra = readAllowDirs.map((p) => `(allow file-read* (subpath "${esc(p)}"))`).join("\n");
  // The world-writable /tmp (and its real path /private/tmp), plus the
  // per-user TMPDIR under /private/var/folders, are denied wholesale for both
  // reads and writes — hiding any other process's files there, the same
  // isolation the Linux branch gets for free from a fresh per-invocation
  // tmpfs — then selectively reopened just above for the workspace, the
  // shared persistent dir (only when `shared` passed validation; see
  // `safeSandboxSharedTmpDir`), and `runDir`, a fresh directory created for
  // this invocation alone and exposed to the command via $TMPDIR so ordinary
  // scratch-file use keeps working without reaching the real host temp dirs.
  const tmpDeny = macTmpRoots()
    .map((p) => `(deny file-read* (subpath "${esc(p)}"))\n(deny file-write* (subpath "${esc(p)}"))`)
    .join("\n");
  return `(version 1)
(allow default)
(deny file-write* (subpath "/"))
(allow file-write* (subpath "/dev"))
${tmpDeny}
${writeExtra}
${readExtra}
`;
}

/**
 * Wraps `command` (run via `sh -c`) so it's confined to `workspace`: writes
 * are blocked everywhere else, network and (outside the real temp-dir roots)
 * reads are left open. This contains accidental or malicious damage outside
 * the project — it does not stop a command from reading files the real user
 * can read (e.g. `cat ~/.ssh/id_rsa`), since restricting reads generally
 * breaks most ordinary tooling (dynamic linking, package manager caches,
 * etc.); the temp-dir roots are the one exception, hidden to keep one
 * sandboxed command from reading another's scratch files. Returns null if no
 * sandbox binary is available on this platform.
 */
export function buildSandboxedCommand(command: string, workspace: string): SandboxedCommand | null {
  const tool = sandboxTool();
  if (!tool) return null;

  // Linked worktrees / submodules keep their real git dir outside the workspace.
  const gitDir = externalGitCommonDir(workspace);
  // null if the path exists but isn't a real, self-owned directory (e.g.
  // another local user squatted it as a symlink) — see safeSandboxSharedTmpDir.
  const shared = safeSandboxSharedTmpDir();

  if (tool === "bwrap") {
    // /tmp is a fresh per-invocation tmpfs, EXCEPT for one dedicated shared
    // subdirectory bound read-write over it. That keeps the "scratch state
    // persists across sandboxed calls in a session" behavior without exposing
    // the host's real /tmp — which holds other agents' isolated worktrees and
    // is the easiest place to hardlink a host file and write through the link.
    const args = ["--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp"];
    seedSshKnownHosts();
    for (const p of [
      ...extraWritablePaths(),
      ...(shared ? [shared] : []),
      ...(gitDir ? [gitDir] : []),
    ]) {
      if (fs.existsSync(p)) args.push("--bind", p, p);
    }
    args.push(
      "--bind",
      workspace,
      workspace,
      "--chdir",
      workspace,
      "--unshare-pid",
      "--die-with-parent",
      "sh",
      "-c",
      command
    );
    return { cmd: "bwrap", args };
  }

  // sandbox-exec (macOS) takes its policy as a profile file, not inline args.
  const profilePath = path.join(os.tmpdir(), `kritya-sandbox-${process.pid}-${Date.now()}.sb`);
  // A fresh, uniquely-named scratch dir for this invocation alone — exposed
  // to the command via $TMPDIR so ordinary tools that write scratch files
  // keep working even though the rest of the real temp dirs are now hidden
  // (see macSandboxProfile). Read by sandbox-exec's own profile loader before
  // confinement takes effect, so it isn't subject to the tmp-root read-deny
  // it's about to create.
  const runDir = path.join(
    os.tmpdir(),
    `kritya-sandbox-run-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  );
  fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    profilePath,
    macSandboxProfile(workspace, gitDir ? [gitDir] : [], shared, runDir)
  );
  return {
    cmd: "sandbox-exec",
    args: ["-f", profilePath, "sh", "-c", command],
    env: { TMPDIR: runDir, TMP: runDir, TEMP: runDir },
    cleanup: () => {
      fs.rm(profilePath, { force: true }, () => {});
      fs.rm(runDir, { recursive: true, force: true }, () => {});
    },
  };
}
