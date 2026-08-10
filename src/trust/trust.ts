import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { CONFIG_DIR } from "../config/config.js";
import { hardenWindowsDir } from "../config/winAcl.js";
import { debugLog } from "../config/debug.js";

/**
 * Workspace trust. A workspace's `.kritya/settings.json` can define `allow`
 * rules (auto-approve tool calls) and `hooks` (arbitrary shell commands run
 * automatically around tool calls); it can also ship a `.env` file (env vars
 * merged into the process, read by every shell command and MCP server),
 * `.kritya/commands/*.md` (custom slash commands — attacker-authored prompts
 * run with the user's standing permissions), `.mcp.json` (MCP servers —
 * arbitrary processes launched, or remote endpoints contacted with the user's
 * env-expanded credentials), `KRITYA.md` (project memory — read straight into
 * the system prompt on every turn, so it's the highest-leverage prompt
 * injection surface a cloned repo can ship), and `.kritya/skills/*.md`
 * (skills — extra instructions the model can pull in mid-session, same risk
 * as a custom command). All of these take effect the
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
  /** Raw content of the workspace .mcp.json file, if present (hashed, not parsed). */
  mcp?: string;
  /** Raw content of the workspace KRITYA.md file, if present — read into the system prompt. */
  memory?: string;
  /** Raw content of each .kritya/skills/<name>/SKILL.md file, keyed by skill dir name. */
  skills?: Record<string, string>;
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

function readMcpFile(workspace: string): string | undefined {
  try {
    return fs.readFileSync(path.join(workspace, ".mcp.json"), "utf8");
  } catch {
    return undefined;
  }
}

/**
 * Raw content of KRITYA.md, if present. It's read straight into the system
 * prompt and followed as an instruction (see src/agent/systemPrompt.ts), so
 * it's gated on trust the same as an allow rule or a hook.
 */
function readMemoryFile(workspace: string): string | undefined {
  try {
    return fs.readFileSync(path.join(workspace, "KRITYA.md"), "utf8");
  } catch {
    return undefined;
  }
}

/**
 * Raw content of each .kritya/skills/<name>/SKILL.md file, keyed by the skill's
 * directory name. A skill's full body is arbitrary instructions the model
 * pulls in mid-session via load_skill (see src/tools/skills.ts) — same risk
 * shape as a custom slash command.
 */
function readSkillFiles(workspace: string): Record<string, string> | undefined {
  const dir = path.join(workspace, ".kritya", "skills");
  let entries: string[];
  try {
    entries = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    return undefined;
  }
  if (!entries.length) return undefined;
  const skills: Record<string, string> = {};
  for (const name of entries) {
    try {
      skills[name] = fs.readFileSync(path.join(dir, name, "SKILL.md"), "utf8");
    } catch {
      // No SKILL.md in this subdir, or unreadable — skip it rather than fail
      // the whole hash.
    }
  }
  return Object.keys(skills).length ? skills : undefined;
}

function readGatedContent(workspace: string): GatedContent | null {
  const { allow, hooks } = readSettingsGatedContent(workspace);
  const env = readEnvFile(workspace);
  const commands = readCommandFiles(workspace);
  const mcp = readMcpFile(workspace);
  const memory = readMemoryFile(workspace);
  const skills = readSkillFiles(workspace);
  if (
    (!allow || allow.length === 0) &&
    !hooks &&
    env === undefined &&
    !commands &&
    mcp === undefined &&
    memory === undefined &&
    !skills
  )
    return null;
  return { allow, hooks, env, commands, mcp, memory, skills };
}

/**
 * A human-readable rendering of ALL the gated content, for the trust prompt.
 * The user must be able to see everything they're approving — not just
 * settings.json but the .env contents and each custom command file.
 */
export function describeGatedContent(workspace: string): string {
  const { allow, hooks } = readSettingsGatedContent(workspace);
  const env = readEnvFile(workspace);
  const commands = readCommandFiles(workspace);
  const sections: string[] = [];
  if ((allow && allow.length > 0) || hooks) {
    sections.push(
      `.kritya/settings.json (allow rules / hooks):\n${JSON.stringify({ allow, hooks }, null, 2)}`
    );
  }
  if (env !== undefined) {
    sections.push(`.env (loaded into the environment of every command):\n${env.trimEnd()}`);
  }
  if (commands) {
    const list = Object.entries(commands)
      .map(([file, body]) => {
        const first = body.split("\n")[0]?.trim().slice(0, 80) ?? "";
        return `  /${file.replace(/\.md$/, "")} — ${first || "(empty)"}`;
      })
      .join("\n");
    sections.push(`.kritya/commands/ (custom slash commands — prompts run as you):\n${list}`);
  }
  const mcp = readMcpFile(workspace);
  if (mcp !== undefined) {
    sections.push(
      `.mcp.json (MCP servers — processes launched / endpoints contacted as you):\n${mcp.trimEnd()}`
    );
  }
  const memory = readMemoryFile(workspace);
  if (memory !== undefined) {
    sections.push(
      `KRITYA.md (project memory — read into the system prompt and followed as an instruction):\n${memory.trimEnd()}`
    );
  }
  const skills = readSkillFiles(workspace);
  if (skills) {
    const list = Object.entries(skills)
      .map(([name, body]) => {
        const first = body.split("\n")[0]?.trim().slice(0, 80) ?? "";
        return `  ${name} — ${first || "(empty)"}`;
      })
      .join("\n");
    sections.push(
      `.kritya/skills/ (custom skills — instructions the model can load mid-session):\n${list}`
    );
  }
  return sections.join("\n\n") || "(no gated content)";
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
  } catch (err) {
    // A missing file means "nothing trusted yet" (normal); a malformed one
    // means every workspace re-prompts for trust, worth being able to see.
    debugLog(`loadTrustStore(${storeFile})`, err);
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
  hardenWindowsDir(path.dirname(storeFile));
  fs.writeFileSync(storeFile, JSON.stringify(store, null, 2) + "\n", { mode: 0o600 });
}
