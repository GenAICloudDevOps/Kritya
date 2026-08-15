import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { Agent } from "../agent/loop.js";
import { runCommand, type CommandContext } from "../commands/registry.js";
import { artifactPath, loadProjectState, saveProjectState } from "../agent/workflow.js";
import type { ItemBody } from "../types.js";

interface Harness {
  ctx: CommandContext;
  workspace: string;
  /** Prompts handed to the agent, in order. */
  prompts: string[];
  /** Text of every item shown to the user. */
  said: string[];
  /** Mutable counters the stub updates as commands run. */
  counts: { compactions: number };
  /** What the UI was showing at the moment compaction started. */
  duringCompaction: { phase: string | null; activity: string | null };
  /** Phases declared as running, in order. */
  labels: (string | null)[];
}

/**
 * A CommandContext stub. The workflow handlers only touch a handful of its
 * members; the rest are no-ops so the interface stays satisfied.
 */
function harness(overrides: Partial<CommandContext> = {}): Harness {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "kritya-cmd-"));
  const prompts: string[] = [];
  const said: string[] = [];
  const counts = { compactions: 0 };
  const labels: (string | null)[] = [];
  const ui = { phase: null as string | null, activity: null as string | null };
  const duringCompaction = { phase: null as string | null, activity: null as string | null };
  const agent = {
    planMode: false,
    acceptEdits: false,
    async compact() {
      counts.compactions++;
      // Snapshot what the user would be looking at right now.
      duringCompaction.phase = ui.phase;
      duringCompaction.activity = ui.activity;
      return "Nothing to compact yet.";
    },
    contextUsage: () => 0,
  } as unknown as Agent;

  const ctx = {
    arg: "",
    raw: "",
    agent,
    workspace,
    config: {},
    customCommands: [],
    mcpToolCount: 0,
    planMode: false,
    acceptEdits: false,
    setAcceptEdits(v: boolean) {
      ctx.acceptEdits = v;
    },
    setPlanMode(v: boolean) {
      ctx.planMode = v;
    },
    addItem(item: ItemBody) {
      said.push("text" in item && typeof item.text === "string" ? item.text : "");
    },
    setPhase(p: string) {
      ui.phase = p;
    },
    setActivity(a: string | null) {
      ui.activity = a;
    },
    setRunningPhase(p: string | null) {
      labels.push(p);
    },
    refreshWorkflow() {},
    setCtxPct() {},
    setTasks() {},
    killed: false,
    engageKill() {},
    releaseKill() {},
    refreshFileList() {},
    async runAgent(text: string) {
      prompts.push(text);
    },
    ...overrides,
  } as unknown as CommandContext;

  return { ctx, workspace, prompts, said, counts, duringCompaction, labels };
}

/** Write a phase's artifact so the next phase's prerequisite check passes. */
function writeArtifact(ws: string, name: string, phase: Parameters<typeof artifactPath>[1]): void {
  const rel = artifactPath(name, phase)!;
  fs.mkdirSync(path.join(ws, path.dirname(rel)), { recursive: true });
  fs.writeFileSync(path.join(ws, rel), "content");
}

test("/flow-brainstorm starts a project and runs the brainstorm phase", async () => {
  const h = harness();
  h.ctx.arg = "a habit tracker";
  h.ctx.raw = "/flow-brainstorm a habit tracker";
  await runCommand("/flow-brainstorm", h.ctx);

  assert.equal(loadProjectState(h.workspace)?.name, "a-habit-tracker");
  assert.equal(loadProjectState(h.workspace)?.phase, "brainstorm");
  assert.equal(h.prompts.length, 1);
  assert.match(h.prompts[0], /BRAINSTORM phase/);
});

test("/flow-brainstorm with a new idea starts a new project instead of reusing the old name", async () => {
  const h = harness();
  saveProjectState(h.workspace, "old-project", "build");
  h.ctx.arg = "a totally different thing";
  h.ctx.raw = "/flow-brainstorm a totally different thing";
  await runCommand("/flow-brainstorm", h.ctx);

  // The old behaviour wrote the new idea into docs/old-project/.
  assert.equal(loadProjectState(h.workspace)?.name, "a-totally-different-thing");
  assert.ok(
    h.said.some((s) => s.includes("old-project")),
    "should tell the user the previous project was left behind"
  );
});

test("/flow-brainstorm with no idea resumes the existing project", async () => {
  const h = harness();
  saveProjectState(h.workspace, "my-app", "plan");
  h.ctx.raw = "/flow-brainstorm";
  await runCommand("/flow-brainstorm", h.ctx);
  assert.equal(loadProjectState(h.workspace)?.name, "my-app");
  assert.equal(loadProjectState(h.workspace)?.phase, "brainstorm");
});

