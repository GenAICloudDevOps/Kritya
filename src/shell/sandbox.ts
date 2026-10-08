import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { CONFIG_DIR, loadDotEnv } from "../config/config.js";
import { classifyDanger } from "../permissions/danger.js";

export type SandboxMode = "auto" | "always" | "strict" | "off";

export interface SandboxedCommand {
  cmd: string;
  args: string[];
  /** Env vars to overlay on top of the caller's env for this run only (e.g. a redirected TMPDIR). */
  env?: Record<string, string>;
  /** Removes any temp file/dir (e.g. a macOS sandbox profile, a per-run scratch dir) created for this run. */
  cleanup?: () => void;
}

let cachedTool: "bwrap" | "sandbox-exec" | "mxc" | null | undefined;
let cachedMxcExec: string | null | undefined;
let dotEnvLoaded = false;

/**
 * Load `~/.kritya/.env` before the backend is resolved, once per process.
 *
 * `locateMxcExecutable` reads `KRITYA_MXC_EXEC` and `MXC_BIN_DIR` from the
 * environment, but the sandbox module is callable from frontends that never
 * load the global `.env` themselves (the tool executor reaches
 * `sandboxAvailable()` directly). Without this, a user who configured the MXC
 * path in `.env` would have it honoured only when some *other* entry point
 * happened to load the file first — and because `sandboxTool()` memoizes its
 * answer, a miss could not self-correct later in the session. Loading here
 * makes discovery independent of who calls it first.
 */
function loadSandboxEnv(): void {
  if (dotEnvLoaded) return;
  dotEnvLoaded = true;
  loadDotEnv([path.join(CONFIG_DIR, ".env")]);
}

