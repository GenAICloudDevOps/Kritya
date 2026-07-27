import path from "node:path";
import { scanSkillsDetailed, skillsDir, userSkillsDir } from "./skills.js";

export const SKILLS_USAGE = `kritya skills — list and validate discovered skills

Usage:
  kritya skills [dir]              list skills visible from [dir] (default: current directory)
  kritya skills [dir] --json       machine-readable output
  kritya skills [dir] --validate   exit non-zero if any skill is malformed

Skills are discovered from <dir>/.kritya/skills (project) and ~/.kritya/skills
(user-global); a project skill wins over a same-named user-global one.`;

const DESCRIPTION_TRUNCATE = 60;

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** Handles `kritya skills ...`. Returns the process exit code. */
export function runSkillsCli(argv: string[], opts: { userRoot?: string } = {}): number {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(SKILLS_USAGE);
    return 0;
  }
  const json = argv.includes("--json");
  const validate = argv.includes("--validate");
  const dirArg = argv.find((a) => !a.startsWith("-"));
  const workspace = path.resolve(dirArg ?? ".");

  const projectRoot = skillsDir(workspace);
  const userRoot = opts.userRoot ?? userSkillsDir();
  const { loaded, skipped } = scanSkillsDetailed([projectRoot, userRoot]);

  const rows = loaded.map((s) => ({
    name: s.name,
    source: s.dir.startsWith(projectRoot + path.sep) || s.dir === projectRoot ? "project" : "user",
    description: s.description,
  }));
  const skips = skipped.map((s) => ({ name: s.name, reason: s.reason }));

  if (json) {
    console.log(JSON.stringify({ skills: rows, skipped: skips }, null, 2));
  } else if (!rows.length && !skips.length) {
    console.log(`No skills found under ${projectRoot} or ${userRoot}`);
  } else {
    const nameWidth = Math.max(
      4,
      ...rows.map((r) => r.name.length),
      ...skips.map((s) => s.name.length)
    );
    for (const r of rows) {
      console.log(
        `  ${r.name.padEnd(nameWidth)}   (${r.source})  ${truncate(r.description, DESCRIPTION_TRUNCATE)}`
      );
    }
    for (const s of skips) {
      console.log(`  ${s.name.padEnd(nameWidth)}   SKIPPED: ${s.reason}`);
    }
  }

  return validate && skips.length ? 1 : 0;
}
