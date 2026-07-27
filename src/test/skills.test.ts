import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  buildSkillsSection,
  parseSkillFrontmatter,
  scanSkills,
  skillsDir,
  _setWarnSink,
} from "../agent/skills.js";
import { buildSystemPrompt } from "../agent/systemPrompt.js";

function tmpWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "kritya-skills-"));
}

function writeSkill(
  root: string,
  name: string,
  opts: { description?: string; body?: string; extraFrontmatter?: string; skipName?: boolean } = {}
): string {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  const lines = ["---"];
  if (!opts.skipName) lines.push(`name: ${name}`);
  if (opts.description !== undefined) lines.push(`description: ${opts.description}`);
  if (opts.extraFrontmatter) lines.push(opts.extraFrontmatter);
  lines.push("---", "", opts.body ?? `Instructions for ${name}.`);
  fs.writeFileSync(path.join(dir, "SKILL.md"), lines.join("\n"));
  return dir;
}

test("parseSkillFrontmatter extracts meta fields and trims the body", () => {
  const raw = "---\nname: foo\ndescription: does foo things\n---\n\nBody text here.\n";
  const parsed = parseSkillFrontmatter(raw);
  assert.ok(parsed);
  assert.equal(parsed!.meta.name, "foo");
  assert.equal(parsed!.meta.description, "does foo things");
  assert.equal(parsed!.body, "Body text here.");
});

test("parseSkillFrontmatter preserves extra frontmatter fields", () => {
  const raw = "---\nname: foo\ndescription: does foo\nlicense: MIT\n---\nbody\n";
  const parsed = parseSkillFrontmatter(raw);
  assert.equal(parsed!.meta.license, "MIT");
});

test("parseSkillFrontmatter returns null when there is no frontmatter block", () => {
  assert.equal(parseSkillFrontmatter("just a plain markdown file\n"), null);
});

test("scanSkills finds a valid skill", () => {
  const root = tmpWorkspace();
  writeSkill(root, "ratio-analysis", { description: "Compute financial ratios" });
  const found = scanSkills([root]);
  assert.equal(found.length, 1);
  assert.equal(found[0].name, "ratio-analysis");
  assert.equal(found[0].description, "Compute financial ratios");
  assert.equal(found[0].dir, path.join(root, "ratio-analysis"));
});

test("scanSkills skips a folder missing description, with the rest still found", () => {
  const root = tmpWorkspace();
  const warnings: string[] = [];
  const prevSink = _setWarnSink((msg) => warnings.push(msg));
  try {
    writeSkill(root, "broken", { skipName: false, description: undefined });
    writeSkill(root, "ok", { description: "fine" });
    const found = scanSkills([root]);
    assert.deepEqual(
      found.map((s) => s.name),
      ["ok"]
    );
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /frontmatter must include.*name.*description/);
  } finally {
    _setWarnSink(prevSink);
  }
});

test("scanSkills skips a folder with no SKILL.md", () => {
  const root = tmpWorkspace();
  fs.mkdirSync(path.join(root, "not-a-skill"), { recursive: true });
  fs.writeFileSync(path.join(root, "not-a-skill", "README.md"), "hi");
  assert.deepEqual(scanSkills([root]), []);
});

test("scanSkills returns [] for a missing root directory", () => {
  assert.deepEqual(scanSkills([path.join(os.tmpdir(), "does-not-exist-" + Date.now())]), []);
});

test("scanSkills scans multiple roots and keeps the first match on a name collision", () => {
  const rootA = tmpWorkspace();
  const rootB = tmpWorkspace();
  const warnings: string[] = [];
  const prevSink = _setWarnSink((msg) => warnings.push(msg));
  try {
    writeSkill(rootA, "dup", { description: "from A" });
    writeSkill(rootB, "dup", { description: "from B" });
    const found = scanSkills([rootA, rootB]);
    assert.equal(found.length, 1);
    assert.equal(found[0].description, "from A");
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /duplicate skill name/);
  } finally {
    _setWarnSink(prevSink);
  }
});

test("skillsDir joins the workspace with .kritya/skills", () => {
  assert.equal(skillsDir("/ws"), path.join("/ws", ".kritya", "skills"));
});

test("buildSkillsSection lists discovered skills", () => {
  const ws = tmpWorkspace();
  writeSkill(skillsDir(ws), "ratio-analysis", { description: "Compute financial ratios" });
  const section = buildSkillsSection(ws);
  assert.match(section, /# Available skills/);
  assert.match(section, /ratio-analysis: Compute financial ratios/);
  assert.match(section, /load_skill/);
});

test("buildSkillsSection returns empty string when there are no skills", () => {
  const ws = tmpWorkspace();
  assert.equal(buildSkillsSection(ws), "");
});

test("buildSystemPrompt includes the skills section when a skill exists", () => {
  const ws = tmpWorkspace();
  writeSkill(skillsDir(ws), "ratio-analysis", { description: "Compute financial ratios" });
  const prompt = buildSystemPrompt(ws);
  assert.match(prompt, /# Available skills/);
  assert.match(prompt, /ratio-analysis: Compute financial ratios/);
});

test("buildSystemPrompt omits the skills section when there are none", () => {
  const ws = tmpWorkspace();
  const prompt = buildSystemPrompt(ws);
  assert.doesNotMatch(prompt, /# Available skills/);
});
