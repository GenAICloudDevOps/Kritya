import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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
  for (const line of frontmatter.split(/\r?\n/)) {
    const kv = KEY_VALUE_RE.exec(line);
    if (kv) meta[kv[1]] = unquote(kv[2].trim());
  }
  return { meta, body: body.trim() };
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

/**
 * Scans each root for `<name>/SKILL.md` folders, in name order. Roots that
 * don't exist are skipped silently -- an unconfigured skills directory is not
 * a warning-worthy condition. A folder without a SKILL.md is not a skill and
 * is skipped without comment; a SKILL.md that IS present but malformed (no
 * frontmatter, or missing name/description) is skipped with a warning, since
 * that's a mistake in the user's own skill file they'd want to know about.
 * On a name collision across or within roots, the first one found wins and
 * the rest are skipped with a warning.
 */
export function scanSkills(roots: string[]): DiscoveredSkill[] {
  const seen = new Map<string, DiscoveredSkill>();
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
        warn(`skipping ${skillFile}: missing frontmatter block`);
        continue;
      }
      const { meta } = parsed;
      if (!meta.name || !meta.description) {
        warn(`skipping ${skillFile}: frontmatter must include "name" and "description"`);
        continue;
      }
      if (meta.disabled === "true") continue;
      if (meta.name !== entry.name) {
        warn(
          `skipping ${skillFile}: folder name "${entry.name}" does not match frontmatter name "${meta.name}"`
        );
        continue;
      }
      const existing = seen.get(meta.name);
      if (existing) {
        warn(
          `skipping ${skillFile}: duplicate skill name "${meta.name}" (already loaded from ${existing.dir})`
        );
        continue;
      }
      seen.set(meta.name, { name: meta.name, description: meta.description, dir, meta });
    }
  }
  return [...seen.values()];
}

export function skillsDir(workspace: string): string {
  return path.join(workspace, ".kritya", "skills");
}

/** User-global skills root, available across all workspaces. */
export function userSkillsDir(): string {
  return path.join(os.homedir(), ".kritya", "skills");
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
  extraRoots: string[] = [userSkillsDir()]
): string {
  const skills = scanSkills([skillsDir(workspace), ...extraRoots]);
  if (!skills.length) return "";
  const lines = skills.map((s) => `- ${s.name}: ${s.description}`).join("\n");
  return `\n# Available skills\n${lines}\nCall load_skill with the skill name when a task matches one of these.\n`;
}
