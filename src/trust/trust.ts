import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { CONFIG_DIR } from "../config/config.js";

/**
 * Workspace trust. A workspace's `.kritya/settings.json` can define `allow`
 * rules (auto-approve tool calls) and `hooks` (arbitrary shell commands run
 * automatically around tool calls); it can also ship a `.env` file (env vars
 * merged into the process, read by every shell command and MCP server) and
 * `.kritya/commands/*.md` (custom slash commands — attacker-authored prompts
 * run with the user's standing permissions). All of these take effect the
 * moment kritya launches in that directory, so a cloned repo could use any of
 * them to silently grant itself broad permissions or run code. Before any of
 * them takes effect, the workspace must be explicitly trusted.
 *
 * `deny` rules are excluded from this gate — they only remove permissions,
 * never grant them — and always apply regardless of trust.
 *
 * Trust is hash-pinned: it's recorded against the exact gated content that
 * was approved. If that content changes (e.g. a later `git pull` adds a hook
 * or edits `.env`), the hash no longer matches and the workspace is treated
 * as untrusted again.
 */

const TRUST_FILE = path.join(CONFIG_DIR, "trusted.json");

interface GatedContent {
  allow?: string[];
  hooks?: unknown;
  /** Raw content of the workspace .env file, if present (hashed, not parsed). */
  env?: string;
  /** Raw content of each .kritya/commands/*.md file, if any, keyed by filename. */
  commands?: Record<string, string>;
}

function readSettingsGatedContent(workspace: string): { allow?: string[]; hooks?: unknown } {
  const file = path.join(workspace, ".kritya", "settings.json");
  let parsed: { allow?: unknown; hooks?: unknown };
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
  const allow = Array.isArray(parsed.allow)
    ? parsed.allow.filter((r): r is string => typeof r === "string")
    : undefined;
  const hooks =
    parsed.hooks && typeof parsed.hooks === "object" ? (parsed.hooks as unknown) : undefined;
  return { allow, hooks };
}

function readEnvFile(workspace: string): string | undefined {
  try {
    return fs.readFileSync(path.join(workspace, ".env"), "utf8");
  } catch {
    return undefined;
  }
}

function readCommandFiles(workspace: string): Record<string, string> | undefined {
  const dir = path.join(workspace, ".kritya", "commands");
  let files: string[];
  try {
    files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".md"))
      .sort();
  } catch {
    return undefined;
  }
  if (!files.length) return undefined;
  const commands: Record<string, string> = {};
  for (const f of files) {
    try {
      commands[f] = fs.readFileSync(path.join(dir, f), "utf8");
    } catch {
      // Unreadable file — skip it rather than fail the whole hash.
    }
  }
  return Object.keys(commands).length ? commands : undefined;
}

function readGatedContent(workspace: string): GatedContent | null {
  const { allow, hooks } = readSettingsGatedContent(workspace);
  const env = readEnvFile(workspace);
  const commands = readCommandFiles(workspace);
  if ((!allow || allow.length === 0) && !hooks && env === undefined && !commands) return null;
  return { allow, hooks, env, commands };
}

/**
 * A stable hash of the workspace's gated content (allow rules, hooks, .env,
 * and custom command files), or null if there's nothing to gate. A null
 * result means trust never needs to be asked.
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
  fs.mkdirSync(path.dirname(storeFile), { recursive: true, mode: 0o700 });
  fs.writeFileSync(storeFile, JSON.stringify(store, null, 2) + "\n", { mode: 0o600 });
}