test("a phase refuses to run when the artifact it reads was never written", async () => {
  const h = harness();
  saveProjectState(h.workspace, "my-app", "brainstorm");
  h.ctx.raw = "/flow-plan";
  await runCommand("/flow-plan", h.ctx);

  assert.equal(h.prompts.length, 0, "the phase must not run");
  assert.equal(loadProjectState(h.workspace)?.phase, "brainstorm", "and must not change the phase");
  assert.ok(h.said.some((s) => s.includes("spec.md") && s.includes("--force")));
});

test("--force runs a phase past a missing prerequisite, with a warning", async () => {
  const h = harness();
  saveProjectState(h.workspace, "my-app", "brainstorm");
  h.ctx.arg = "--force";
  h.ctx.raw = "/flow-plan --force";
  await runCommand("/flow-plan", h.ctx);

  assert.equal(h.prompts.length, 1);
  assert.match(h.prompts[0], /PLAN phase/);
  assert.ok(h.said.some((s) => s.includes("Forced past a missing prerequisite")));
  // --force must not leak into the prompt as if it were user input.
  assert.doesNotMatch(h.prompts[0], /--force/);
});

test("bare /plan mid-build does not reset the project to the plan phase", async () => {
  // The old /plan doubled as a mode toggle, so flipping into read-only during
  // a build silently rewound the workflow and re-ran the plan phase.
  const h = harness();
  saveProjectState(h.workspace, "my-app", "build");
  writeArtifact(h.workspace, "my-app", "spec");

  h.ctx.arg = "on";
  h.ctx.raw = "/plan on";
  await runCommand("/plan", h.ctx);

  assert.equal(h.ctx.planMode, true, "mode should still be settable");
  assert.equal(loadProjectState(h.workspace)?.phase, "build", "but the phase must not move");
  assert.equal(h.prompts.length, 0, "and no phase should run");
});

test("/plan off leaves plan mode without touching the workflow", async () => {
  const h = harness();
  saveProjectState(h.workspace, "my-app", "plan");
  h.ctx.planMode = true;
  h.ctx.arg = "off";
  h.ctx.raw = "/plan off";
  await runCommand("/plan", h.ctx);

  assert.equal(h.ctx.planMode, false);
  assert.equal(loadProjectState(h.workspace)?.phase, "plan");
  assert.equal(h.prompts.length, 0);
});

test("the plan phase turns plan mode on and every other phase turns it off", async () => {
  const h = harness();
  saveProjectState(h.workspace, "my-app", "spec");
  writeArtifact(h.workspace, "my-app", "spec");

  h.ctx.raw = "/flow-plan";
  await runCommand("/flow-plan", h.ctx);
  assert.equal(h.ctx.planMode, true, "plan phase is read-only");

  writeArtifact(h.workspace, "my-app", "plan");
  h.ctx.raw = "/flow-build";
  await runCommand("/flow-build", h.ctx);
  assert.equal(h.ctx.planMode, false, "build must be able to write");
  assert.equal(loadProjectState(h.workspace)?.phase, "build");
});

test("entering the plan phase clears accept-edits", async () => {
  const h = harness();
  saveProjectState(h.workspace, "my-app", "spec");
  writeArtifact(h.workspace, "my-app", "spec");
  h.ctx.acceptEdits = true;
  h.ctx.raw = "/flow-plan";
  await runCommand("/flow-plan", h.ctx);
  assert.equal(h.ctx.acceptEdits, false);
});

test("each phase command compacts at the boundary before running", async () => {
  const h = harness();
  saveProjectState(h.workspace, "my-app", "brainstorm");
  writeArtifact(h.workspace, "my-app", "brainstorm");
  h.ctx.raw = "/flow-spec";
  await runCommand("/flow-spec", h.ctx);
  assert.equal(h.counts.compactions, 1);
  assert.equal(h.prompts.length, 1);
});

test("compaction is visible while it runs", async () => {
  // Compaction is a full model call. Leaving the UI in "input" with no label
  // meant the terminal sat silent for seconds with nothing on screen.
  const h = harness();
  saveProjectState(h.workspace, "my-app", "brainstorm");
  writeArtifact(h.workspace, "my-app", "brainstorm");
  h.ctx.raw = "/flow-spec";
  await runCommand("/flow-spec", h.ctx);

  assert.equal(h.duringCompaction.phase, "working", "the spinner only renders while working");
  assert.match(h.duringCompaction.activity ?? "", /Compacting before the spec phase/);
});

