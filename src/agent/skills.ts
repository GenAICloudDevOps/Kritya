import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pluginsDir, pluginSkillsRoots, scanPlugins, userPluginsDir } from "../plugins/discover.js";

export interface DiscoveredSkill {
  name: string;
  description: string;
  /** Absolute path to the skill's folder. */
  dir: string;
  /** All frontmatter fields, including name/description, for forward-compatible reads. */
  meta: Record<string, string>;
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;
const KEY_VALUE_RE = /^([A-Za-z0-9_-]+):\s*(.*)$/;
const BLOCK_SCALAR_RE = /^([A-Za-z0-9_-]+):\s*([>|])\s*$/;

/**
 * Parses a SKILL.md's leading `---`-delimited frontmatter block into a flat
 * key/value map, plus the trimmed body that follows it. Returns null when
 * there is no frontmatter block at all -- a plain markdown file, not a skill.
 */
export function parseSkillFrontmatter(
  raw: string
): { meta: Record<string, string>; body: string } | null {
  const match = FRONTMATTER_RE.exec(raw);
  if (!match) return null;
  const [, frontmatter, body] = match;
  const meta: Record<string, string> = {};
  const lines = frontmatter.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const block = BLOCK_SCALAR_RE.exec(line);
    if (block) {
      const [, key, style] = block;
      const blockLines: string[] = [];
      let j = i + 1;
      while (j < lines.length && (lines[j] === "" || /^\s/.test(lines[j]))) {
        blockLines.push(lines[j].trim());
        j++;
      }
      i = j - 1;
      meta[key] = style === "|" ? blockLines.join("\n") : foldBlockLines(blockLines);
      continue;
    }
    const kv = KEY_VALUE_RE.exec(line);
    if (kv) meta[kv[1]] = unquote(kv[2].trim());
  }
  return { meta, body: body.trim() };
}

/**
 * Simplified YAML folded-scalar (`>`) join: consecutive non-blank lines
 * become one space-joined line; a blank line forces a line break. Real YAML
 * folding has more edge cases (indentation-sensitive literal lines, trailing
 * newline "chomping") that this doesn't attempt.
 */
function foldBlockLines(lines: string[]): string {
  const paragraphs: string[][] = [[]];
  for (const line of lines) {
    if (line === "") paragraphs.push([]);
    else paragraphs[paragraphs.length - 1].push(line);
  }
  return paragraphs
    .map((p) => p.join(" "))
    .filter((p) => p !== "")
    .join("\n");
}

/**
 * Strips a single matching pair of enclosing quotes from a frontmatter value
 * and unescapes `\"`/`\\` inside a double-quoted value -- just enough to let
 * a description contain a colon or apostrophe without breaking the parser.
 * True multi-line YAML block scalars are still not supported.
 */
