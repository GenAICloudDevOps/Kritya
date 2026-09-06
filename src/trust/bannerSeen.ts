import fs from "node:fs";
import path from "node:path";
import { CONFIG_DIR } from "../config/config.js";
import { hardenWindowsDir } from "../config/winAcl.js";
import { debugLog } from "../config/debug.js";

/**
 * Tracks which workspaces have already shown the full ASCII banner once, so
 * repeat launches (which cost real vertical space in a terminal) can fall
 * back to a compact one-line header instead. Same shape and persistence
 * pattern as aiDisclosure.ts's ai-disclosure.json.
 */

const BANNER_FILE = path.join(CONFIG_DIR, "banner-seen.json");

function loadStore(storeFile: string): Record<string, string> {
  try {
    const parsed = JSON.parse(fs.readFileSync(storeFile, "utf8"));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, string>) : {};
  } catch (err) {
    // A missing file means "not shown anywhere yet" (normal); a malformed one
    // means every workspace re-shows the full banner, worth being able to see.
    debugLog(`loadStore(${storeFile})`, err);
    return {};
  }
}

/** Whether the full ASCII banner has already been shown for this workspace. */
export function isBannerSeen(workspace: string, storeFile = BANNER_FILE): boolean {
  return typeof loadStore(storeFile)[path.resolve(workspace)] === "string";
}

/** Record that the full ASCII banner has been shown for this workspace, now. */
export function markBannerSeen(workspace: string, storeFile = BANNER_FILE): void {
  const store = loadStore(storeFile);
  store[path.resolve(workspace)] = new Date().toISOString();
  fs.mkdirSync(path.dirname(storeFile), { recursive: true, mode: 0o700 });
  hardenWindowsDir(path.dirname(storeFile));
  fs.writeFileSync(storeFile, JSON.stringify(store, null, 2) + "\n", { mode: 0o600 });
}