test("a phase declares itself running and does not clear that itself", async () => {
  const h = harness();
  saveProjectState(h.workspace, "my-app", "brainstorm");
  writeArtifact(h.workspace, "my-app", "brainstorm");
  h.ctx.raw = "/flow-spec";
  await runCommand("/flow-spec", h.ctx);

  // Set once, and never cleared by the command — the turn's own teardown does
  // that, which is also what announces the next command. Clearing it here would
  // lose both the spinner label and the handoff.
  assert.deepEqual(h.labels, ["spec"]);
});

test("/flow-brainstorm declares its phase and compacts too", async () => {
  const h = harness();
  h.ctx.arg = "a habit tracker";
  h.ctx.raw = "/flow-brainstorm a habit tracker";
  await runCommand("/flow-brainstorm", h.ctx);

  assert.deepEqual(h.labels, ["brainstorm"]);
  assert.equal(h.counts.compactions, 1);
  assert.match(h.duringCompaction.activity ?? "", /Compacting before the brainstorm phase/);
});

test("/flow-brainstorm takes a short name: prefix and passes only the idea on", async () => {
  const h = harness();
  h.ctx.arg = "reverser: a script that reverses a string";
  h.ctx.raw = "/flow-brainstorm reverser: a script that reverses a string";
  await runCommand("/flow-brainstorm", h.ctx);

  assert.equal(loadProjectState(h.workspace)?.name, "reverser");
  assert.match(h.prompts[0], /a script that reverses a string/);
  assert.doesNotMatch(h.prompts[0], /reverser:/);
});

test("/flow-brainstorm without a name prefix still derives one from the idea", async () => {
  const h = harness();
  h.ctx.arg = "a script that reverses a string, in Python";
  h.ctx.raw = `/flow-brainstorm ${h.ctx.arg}`;
  await runCommand("/flow-brainstorm", h.ctx);

  const name = loadProjectState(h.workspace)?.name ?? "";
  assert.match(name, /^a-script-that-reverses/);
  // Whole words only — no truncation mid-token.
  assert.ok(!name.endsWith("-"), name);
});

test("/project rename moves the artifacts and updates the pointer", async () => {
  const h = harness();
  saveProjectState(h.workspace, "a-long-clumsy-name", "spec");
  writeArtifact(h.workspace, "a-long-clumsy-name", "brainstorm");
  h.ctx.arg = "rename reverser";
  h.ctx.raw = "/project rename reverser";
  await runCommand("/project", h.ctx);

  assert.equal(loadProjectState(h.workspace)?.name, "reverser");
  assert.equal(loadProjectState(h.workspace)?.phase, "spec", "the phase must survive a rename");
  assert.ok(fs.existsSync(path.join(h.workspace, "docs/reverser/brainstorm.md")));
  assert.ok(!fs.existsSync(path.join(h.workspace, "docs/a-long-clumsy-name")));
});

test("/project rename refuses to overwrite an existing folder", async () => {
  const h = harness();
  saveProjectState(h.workspace, "my-app", "spec");
  writeArtifact(h.workspace, "my-app", "brainstorm");
  writeArtifact(h.workspace, "taken", "brainstorm");
  h.ctx.arg = "rename taken";
  h.ctx.raw = "/project rename taken";
  await runCommand("/project", h.ctx);

  assert.equal(loadProjectState(h.workspace)?.name, "my-app", "the rename must not happen");
  assert.ok(h.said.some((s) => s.includes("already exists")));
});

test("/project rename works before any artifact has been written", async () => {
  const h = harness();
  saveProjectState(h.workspace, "my-app", "brainstorm");
  h.ctx.arg = "rename reverser";
  h.ctx.raw = "/project rename reverser";
  await runCommand("/project", h.ctx);
  assert.equal(loadProjectState(h.workspace)?.name, "reverser");
});

test("phase commands report there is no project instead of starting one", async () => {
  for (const cmd of ["/flow-spec", "/flow-plan", "/flow-build", "/flow-review", "/flow-fix"]) {
    const h = harness();
    h.ctx.raw = cmd;
    await runCommand(cmd, h.ctx);
    assert.equal(loadProjectState(h.workspace), null, `${cmd} must not create state`);
    assert.ok(
      h.said.some((s) => s.includes("No active project workflow")),
      cmd
    );
  }
});