function unquote(value: string): string {
  if (value.length >= 2 && value[0] === '"' && value[value.length - 1] === '"') {
    return value.slice(1, -1).replace(/\\(["\\])/g, "$1");
  }
  if (value.length >= 2 && value[0] === "'" && value[value.length - 1] === "'") {
    return value.slice(1, -1);
  }
  return value;
}

let warnSink: (message: string) => void = (message) => {
  process.stderr.write(`kritya: ${message}\n`);
};

function warn(message: string): void {
  warnSink(message);
}

/** For testing: override the warning sink. Returns the previous sink. */
export function _setWarnSink(sink: (message: string) => void): (message: string) => void {
  const prev = warnSink;
  warnSink = sink;
  return prev;
}

export interface SkippedSkill {
  /** The folder name -- often the problem itself, e.g. when it doesn't match the frontmatter name. */
  name: string;
  dir: string;
  reason: string;
}

export interface SkillScanResult {
  loaded: DiscoveredSkill[];
  skipped: SkippedSkill[];
}

/**
 * Scans each root for `<name>/SKILL.md` folders, in name order, and reports
 * both what loaded and why anything didn't (used by `kritya skills` to help
 * authors debug a skill that isn't showing up). Roots that don't exist are
 * skipped silently -- an unconfigured skills directory isn't noteworthy. A
 * folder without a SKILL.md is not a skill and isn't reported at all. On a
 * name collision across or within roots, the first one found wins.
 */
export function scanSkillsDetailed(roots: string[]): SkillScanResult {
  const seen = new Map<string, DiscoveredSkill>();
  const skipped: SkippedSkill[] = [];
  for (const root of roots) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    const dirs = entries
      .filter((e) => e.isDirectory())
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of dirs) {
      const dir = path.join(root, entry.name);
      const skillFile = path.join(dir, "SKILL.md");
      let raw: string;
      try {
        raw = fs.readFileSync(skillFile, "utf8");
      } catch {
        continue;
      }
      const parsed = parseSkillFrontmatter(raw);
      if (!parsed) {
        skipped.push({ name: entry.name, dir, reason: "missing frontmatter block" });
        continue;
      }
      const { meta } = parsed;
      if (!meta.name || !meta.description) {
        skipped.push({
          name: entry.name,
          dir,
          reason: 'frontmatter must include "name" and "description"',
        });
        continue;
      }
      if (meta.disabled === "true") {
        skipped.push({ name: entry.name, dir, reason: "disabled: true" });
        continue;
      }
      if (meta.name !== entry.name) {
        skipped.push({
          name: entry.name,
          dir,
          reason: `folder name "${entry.name}" does not match frontmatter name "${meta.name}"`,
        });
        continue;
      }
      const existing = seen.get(meta.name);
      if (existing) {
        skipped.push({
          name: entry.name,
          dir,
          reason: `duplicate skill name "${meta.name}" (already loaded from ${existing.dir})`,
        });
        continue;
      }
      seen.set(meta.name, { name: meta.name, description: meta.description, dir, meta });
    }
  }
  return { loaded: [...seen.values()], skipped };
}

/**
 * Same scan as scanSkillsDetailed, but for the common case that only wants
 * the loaded list, warning (once per skip) about anything malformed. A
 * disabled skill is intentional, not a mistake, so it doesn't warn.
 */
export function scanSkills(roots: string[]): DiscoveredSkill[] {
  const { loaded, skipped } = scanSkillsDetailed(roots);
  for (const s of skipped) {
    if (s.reason === "disabled: true") continue;
    warn(`skipping ${path.join(s.dir, "SKILL.md")}: ${s.reason}`);
  }
  return loaded;
}

export function skillsDir(workspace: string): string {
  return path.join(workspace, ".kritya", "skills");
}

/** User-global skills root, available across all workspaces. */
export function userSkillsDir(): string {
  return path.join(os.homedir(), ".kritya", "skills");
}

/**
 * Skill roots contributed by discovered Agent Plugins (workspace, then
 * user-global), in addition to the plain skills dirs.
 *
 * `trustWorkspace` gates the workspace-controlled sources only (the
 * workspace's own .kritya/skills — added by the caller, not here — and any
 * plugins it ships under .kritya/plugins): a full skill or plugin body is
 * arbitrary instructions the model then follows, so an untrusted workspace
 * (e.g. a freshly cloned repo) must not be able to smuggle one in before the
 * user has approved it. Defaults to true so existing callers that don't pass
 * it (tests, ad-hoc scans) keep today's behavior.
 */
export function defaultExtraSkillRoots(workspace: string, trustWorkspace = true): string[] {
  const plugins = scanPlugins(
    trustWorkspace ? [pluginsDir(workspace), userPluginsDir()] : [userPluginsDir()]
  );
  return [userSkillsDir(), ...pluginSkillsRoots(plugins).map((r) => r.dir)];
}

/**
 * The system-prompt fragment listing discovered skills by name+description
 * only (progressive disclosure -- full instructions load via load_skill).
 * Returns "" when there are none, so non-skill workspaces pay zero prompt cost.
 * The project root is scanned before any extra roots, so a project skill
 * wins over a same-named user-global one.
 */
export function buildSkillsSection(
  workspace: string,
  extraRoots: string[] = defaultExtraSkillRoots(workspace),
  trustWorkspace = true
): string {
  // .kritya/skills is workspace-controlled -- same trust gate as KRITYA.md.
  const skills = scanSkills([...(trustWorkspace ? [skillsDir(workspace)] : []), ...extraRoots]);
  if (!skills.length) return "";
  const lines = skills.map((s) => `- ${s.name}: ${s.description}`).join("\n");
  return `\n# Available skills\n${lines}\nCall load_skill with the skill name when a task matches one of these.\n`;
}
