import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { classifyDanger } from "../permissions/danger.js";

export type SandboxMode = "auto" | "always" | "off";

export interface SandboxedCommand {
  cmd: string;
  args: string[];
  /** Removes any temp file (e.g. a macOS sandbox profile) created for this run. */
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
      // ~/.ssh: git push/clone over SSH writes known_hosts the first time a host
      // is seen. ~/.config and ~/.local: XDG dirs used by gh, pip --user, etc.
      // ~/.gnupg: GPG-signed commits need to write to the agent socket dir.
      ".ssh",
      ".config",
      ".local",
      ".gnupg",
    ]
      .map((d) => path.join(home, d))
      // macOS-only, but harmless elsewhere: the bwrap branch skips paths that
      // don't exist, and the macOS profile tolerates nonexistent subpaths.
      .concat([path.join(home, "Library", "Caches")])
  );
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

function macSandboxProfile(workspace: string, extraDirs: string[]): string {
  const esc = (p: string) => p.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const extra = [...extraWritablePaths(), ...extraDirs]
    .map((p) => `(allow file-write* (subpath "${esc(p)}"))`)
    .join("\n");
  // Reads and process exec/fork stay open (matches the Linux ro-bind-everything
  // posture below); writes are denied everywhere except the workspace and
  // system temp dirs, so a command can't damage anything outside the project.
  return `(version 1)
(allow default)
(deny file-write* (subpath "/"))
(allow file-write* (subpath "${esc(workspace)}"))
(allow file-write* (subpath "/tmp"))
(allow file-write* (subpath "/private/tmp"))
(allow file-write* (subpath "/private/var/folders"))
${extra}
`;
}

/**
 * Wraps `command` (run via `sh -c`) so it's confined to `workspace`: writes
 * are blocked everywhere else, network and reads are left open. This
 * contains accidental or malicious damage outside the project — it does not
 * stop a command from reading files the real user can read (e.g. `cat
 * ~/.ssh/id_rsa`), since restricting reads breaks most ordinary tooling
 * (dynamic linking, package manager caches, etc.). Returns null if no
 * sandbox binary is available on this platform.
 */
export function buildSandboxedCommand(command: string, workspace: string): SandboxedCommand | null {
  const tool = sandboxTool();
  if (!tool) return null;

  // Linked worktrees / submodules keep their real git dir outside the workspace.
  const gitDir = externalGitCommonDir(workspace);

  if (tool === "bwrap") {
    // --bind (not --tmpfs) for /tmp: a fresh empty /tmp per invocation would
    // make anything a command writes there invisible to the next shell call,
    // and macOS's profile already allows the real /tmp. Keep them consistent.
    const args = [
      "--ro-bind",
      "/",
      "/",
      "--dev",
      "/dev",
      "--proc",
      "/proc",
      "--bind",
      "/tmp",
      "/tmp",
    ];
    for (const p of [...extraWritablePaths(), ...(gitDir ? [gitDir] : [])]) {
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
  fs.writeFileSync(profilePath, macSandboxProfile(workspace, gitDir ? [gitDir] : []));
  return {
    cmd: "sandbox-exec",
    args: ["-f", profilePath, "sh", "-c", command],
    cleanup: () => fs.rm(profilePath, { force: true }, () => {}),
  };
}
