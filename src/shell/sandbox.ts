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
  if (mode === "always") return true;
  return classifyDanger(command) !== null;
}

function macSandboxProfile(workspace: string): string {
  const esc = (p: string) => p.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
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

  if (tool === "bwrap") {
    return {
      cmd: "bwrap",
      args: [
        "--ro-bind",
        "/",
        "/",
        "--dev",
        "/dev",
        "--proc",
        "/proc",
        "--tmpfs",
        "/tmp",
        "--bind",
        workspace,
        workspace,
        "--chdir",
        workspace,
        "--unshare-pid",
        "--die-with-parent",
        "sh",
        "-c",
        command,
      ],
    };
  }

  // sandbox-exec (macOS) takes its policy as a profile file, not inline args.
  const profilePath = path.join(os.tmpdir(), `kritya-sandbox-${process.pid}-${Date.now()}.sb`);
  fs.writeFileSync(profilePath, macSandboxProfile(workspace));
  return {
    cmd: "sandbox-exec",
    args: ["-f", profilePath, "sh", "-c", command],
    cleanup: () => fs.rm(profilePath, { force: true }, () => {}),
  };
}
