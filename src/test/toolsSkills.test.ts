import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { loadSkillTool } from "../tools/skills.js";
import { skillsDir } from "../agent/skills.js";
import type { ToolContext } from "../types.js";

function tmpWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "kritya-loadskill-"));
}

function writeSkill(
  ws: string,
  name: string,
  opts: { description?: string; body?: string } = {}
): string {
  const dir = path.join(skillsDir(ws), name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${opts.description ?? "a skill"}\n---\n\n${opts.body ?? "Do the thing."}\n`
  );
  return dir;
}

function ctx(workspace: string): ToolContext {
  return { workspace };
}

test("load_skill returns the skill body for a valid name", async () => {
  const ws = tmpWorkspace();
  writeSkill(ws, "ratio-analysis", { body: "Step 1: gather the balance sheet." });
  const output = await loadSkillTool.execute({ name: "ratio-analysis" }, ctx(ws));
  assert.match(output, /Step 1: gather the balance sheet\./);
});

test("load_skill lists bundled scripts/references/assets", async () => {
  const ws = tmpWorkspace();
  const dir = writeSkill(ws, "ratio-analysis");
  fs.mkdirSync(path.join(dir, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(dir, "scripts", "compute.py"), "# compute");
  fs.mkdirSync(path.join(dir, "references"), { recursive: true });
  fs.writeFileSync(path.join(dir, "references", "formulas.md"), "# formulas");
  const output = await loadSkillTool.execute({ name: "ratio-analysis" }, ctx(ws));
  assert.match(output, /scripts\/[\s\S]*compute\.py/);
  assert.match(output, /references\/[\s\S]*formulas\.md/);
});

test("load_skill throws a clear error for an unknown name", async () => {
  const ws = tmpWorkspace();
  writeSkill(ws, "ratio-analysis");
  await assert.rejects(
    () => loadSkillTool.execute({ name: "does-not-exist" }, ctx(ws)),
    /skill "does-not-exist" not found.*ratio-analysis/s
  );
});

test("load_skill throws when no skills exist at all", async () => {
  const ws = tmpWorkspace();
  await assert.rejects(
    () => loadSkillTool.execute({ name: "anything" }, ctx(ws)),
    /skill "anything" not found.*\(none\)/s
  );
});

test("load_skill does not treat the name argument as a path", async () => {
  const ws = tmpWorkspace();
  writeSkill(ws, "ratio-analysis");
  // A hallucinated/malicious name must not escape the lookup-by-discovered-name
  // path and read something outside the skill folders.
  await assert.rejects(
    () => loadSkillTool.execute({ name: "../../etc/passwd" }, ctx(ws)),
    /not found/
  );
});

test("load_skill is registered with requiresPermission: false", () => {
  assert.equal(loadSkillTool.requiresPermission, false);
});
