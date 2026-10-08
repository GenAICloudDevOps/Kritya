import fs from "node:fs";
import path from "node:path";
import { CONFIG_DIR } from "../config/config.js";
import { hardenWindowsDir } from "../config/winAcl.js";
import { debugLog } from "../config/debug.js";

/**
 * When each slash command was last run, so the palette can float the ones a
 * user actually reaches for to the top (the way VS Code's recent list does).
 *
 * Deliberately keyed on *execution*, not on insertion: the palette inserts a
 * command into the input line rather than running it (a fuzzy finder that runs
 * on Enter is how conversations get cleared by accident), so a recency signal
 * recorded at insert time would rank the commands someone typed-and-abandoned
 * above the ones they ran. The write happens in `runCommand` for exactly that
 * reason.
 *
 * Only commands are tracked. Checkpoints are ephemeral (they live for one
 * session) and have no stable identity to rank across launches.
 *
 * Same persistence shape as bannerSeen.ts / aiDisclosure.ts: a JSON map under
 * ~/.kritya, 0o700 dir, 0o600 file, ACL-hardened on Windows, and a `storeFile`
 * parameter as the test seam.
 */

const RECENT_FILE = path.join(CONFIG_DIR, "recent-commands.json");

/** How many commands the file remembers. Small: this only breaks ties. */
const MAX_TRACKED = 40;

/** A command's last-use time, in epoch milliseconds. */
export type CommandRecency = Record<string, number>;

function loadStore(storeFile: string): CommandRecency {
  try {
    const parsed = JSON.parse(fs.readFileSync(storeFile, "utf8"));
    if (!parsed || typeof parsed !== "object") return {};
    const out: CommandRecency = {};
    for (const [name, at] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof at === "number" && Number.isFinite(at)) out[name] = at;
    }
    return out;
  } catch (err) {
    // Missing is normal (nothing used yet); malformed just means the ordering
    // starts fresh, which is worth being able to see but never fatal.
    debugLog(`loadStore(${storeFile})`, err);
    return {};
  }
}

/** The recorded recency map, for passing into `buildPaletteItems`. */
export function loadCommandRecency(storeFile = RECENT_FILE): CommandRecency {
  return loadStore(storeFile);
}

/**
 * Record that `name` was just run. Never throws: a palette ordering hint is
 * not worth failing a command over, so a read-only home directory degrades to
 * "the order just doesn't change".
 */
export function recordCommandUse(name: string, storeFile = RECENT_FILE, at = Date.now()): void {
  try {
    const store = loadStore(storeFile);
    store[name] = at;
    // Bound the file: keep the most recent MAX_TRACKED, drop the rest. Without
    // this it grows by one key per distinct command forever, and the names of
    // commands a user tried once a year ago are not worth a line each.
    const entries = Object.entries(store).sort((a, b) => b[1] - a[1]);
    const trimmed: CommandRecency = {};
    for (const [key, value] of entries.slice(0, MAX_TRACKED)) trimmed[key] = value;

    fs.mkdirSync(path.dirname(storeFile), { recursive: true, mode: 0o700 });
    hardenWindowsDir(path.dirname(storeFile));
    fs.writeFileSync(storeFile, JSON.stringify(trimmed, null, 2) + "\n", { mode: 0o600 });
  } catch (err) {
    debugLog(`recordCommandUse(${name})`, err);
  }
}
