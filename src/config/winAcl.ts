import { spawnSync } from "node:child_process";
import os from "node:os";

/**
 * chmod's 0o600/0o700 modes are no-ops on NTFS — Windows access control
 * lives in ACLs, not POSIX mode bits — so on Windows the secrets under
 * CONFIG_DIR (config.json, trusted.json, mcp-trusted.json, session
 * transcripts) would otherwise rely solely on the default per-user-profile
 * ACL, giving no equivalent of the chmod-based owner-only isolation used on
 * Linux/macOS. This strips inherited ACEs from the directory and grants full
 * control, inheritable to everything created under it afterward, to only the
 * current user and SYSTEM.
 *
 * Cached per-path per-process: the inheritable grant covers files and
 * subdirectories created later, so this only needs to run once per directory
 * per run rather than on every write.
 */
const hardenedDirs = new Set<string>();

function currentUserAccount(): string {
  if (process.env.USERDOMAIN && process.env.USERNAME) {
    return `${process.env.USERDOMAIN}\\${process.env.USERNAME}`;
  }
  return os.userInfo().username;
}

export function hardenWindowsDir(dirPath: string): void {
  if (os.platform() !== "win32") return;
  if (hardenedDirs.has(dirPath)) return;
  hardenedDirs.add(dirPath);
  try {
    const user = currentUserAccount();
    spawnSync(
      "icacls",
      [dirPath, "/inheritance:r", "/grant:r", `${user}:(OI)(CI)F`, "/grant:r", "SYSTEM:(OI)(CI)F"],
      { stdio: "ignore", windowsHide: true }
    );
  } catch {
    // Best-effort — if icacls is unavailable, isolation still falls back to
    // the default user-profile ACLs.
  }
}
