import fs from "node:fs";
import path from "node:path";
import {
  defaultExtraSkillRoots,
  parseSkillFrontmatter,
  scanSkills,
  skillsDir,
} from "../agent/skills.js";
import type { ToolDef } from "../types.js";
import { truncateResult } from "./common.js";

const BUNDLE_DIRS = ["scripts", "references", "assets"] as const;

function listBundledFiles(skillDir: string): string {
  const sections: string[] = [];
  for (const sub of BUNDLE_DIRS) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(path.join(skillDir, sub), { withFileTypes: true });
    } catch {
      continue;
    }
    if (!entries.length) continue;
    const names = entries.map((e) => `  ${e.name}${e.isDirectory() ? "/" : ""}`).join("\n");
    sections.push(`${sub}/\n${names}`);
  }
  return sections.join("\n\n");
}

export const loadSkillTool: ToolDef = {
  name: "load_skill",
  description:
    "Load the full instructions for an available skill by name. Call this when a task matches a skill listed in the system prompt.",
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: "The skill's name, as listed in the system prompt" },
    },
    required: ["name"],
  },
  requiresPermission: false,
  summarize: (args) => `Load skill "${args.name}"`,
  async execute(args, ctx) {
    const name = String(args.name ?? "");
    // Re-scan on every call (no session-start caching) so a skill added
    // mid-session is usable immediately -- cheap since these are a handful
    // of small file reads.
    const skills = scanSkills([skillsDir(ctx.workspace), ...defaultExtraSkillRoots(ctx.workspace)]);
    const skill = skills.find((s) => s.name === name);
    if (!skill) {
      const available = skills.map((s) => s.name).join(", ") || "(none)";
      // Throwing (rather than returning an "Error: ..." string) matches this
      // codebase's convention (see resolveSafe): the agent loop's catch path
      // marks the call failed and formats the message for the model.
      throw new Error(`skill "${name}" not found. Available: ${available}`);
    }
    // skill.dir came from scanSkills' own directory listing, never from the
    // model-supplied `name` -- a hallucinated/malicious name can only fail
    // the lookup above, never build a path.
    const raw = fs.readFileSync(path.join(skill.dir, "SKILL.md"), "utf8");
    const parsed = parseSkillFrontmatter(raw);
    const body = parsed?.body ?? "";
    const bundled = listBundledFiles(skill.dir);
    return truncateResult(bundled ? `${body}\n\n# Bundled files\n${bundled}` : body);
  },
};