function commandExists(bin: string): boolean {
  const finder = os.platform() === "win32" ? "where" : "which";
  try {
    return spawnSync(finder, [bin], { stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
}

/**
 * MXC ships `wxc-exec.exe` per architecture (`bin/x64/`, `bin/arm64/`), and its
 * own resolver picks the same way — see `sdk/node/src/v1/platform.ts::
 * findWxcExecutable`, which this mirrors.
 */
function mxcArch(): string {
  return os.arch() === "arm64" ? "arm64" : "x64";
}

/** The `@microsoft/mxc-sdk` install directory, or null when it isn't installed. */
function mxcPackageRoot(): string | null {
  try {
    // `./package.json` is in the SDK's exports map, so this resolves whether or
    // not the package's main entry is importable.
    const require = createRequire(import.meta.url);
    return path.dirname(require.resolve("@microsoft/mxc-sdk/package.json"));
  } catch {
    return null;
  }
}

/**
 * Locate `wxc-exec.exe`, in the order a user would expect to override it: an
 * explicit path, then MXC's own `MXC_BIN_DIR`, then `PATH`, then an optional
 * `@microsoft/mxc-sdk` install. Null means MXC isn't present, which leaves
 * Windows behaving exactly as it did before MXC support existed.
 */
function locateMxcExecutable(): string | null {
  const explicit = process.env.KRITYA_MXC_EXEC;
  if (explicit && fs.existsSync(explicit)) return explicit;

  // MXC's own override: <MXC_BIN_DIR>/<arch>/wxc-exec.exe.
  const binDir = process.env.MXC_BIN_DIR;
  if (binDir) {
    const candidate = path.join(binDir, mxcArch(), "wxc-exec.exe");
    if (fs.existsSync(candidate)) return candidate;
  }

  // On PATH — kept as a bare name so the OS resolves it at spawn time.
  if (commandExists("wxc-exec.exe")) return "wxc-exec.exe";

  const root = mxcPackageRoot();
  if (root) {
    const candidate = path.join(root, "bin", mxcArch(), "wxc-exec.exe");
    if (fs.existsSync(candidate)) return candidate;
  }

  return null;
}

/** Cached after the first check — locating it can shell out to `where`. */
function mxcExecutable(): string | null {
  if (cachedMxcExec === undefined) cachedMxcExec = locateMxcExecutable();
  return cachedMxcExec;
}

/** Test-only: drops the memoized backend and MXC path between cases. */
export function resetSandboxToolCache(): void {
  cachedTool = undefined;
  cachedMxcExec = undefined;
  dotEnvLoaded = false;
}

/** Which sandbox backend (if any) is usable on this platform, cached after the first check. */
function sandboxTool(): "bwrap" | "sandbox-exec" | "mxc" | null {
  if (cachedTool !== undefined) return cachedTool;
  loadSandboxEnv();
  const platform = os.platform();
  if (platform === "linux") {
    cachedTool = commandExists("bwrap") ? "bwrap" : null;
  } else if (platform === "darwin") {
    cachedTool = commandExists("sandbox-exec") ? "sandbox-exec" : null;
  } else if (platform === "win32") {
    // MXC (Microsoft eXecution Containers) is Windows' only containment
    // backend — AppContainer + DACLs, enforced by the kernel. It is an
    // optional install, so "not there" is the common case and stays null.
    cachedTool = mxcExecutable() ? "mxc" : null;
  } else {
    cachedTool = null;
  }
  return cachedTool;
}

export function sandboxAvailable(): boolean {
  return sandboxTool() !== null;
}

/**
 * Default `sandboxMode` when the config leaves `sandboxExec` unset. "auto" on
 * Linux/macOS, where bwrap/sandbox-exec can actually confine writes to the
 * workspace. On Windows "strict" is kept even though MXC can now back it,
 * because "strict" is the mode that fails closed: with MXC installed every
 * command runs *inside* the container instead of being refused, and on a host
 * where MXC isn't present (or can't be served) commands are refused rather
 * than silently falling back to an unconfined run.
 */
export function defaultSandboxMode(): SandboxMode {
  return os.platform() === "win32" ? "strict" : "auto";
}

/** Outcome of one canary probe (see `runSandboxCanary`). */
export interface SandboxCanaryProbe {
  /** What the probe tried to do, phrased for a human. */
  what: string;
  /** True when the probe did NOT achieve its goal — i.e. containment held. */
  held: boolean;
  /** True when this probe is not a containment claim (reads are open by design). */
  informational?: boolean;
}

/** Result of a live containment self-test. */
export interface SandboxCanaryResult {
  /** False when no backend is available — the caller should say so, not "failed". */
  ran: boolean;
  /** Why the canary could not run, when `ran` is false. */
  reason?: string;
  probes: SandboxCanaryProbe[];
}

/** Quoted for `cmd.exe` (Windows), where the canary command runs. */
function windowsQuote(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

/**
 * Turns the observed state of the canary's two marker files into probes.
 *
 * Split out from `runSandboxCanary` so the decision — the part that can be
 * wrong — is testable without a backend to spawn. `escaped` is "the file
 * outside the workspace exists", `wroteInside` is "the file inside does".
 *
 * The three-way logic matters: `escaped && wroteInside` is a breached sandbox;
 * `!escaped && wroteInside` is a healthy one; and `!escaped && !wroteInside`
 * means the command never reached the shell at all, which must NOT be read as
 * containment — that is why the inside write is a probe rather than a
 * throwaway control.
 */
export function canaryProbes(escaped: boolean, wroteInside: boolean): SandboxCanaryProbe[] {
  return [
    {
      what: "a write outside the workspace (system temp dir) was blocked",
      held: !escaped,
    },
    {
      what: "a write inside the workspace succeeded (the sandbox is not simply refusing everything)",
      held: wroteInside,
    },
    {
      what: "reads outside the workspace (incl. ~/.kritya/.env) are open by design",
      held: false,
      informational: true,
    },
  ];
}

/**
 * A live containment check: run a canary *inside* the sandbox that tries to
 * write outside the workspace, then report whether the write was actually
 * blocked.
 *
 * CI can only test the policy this module *builds*; it cannot prove the
 * backend on the user's machine enforces it (an MXC too old for
 * `processcontainer`, a stale `wxc-exec.exe`, or a host missing the one-time
 * privilege prep all change the answer without changing a line of code here).
 * This closes that gap the only honest way — by trying to escape and looking
 * at the result. It writes at most one marker file, in the system temp dir,
 * and removes it either way.
 *
 * Only the *write* probe is a containment claim: reads outside the workspace
 * are open by design (see `buildSandboxedCommand`), so the read probe is
 * reported but never counted as a failure.
 */
export function runSandboxCanary(workspace: string): SandboxCanaryResult {
  const reason = sandboxUnavailableReason();
  if (!sandboxAvailable()) {
    return { ran: false, reason, probes: [] };
  }

  // The escape target: outside the workspace, guaranteed writable by the real
  // user, so "the file is not there afterwards" can only mean the sandbox
  // blocked it. A path *inside* the workspace would prove nothing.
  const escapeTarget = path.join(os.tmpdir(), `kritya-canary-escape-${process.pid}.txt`);
  const insideTarget = path.join(workspace, `.kritya-canary-inside-${process.pid}.txt`);
  const cleanup = () => {
    for (const f of [escapeTarget, insideTarget]) {
      try {
        fs.rmSync(f, { force: true });
      } catch {
        /* best effort — a file that is not there is the expected case */
      }
    }
  };
  cleanup(); // in case a previous run left a marker behind

  const isWindows = os.platform() === "win32";
  const writeOutside = isWindows
    ? `echo canary> ${windowsQuote(escapeTarget)}`
    : `printf canary > ${JSON.stringify(escapeTarget)}`;
  const writeInside = isWindows
    ? `echo canary> ${windowsQuote(insideTarget)}`
    : `printf canary > ${JSON.stringify(insideTarget)}`;
  // The canary exits 0 regardless: reaching the shell at all is the point, and
  // a nonzero exit from a *blocked* write is not something the caller needs.
  const script = isWindows
    ? `${writeOutside} & ${writeInside} & exit /b 0`
    : `${writeOutside}; ${writeInside}; true`;

  const wrapped = buildSandboxedCommand(script, workspace);
  if (!wrapped) {
    return { ran: false, reason, probes: [] };
  }

  const opts = wrapped.env && process.env ? { ...process.env, ...wrapped.env } : process.env;
  try {
    spawnSync(wrapped.cmd, wrapped.args, {
      cwd: workspace,
      env: opts,
      timeout: 30_000,
      windowsHide: true,
      stdio: "ignore",
    });
  } catch {
    // A backend that cannot even start the container means containment is not
    // in force — report the escape as *not* held rather than crashing doctor.
    cleanup();
    wrapped.cleanup?.();
    return { ran: true, probes: canaryProbes(true, false) };
  }
  wrapped.cleanup?.();

  const escaped = fs.existsSync(escapeTarget);
  const wroteInside = fs.existsSync(insideTarget);
  cleanup();

  return { ran: true, probes: canaryProbes(escaped, wroteInside) };
}

/** One-line reason sandboxing can't run here, for a fallback warning. */
export function sandboxUnavailableReason(): string {
  const platform = os.platform();
  if (platform === "win32") {
    return (
      "wxc-exec.exe not found (install @microsoft/mxc-sdk, set MXC_BIN_DIR, " +
      "or point KRITYA_MXC_EXEC at the binary)"
    );
  }
  if (platform === "linux") return "bwrap (bubblewrap) not found on PATH";
  if (platform === "darwin") return "sandbox-exec not found on PATH";
  return `sandboxed execution isn't supported on ${platform}`;
}

/** Whether `command` should run sandboxed under the given mode. */
export function shouldSandbox(mode: SandboxMode | undefined, command: string): boolean {
  if (!mode || mode === "off") return false;
  // "always"/"strict" mean always, on every platform. Where no backend can be
  // found that falls back to the "[sandbox unavailable]" note ("always") or a
  // refusal ("strict") — deliberate, since these are the modes for someone who
  // wants maximum enforcement/visibility even without a sandbox behind them.
  if (mode === "always" || mode === "strict") return true;
  // "auto" on Windows without a backend: falling back to "only flagged
  // commands" avoids a spurious fallback note on every single shell call,
  // which "sandbox everything" would otherwise cause. With MXC installed
  // there *is* a backend, so "auto" means here what it means elsewhere.
  if (os.platform() === "win32") return sandboxAvailable() || classifyDanger(command) !== null;
  return true;
}

/**
 * Whether a command that `shouldSandbox` flagged, but for which no sandbox
 * binary is available on this platform, must be refused outright rather than
 * falling back to an unsandboxed run. Only "strict" has this fail-closed
 * behavior; "auto" and "always" fail open with a warning note instead.
 */
export function requiresSandbox(mode: SandboxMode | undefined): boolean {
  return mode === "strict";
}

/**
 * True once the user has explicitly approved running unsandboxed for the rest
 * of this process — see `sandboxFallbackWarning`. Resets on restart; there is
 * no persistent "don't ask again" for this, since a different host without
 * the sandbox binary could be running next time.
 */
let unsandboxedFallbackAcknowledged = false;

/** Records that the user approved the one-time unsandboxed-fallback warning. */
export function acknowledgeUnsandboxedFallback(): void {
  unsandboxedFallbackAcknowledged = true;
}

/** Test-only: undoes `acknowledgeUnsandboxedFallback` between test cases. */
export function resetUnsandboxedFallbackAcknowledgement(): void {
  unsandboxedFallbackAcknowledged = false;
}

/**
 * A one-time, forced permission-prompt warning for the fail-open gap in
 * "auto"/"always": sandboxing was requested for `command` but no sandbox
 * binary is installed, so it's about to run completely unconfined — able to
 * read, write, or delete anywhere the real user can, not just inside the
 * workspace. Returns null (nothing to warn about) once
 * `acknowledgeUnsandboxedFallback` has been called this run, when sandboxing
 * wasn't requested for this command, when a sandbox binary IS available, or
 * under "strict" (which refuses instead of falling back, so it has no silent
 * gap to warn about).
 */
export function sandboxFallbackWarning(
  mode: SandboxMode | undefined,
  command: string
): string | null {
  if (unsandboxedFallbackAcknowledged) return null;
  if (!shouldSandbox(mode, command)) return null;
  if (requiresSandbox(mode)) return null;
  if (sandboxAvailable()) return null;
  return (
    `a command running with NO sandbox isolation (${sandboxUnavailableReason()}) — ` +
    `it can read, write, or delete anywhere you can, not just inside the workspace. ` +
    `Approving runs this command now and skips this warning for the rest of the session`
  );
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
 * Windows' system-drive root, e.g. `C:\` — the read-everything analogue of
 * bwrap's `--ro-bind / /`. It is granted through MXC's *readwrite* list rather
 * than its readonly one; see `mxcPolicyJson` for why that is not a loosening.
 */
function systemDriveRoot(): string {
  const drive = process.env.SystemDrive || "C:";
  return drive.endsWith("\\") ? drive : `${drive}\\`;
}

/**
 * `command` as a `cmd.exe` command line, the way `buildSandboxedCommand`'s
 * other two branches get theirs from `sh -c`.
 *
 * `wxc-exec` takes one command-line string and hands it to CreateProcess, which
 * reads it as an image plus arguments — no shell, so `a && b` arrives at the
 * first program as literal arguments and `|`, `>`, `cd …` and the like do
 * nothing at all. This mirrors what Node's own `child_process.exec` passes on
 * Windows (`cmd.exe /d /s /c "…"`), so a sandboxed command and an unsandboxed
 * one behave the same: `/d` skips the registry AutoRun hooks, and `/s` makes
 * cmd strip only the outermost quotes so a command carrying its own quoted
 * arguments survives. Verified through wxc-exec: `&&`, `|`, `>` and nested
 * quotes (`node -e "…"`) all work, and `dir`/`echo` resolve as cmd builtins.
 */
function windowsShellCommand(command: string): string {
  return `cmd.exe /d /s /c "${command}"`;
}

/**
 * `PATH` directories the container must be able to read for `cmd.exe` to
 * resolve bare tool names such as `git`, `npm` and `node`.
 *
 * The container's `PATH` is the real, registry-derived one, so it lists
 * directories like `C:\Program Files\nodejs` — but those are `EPERM` to the
 * container until granted, so cmd.exe's lookup fails inside them and reports
 * `'node' is not recognized as an internal or external command`. Granting them
 * read-only fixes it. This is the same job MXC's own
 * `policy.filesystem.getAvailableToolsPolicy` does, and the filters below
 * follow it.
 *
 * Filtered rather than passed through wholesale:
 *  - only paths that exist and are directories,
 *  - nothing under `%SystemRoot%` — the container already has a baseline over
 *    the system directories, and MXC's helper excludes them for that reason,
 *  - never a drive root, and never a path that contains the home directory or
 *    the workspace: granting an ancestor of either aborts container creation
 *    outright (see `mxcPolicyJson`), and a `PATH` entry that contains the
 *    workspace would also contradict the read-write grant it already has.
 */
function windowsToolPaths(workspace: string): string[] {
  const home = os.homedir();
  const systemRoot = (process.env.SystemRoot || process.env.WINDIR || "C:\\Windows").replace(
    /\\+$/,
    ""
  );
  // True when `parent` is `child` or contains it.
  const contains = (parent: string, child: string): boolean => {
    const rel = path.relative(parent, child);
    return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  };
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of (process.env.PATH ?? "").split(path.delimiter)) {
    const entry = raw.trim();
    if (!entry || !path.isAbsolute(entry)) continue;
    const abs = path.resolve(entry);
    const key = abs.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    // `C:\` (and a bare `C:`) is the read-everything entry, handled separately.
    if (abs === path.parse(abs).root) continue;
    if (abs.toLowerCase() === systemRoot.toLowerCase()) continue;
    if (abs.toLowerCase().startsWith(systemRoot.toLowerCase() + "\\")) continue;
    if (contains(abs, home) || contains(abs, workspace)) continue;
    try {
      if (!fs.statSync(abs).isDirectory()) continue;
    } catch {
      continue;
    }
    out.push(abs);
  }
  return out;
}

/**
 * The MXC request for one command, as JSON. Mirrors the posture of the bwrap
 * and sandbox-exec branches below: reads stay open, writes are confined to the
 * workspace plus the same short allowlist of tool caches.
 *
 * MXC's schema is versioned and the version marker is part of the contract, so
 * this targets 1.0.0 (`schemas/stable/mxc-config.schema.1.0.0.json`).
 * `wxc-exec` validates natively and refuses a request it cannot serve, so a
 * policy that is wrong here fails the command rather than running it unconfined.
 *
 * Deliberate choices, all to keep Windows consistent with the other platforms
 * rather than stricter by accident:
 *  - The network is left open. Neither bwrap nor sandbox-exec restricts it, and
 *    a contained command that cannot reach the network cannot `npm install`,
 *    `git push`, or run a dev server. Tightening it is a cross-platform call.
 *  - The temp dir is not isolated. Windows has no tmpfs equivalent, so scratch
 *    state already persists across calls without a shared-dir bind. MXC hands
 *    the container its own writable temp dir regardless (it rewrites `TEMP` to
 *    `%LOCALAPPDATA%\Packages\sandbox.{…}\AC\Temp`), so nothing needs granting
 *    here either.
 *  - UI access stays enabled. MXC's default blocks the Win32k subsystem, and a
 *    contained process that cannot reach it dies before running a line of its
 *    own code, with STATUS_DLL_INIT_FAILED (0xC0000142) — wxc-exec names this
 *    exact setting when it reports that. bwrap and sandbox-exec do not restrict
 *    the UI either, so this is the consistent posture rather than a loosening.
 *  - The system drive root is granted as read-write, and `readonlyPaths` is
 *    omitted entirely. Both spellings are meant to say "reads stay open over
 *    the whole drive", and MXC's own `policy.filesystem.getPowerShellPolicy`
 *    emits the readonly one — but on Windows 11 24H2 that spelling aborts
 *    container creation. wxc-exec logs `process created (PID …)` and the child
 *    then exits 1 with no output, so the command silently never runs; it is
 *    reproducible with a bare `readonlyPaths: ["C:\\"]` and with the drive root
 *    added to a policy that already works. Every ancestor of the profile chain
 *    behaves the same way (`C:\Users`, `%USERPROFILE%`, `…\AppData`,
 *    `…\AppData\Local`), which is consistent with the drive root needing to be
 *    DACL-brokered for the contained token. Listing it under `readwritePaths`
 *    instead is harmless and grants what was actually intended: the command can
 *    stat `C:\` — which `node.exe`, `cmd.exe` and `pwsh.exe` all do at startup,
 *    and without which they die with `EPERM: lstat 'C:\'` — while writes to the
 *    root, to the profile and to `%USERPROFILE%` are still denied. Verified
 *    against `wxc-exec.exe` 1.0.0 on Windows 11 24H2 with a policy of exactly
 *    this shape: reads of `C:\`, `System32` and `Program Files` succeed, the
 *    workspace and the container's own temp dir are writable, and the profile
 *    root, the drive root and `C:\Windows\Temp` all stay unwritable.
 *    `readonlyPaths` carries the `PATH` tool directories from
 *    `windowsToolPaths`. MXC already gives the container a baseline over the
 *    system directories and over anything whose ACL carries an AppContainer
 *    capability SID, so most of `PATH` needs nothing said about it — but a
 *    directory outside that baseline (per-user installs such as
 *    `%APPDATA%\npm`) is `EPERM` until granted, and `cmd.exe` cannot resolve a
 *    bare `npm` or `node` that lives in one. The key is omitted rather than
 *    sent as `[]` when there is nothing to add, so a policy built without it
 *    is byte-identical to what this function produced before.
 */
export function mxcPolicyJson(
  command: string,
  workspace: string,
  writable: string[],
  readable: string[] = []
): string {
  return JSON.stringify({
    version: "1.0.0",
    containment: "processcontainer",
    process: { commandLine: command, cwd: workspace },
    filesystem: {
      // Existing paths only: the bwrap branch skips missing binds for the same
      // reason, and naming a path that is not there is a needless way to have
      // the whole request rejected. The drive root closes the list because it
      // is the read-everything entry — see the note above for why it belongs
      // here rather than in `readonlyPaths`.
      readwritePaths: [...new Set([...writable, workspace, systemDriveRoot()])],
      // Never the drive root or the profile chain — see the note above; both
      // are fatal under `readonlyPaths`.
      ...(readable.length > 0 ? { readonlyPaths: [...new Set(readable)] } : {}),
    },
    network: { egress: { default: "allow" }, ingress: { default: "allow" } },
    ui: { disable: false },
    // MXC telemetry is off unless the run opts in, the user consents, and
    // administrative policy permits it. Kritya opts out on the user's behalf.
    telemetry: { enabled: false },
  });
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

  if (tool === "mxc") {
    // Windows: hand the whole request to wxc-exec, which creates the
    // AppContainer and runs the command inside it. The policy travels as
    // base64 rather than a file — the same way MXC's own SDK passes it — so
    // there is no profile file to create, guard, or clean up. Compare the
    // symlink/TOCTOU defences the macOS branch needs for its profile: never
    // writing a policy to disk removes that whole class of problem.
    //
    // Deliberately ahead of the shared-temp-dir setup below, which creates a
    // directory as a side effect: Windows has no tmpfs to carve it out of, so
    // there is nothing for it to do here.
    const exe = mxcExecutable();
    if (!exe) return null;
    const writable = [...extraWritablePaths(), ...(gitDir ? [gitDir] : [])].filter((p) =>
      fs.existsSync(p)
    );
    // Unlike the branches below there is no `sh -c` here to give the command a
    // shell, so `windowsShellCommand` supplies the `cmd.exe` one — see its
    // note. `windowsToolPaths` supplies the read-only grants cmd.exe needs to
    // resolve bare tool names inside the container.
    return {
      cmd: exe,
      args: [
        "--config-base64",
        Buffer.from(
          mxcPolicyJson(
            windowsShellCommand(command),
            workspace,
            writable,
            windowsToolPaths(workspace)
          ),
          "utf8"
        ).toString("base64"),
      ],
    };
  }

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
  // Named with the same pid+timestamp+random suffix as runDir below, so a
  // local attacker can't pre-create/symlink the path before this call reaches
  // it (the profile itself isn't secret, but a symlinked write target could
  // otherwise redirect the profile write elsewhere via TOCTOU). `wx` makes
  // the create atomic and fails loudly on any pre-existing path — including a
  // symlink — instead of silently following it, and 0o600 keeps it
  // unreadable/unwritable by other local users in the meantime.
  const runSuffix = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const profilePath = path.join(os.tmpdir(), `kritya-sandbox-${runSuffix}.sb`);
  // A fresh, uniquely-named scratch dir for this invocation alone — exposed
  // to the command via $TMPDIR so ordinary tools that write scratch files
  // keep working even though the rest of the real temp dirs are now hidden
  // (see macSandboxProfile). Read by sandbox-exec's own profile loader before
  // confinement takes effect, so it isn't subject to the tmp-root read-deny
  // it's about to create.
  const runDir = path.join(os.tmpdir(), `kritya-sandbox-run-${runSuffix}`);
  fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    profilePath,
    macSandboxProfile(workspace, gitDir ? [gitDir] : [], shared, runDir),
    { mode: 0o600, flag: "wx" }
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
