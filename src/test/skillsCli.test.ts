import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { runSkillsCli } from "../agent/skillsCli.js";
import { skillsDir } from "../agent/skills.js";

function tmpWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "kritya-skillscli-"));
}

function writeSkill(
  root: string,
  name: string,
  opts: { description?: string; extraFrontmatter?: string } = {}
): void {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  const lines = ["---", `name: ${name}`, `description: ${opts.description ?? "a skill"}`];
  if (opts.extraFrontmatter) lines.push(opts.extraFrontmatter);
  lines.push("---", "", `Instructions for ${name}.`);
  fs.writeFileSync(path.join(dir, "SKILL.md"), lines.join("\n"));
}

function captureStdout(fn: () => number): { code: number; output: string } {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...args: unknown[]) => lines.push(args.join(" "));
  try {
    const code = fn();
    return { code, output: lines.join("\n") };
  } finally {
    console.log = orig;
  }
}

test("runSkillsCli lists a project skill with its description", () => {
  const ws = tmpWorkspace();
  const emptyUserRoot = tmpWorkspace();
  writeSkill(skillsDir(ws), "ratio-analysis", { description: "Compute financial ratios" });
  const { code, output } = captureStdout(() => runSkillsCli([ws], { userRoot: emptyUserRoot }));
  assert.equal(code, 0);
  assert.match(output, /ratio-analysis/);
  assert.match(output, /\(project\)/);
  assert.match(output, /Compute financial ratios/);
});

test("runSkillsCli tags a user-global skill as (user)", () => {
  const ws = tmpWorkspace();
  const userRoot = tmpWorkspace();
  writeSkill(userRoot, "global-skill", { description: "Available everywhere" });
  const { output } = captureStdout(() => runSkillsCli([ws], { userRoot }));
  assert.match(output, /global-skill/);
  assert.match(output, /\(user\)/);
});

test("runSkillsCli lists a skipped skill with its reason", () => {
  const ws = tmpWorkspace();
  const emptyUserRoot = tmpWorkspace();
  writeSkill(skillsDir(ws), "old-helper", { extraFrontmatter: "disabled: true" });
  const { output } = captureStdout(() => runSkillsCli([ws], { userRoot: emptyUserRoot }));
  assert.match(output, /old-helper/);
  assert.match(output, /SKIPPED: disabled: true/);
});

test("runSkillsCli --json emits machine-readable skills and skipped arrays", () => {
  const ws = tmpWorkspace();
  const emptyUserRoot = tmpWorkspace();
  writeSkill(skillsDir(ws), "ratio-analysis", { description: "Compute financial ratios" });
  writeSkill(skillsDir(ws), "old-helper", { extraFrontmatter: "disabled: true" });
  const { output } = captureStdout(() => runSkillsCli([ws, "--json"], { userRoot: emptyUserRoot }));
  const parsed = JSON.parse(output);
  assert.equal(parsed.skills[0].name, "ratio-analysis");
  assert.equal(parsed.skills[0].source, "project");
  assert.equal(parsed.skipped[0].name, "old-helper");
  assert.equal(parsed.skipped[0].reason, "disabled: true");
});

test("runSkillsCli --validate exits non-zero when a skill is malformed", () => {
  const ws = tmpWorkspace();
  const emptyUserRoot = tmpWorkspace();
  writeSkill(skillsDir(ws), "old-helper", { extraFrontmatter: "disabled: true" });
  const { code } = captureStdout(() =>
    runSkillsCli([ws, "--validate"], { userRoot: emptyUserRoot })
  );
  assert.equal(code, 1);
});

test("runSkillsCli --validate exits zero when every skill loaded cleanly", () => {
  const ws = tmpWorkspace();
  const emptyUserRoot = tmpWorkspace();
  writeSkill(skillsDir(ws), "ratio-analysis", { description: "Compute financial ratios" });
  const { code } = captureStdout(() =>
    runSkillsCli([ws, "--validate"], { userRoot: emptyUserRoot })
  );
  assert.equal(code, 0);
});

test("runSkillsCli reports no skills found when both roots are empty", () => {
  const ws = tmpWorkspace();
  const emptyUserRoot = tmpWorkspace();
  const { code, output } = captureStdout(() => runSkillsCli([ws], { userRoot: emptyUserRoot }));
  assert.equal(code, 0);
  assert.match(output, /No skills found/);
});
