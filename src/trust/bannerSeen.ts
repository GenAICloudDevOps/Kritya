import fs from "node:fs";
import path from "node:path";
import { CONFIG_DIR } from "../config/config.js";
import { hardenWindowsDir } from "../config/winAcl.js";
import { debugLog } from "../config/debug.js";

/**
 * Tracks which workspaces have already been opened once.
 *
 * The full ASCII banner itself no longer consults this — it renders on every
 * launch, because the compact one-line fallback it used to select made repeat
 * launches look broken. What remains gated on it is the first-run
 * "Try asking:" hint block in App.tsx, which is genuine onboarding text and
 * would be noise on every subsequent launch. Same shape and persistence
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

/** Whether this workspace has been opened before (drives the first-run hints). */
export function isBannerSeen(workspace: string, storeFile = BANNER_FILE): boolean {
  return typeof loadStore(storeFile)[path.resolve(workspace)] === "string";
}

/** Record that this workspace has been opened, now. */
export function markBannerSeen(workspace: string, storeFile = BANNER_FILE): void {
  const store = loadStore(storeFile);
  store[path.resolve(workspace)] = new Date().toISOString();
  fs.mkdirSync(path.dirname(storeFile), { recursive: true, mode: 0o700 });
  hardenWindowsDir(path.dirname(storeFile));
  fs.writeFileSync(storeFile, JSON.stringify(store, null, 2) + "\n", { mode: 0o600 });
}
