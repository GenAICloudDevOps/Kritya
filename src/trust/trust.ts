import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { CONFIG_DIR } from "../config/config.js";

/**
 * Workspace trust. A workspace's `.kritya/settings.json` can define `allow`
 * rules (auto-approve tool calls) and `hooks` (arbitrary shell commands run
 * automatically around tool calls). Both take effect the moment kritya
 * launches in that directory, so a cloned repo could ship a settings file
 * that silently grants itself broad permissions or runs code. Before either
 * takes effect, the workspace must be explicitly trusted.
 *
 * `deny` rules are excluded from this gate — they only remove permissions,
 * never grant them — and always apply regardless of trust.
 *
 * Trust is hash-pinned: it's recorded against the exact `{allow, hooks}`
 * content that was approved. If that content changes (e.g. a later `git
 * pull` adds a hook), the hash no longer matches and the workspace is
 * treated as untrusted again.
 */

const TRUST_FILE = path.join(CONFIG_DIR, "trusted.json");

interface GatedContent {
  allow?: string[];
  hooks?: unknown;
}

function readGatedContent(workspace: string): GatedContent | null {
  const file = path.join(workspace, ".kritya", "settings.json");
  let parsed: { allow?: unknown; hooks?: unknown };
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
  const allow = Array.isArray(parsed.allow)
    ? parsed.allow.filter((r): r is string => typeof r === "string")
    : undefined;
  const hooks =
    parsed.hooks && typeof parsed.hooks === "object" ? (parsed.hooks as unknown) : undefined;
  if ((!allow || allow.length === 0) && !hooks) return null;
  return { allow, hooks };
}

/**
 * A stable hash of the workspace settings' gated content (allow + hooks), or
 * null if there's nothing to gate — no settings file, or one with neither
 * key (e.g. deny-only). A null result means trust never needs to be asked.
 */
export function gatedContentHash(workspace: string): string | null {
  const content = readGatedContent(workspace);
  if (!content) return null;
  return crypto.createHash("sha256").update(JSON.stringify(content)).digest("hex");
}

function loadTrustStore(storeFile: string): Record<string, string> {
  try {
    const parsed = JSON.parse(fs.readFileSync(storeFile, "utf8"));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

/** Whether `hash` (from {@link gatedContentHash}) matches the last-trusted hash for this workspace. */
export function isTrusted(workspace: string, hash: string, storeFile = TRUST_FILE): boolean {
  return loadTrustStore(storeFile)[path.resolve(workspace)] === hash;
}

/** Record that the workspace's current gated content is trusted. */
export function saveTrust(workspace: string, hash: string, storeFile = TRUST_FILE): void {
  const store = loadTrustStore(storeFile);
  store[path.resolve(workspace)] = hash;
  fs.mkdirSync(path.dirname(storeFile), { recursive: true });
  fs.writeFileSync(storeFile, JSON.stringify(store, null, 2) + "\n");
}
