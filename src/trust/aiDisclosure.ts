import fs from "node:fs";
import path from "node:path";
import { CONFIG_DIR } from "../config/config.js";
import { hardenWindowsDir } from "../config/winAcl.js";
import { debugLog } from "../config/debug.js";

/**
 * Tracks which workspaces have already seen the one-time "kritya is an AI
 * agent" notice (see AiDisclosurePrompt.tsx), keyed by resolved workspace
 * path — same shape and persistence pattern as trust.ts's trusted.json, so a
 * dismissal in one workspace doesn't suppress the notice in every other one.
 */

const DISCLOSURE_FILE = path.join(CONFIG_DIR, "ai-disclosure.json");

function loadStore(storeFile: string): Record<string, boolean> {
  try {
    const parsed = JSON.parse(fs.readFileSync(storeFile, "utf8"));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, boolean>) : {};
  } catch (err) {
    // A missing file means "not shown anywhere yet" (normal); a malformed one
    // means every workspace re-shows the notice, worth being able to see.
    debugLog(`loadStore(${storeFile})`, err);
    return {};
  }
}

/** Whether the AI disclosure notice has already been shown and dismissed for this workspace. */
export function isAiDisclosureShown(workspace: string, storeFile = DISCLOSURE_FILE): boolean {
  return loadStore(storeFile)[path.resolve(workspace)] === true;
}

/** Record that the AI disclosure notice has been shown and dismissed for this workspace. */
export function markAiDisclosureShown(workspace: string, storeFile = DISCLOSURE_FILE): void {
  const store = loadStore(storeFile);
  store[path.resolve(workspace)] = true;
  fs.mkdirSync(path.dirname(storeFile), { recursive: true, mode: 0o700 });
  hardenWindowsDir(path.dirname(storeFile));
  fs.writeFileSync(storeFile, JSON.stringify(store, null, 2) + "\n", { mode: 0o600 });
}
