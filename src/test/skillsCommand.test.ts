import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { Agent } from "../agent/loop.js";
import { runCommand, type CommandContext } from "../commands/registry.js";
import type { ItemBody } from "../types.js";
import { pluginsDir } from "../plugins/discover.js";

/** A CommandContext stub with just enough wired up for /skills. */
function harness(): { ctx: CommandContext; workspace: string; said: string[] } {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "kritya-skills-cmd-"));
  const said: string[] = [];
  const ctx = {
    arg: "",
    raw: "/skills",
    agent: {} as Agent,
    workspace,
    config: {},
    customCommands: [],
    mcpToolCount: 0,
    planMode: false,
    acceptEdits: false,
    addItem(item: ItemBody) {
      said.push("text" in item && typeof item.text === "string" ? item.text : "");
    },
    killed: false,
  } as unknown as CommandContext;

  return { ctx, workspace, said };
}

function writeSkill(root: string, name: string, description: string): void {
  const dir = path.join(root, ".kritya", "skills", name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n\nInstructions.\n`
  );
}

/**
 * /skills also scans the real user-global ~/.kritya/skills, so every test
 * points HOME at an isolated empty temp dir first — same pattern as
 * skills.test.ts's buildSystemPrompt tests.
 */
function withIsolatedHome<T>(fn: () => T): T {
  const prevHome = os.homedir();
  process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), "kritya-skills-home-"));
  try {
    return fn();
  } finally {
    process.env.HOME = prevHome;
  }
}

test("/skills reports none found in a workspace with no skills dirs", () =>
  withIsolatedHome(async () => {
    const h = harness();
    await runCommand("/skills", h.ctx);
    assert.equal(h.said.length, 1);
    assert.match(h.said[0], /No skills found under/);
  }));

test("/skills lists a project skill with its source and description", () =>
  withIsolatedHome(async () => {
    const h = harness();
    writeSkill(h.workspace, "ratio-analysis", "Compute standard financial ratios");
    await runCommand("/skills", h.ctx);
    assert.equal(h.said.length, 1);
    assert.match(h.said[0], /ratio-analysis\s+\(project\)\s+Compute standard financial ratios/);
  }));

test("/skills reports why a malformed skill was skipped", () =>
  withIsolatedHome(async () => {
    const h = harness();
    const dir = path.join(h.workspace, ".kritya", "skills", "broken");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "SKILL.md"), "no frontmatter here");
    await runCommand("/skills", h.ctx);
    assert.equal(h.said.length, 1);
    assert.match(h.said[0], /broken\s+SKIPPED: missing frontmatter block/);
  }));

test("/skills labels a skill contributed by a plugin with its plugin name", () =>
  withIsolatedHome(async () => {
    const h = harness();
    const pluginDir = path.join(pluginsDir(h.workspace), "finance-tools");
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(
      path.join(pluginDir, "plugin.json"),
      JSON.stringify({ name: "finance-tools", version: "1.0.0" })
    );
    const skillDir = path.join(pluginDir, "skills", "ratio-analysis");
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, "SKILL.md"),
      "---\nname: ratio-analysis\ndescription: Compute financial ratios\n---\n\nInstructions.\n"
    );
    await runCommand("/skills", h.ctx);
    assert.equal(h.said.length, 1);
    assert.match(
      h.said[0],
      /ratio-analysis\s+\(plugin: finance-tools\)\s+Compute financial ratios/
    );
  }));

test("/skills works while the kill switch is engaged (read-only)", () =>
  withIsolatedHome(async () => {
    const h = harness();
    writeSkill(h.workspace, "my-skill", "Does a thing");
    (h.ctx as unknown as { killed: boolean }).killed = true;
    await runCommand("/skills", h.ctx);
    assert.equal(h.said.length, 1);
    assert.match(h.said[0], /my-skill/);
  }));