test("bare /plan with no project is a pure mode toggle, not a phase command", async () => {
  const h = harness();
  h.ctx.raw = "/plan";
  await runCommand("/plan", h.ctx);
  assert.equal(loadProjectState(h.workspace), null);
  assert.equal(h.ctx.planMode, true);
  assert.ok(h.said.some((s) => s.includes("Plan mode ON")));
});

test("/project clear ends the workflow and keeps the artifacts", async () => {
  const h = harness();
  saveProjectState(h.workspace, "my-app", "build");
  writeArtifact(h.workspace, "my-app", "spec");
  h.ctx.arg = "clear";
  h.ctx.raw = "/project clear";
  await runCommand("/project", h.ctx);

  assert.equal(loadProjectState(h.workspace), null);
  assert.ok(fs.existsSync(path.join(h.workspace, "docs/my-app/spec.md")));
});

test("/project goto moves the phase without running it", async () => {
  const h = harness();
  saveProjectState(h.workspace, "my-app", "brainstorm");
  h.ctx.arg = "goto build";
  h.ctx.raw = "/project goto build";
  await runCommand("/project", h.ctx);

  assert.equal(loadProjectState(h.workspace)?.phase, "build");
  assert.equal(h.prompts.length, 0);
});

test("/project goto rejects an unknown phase", async () => {
  const h = harness();
  saveProjectState(h.workspace, "my-app", "brainstorm");
  h.ctx.arg = "goto design";
  h.ctx.raw = "/project goto design";
  await runCommand("/project", h.ctx);

  assert.equal(loadProjectState(h.workspace)?.phase, "brainstorm");
  assert.ok(h.said.some((s) => s.includes("Usage: /project goto")));
});

test("/project with no argument reports where the workflow stands", async () => {
  const h = harness();
  saveProjectState(h.workspace, "my-app", "plan");
  h.ctx.raw = "/project";
  await runCommand("/project", h.ctx);

  const report = h.said.join("\n");
  assert.match(report, /my-app/);
  assert.match(report, /plan phase/);
  assert.match(report, /review/, "should list every phase");
  assert.equal(h.prompts.length, 0);
});

test("workflow commands are refused while the kill switch is engaged", async () => {
  for (const cmd of [
    "/flow-brainstorm",
    "/flow-spec",
    "/plan",
    "/flow-plan",
    "/flow-build",
    "/flow-review",
    "/flow-fix",
    "/project",
  ]) {
    const h = harness({ killed: true });
    h.ctx.arg = "x";
    h.ctx.raw = `${cmd} x`;
    await runCommand(cmd, h.ctx);
    assert.equal(h.prompts.length, 0, `${cmd} must not drive the agent`);
    assert.equal(loadProjectState(h.workspace), null, `${cmd} must not write state`);
    assert.ok(
      h.said.some((s) => s.includes("Kill switch ACTIVE")),
      cmd
    );
  }
});

test("/flow-fix runs the fix phase once review.md exists", async () => {
  const h = harness();
  saveProjectState(h.workspace, "my-app", "review");
  writeArtifact(h.workspace, "my-app", "review");
  h.ctx.raw = "/flow-fix";
  await runCommand("/flow-fix", h.ctx);

  assert.equal(loadProjectState(h.workspace)?.phase, "fix");
  assert.equal(h.prompts.length, 1);
  assert.match(h.prompts[0], /FIX phase/);
});

test("running a phase warns when an earlier artifact is now stale", async () => {
  const h = harness();
  saveProjectState(h.workspace, "my-app", "plan");
  writeArtifact(h.workspace, "my-app", "spec");
  writeArtifact(h.workspace, "my-app", "plan");
  // Touch spec.md after plan.md, simulating an edit made after planning.
  const specPath = path.join(h.workspace, artifactPath("my-app", "spec")!);
  const future = new Date(Date.now() + 60_000);
  fs.utimesSync(specPath, future, future);

  h.ctx.raw = "/flow-build";
  saveProjectState(h.workspace, "my-app", "plan");
  await runCommand("/flow-build", h.ctx);

  assert.ok(h.said.some((s) => s.includes("plan.md") && s.includes("stale")));
});

test("/project status surfaces stale artifacts too", async () => {
  const h = harness();
  saveProjectState(h.workspace, "my-app", "plan");
  writeArtifact(h.workspace, "my-app", "spec");
  writeArtifact(h.workspace, "my-app", "plan");
  const specPath = path.join(h.workspace, artifactPath("my-app", "spec")!);
  const future = new Date(Date.now() + 60_000);
  fs.utimesSync(specPath, future, future);

  h.ctx.raw = "/project";
  await runCommand("/project", h.ctx);

  assert.ok(h.said.some((s) => s.includes("stale")));
});
