import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { Agent } from "../agent/loop.js";
import { runCommand, type CommandContext } from "../commands/registry.js";
import {
  artifactPath,
  loadProjectState,
  markRevisit,
  MAX_REVISITS,
  saveProjectState,
  takeRevisit,
} from "../agent/workflow.js";
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
  /** Every setChained() call, in order, so a test can see the chain bracket. */
  chained: boolean[];
  /** Every setPrefill() call, in order — null included, so a test can see a clear. */
  prefills: (string | null)[];
  /** Every item shown, so a test can tell a user line from an info line. */
  items: ItemBody[];
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
  const chained: boolean[] = [];
  const prefills: (string | null)[] = [];
  const items: ItemBody[] = [];
  const ui = { phase: null as string | null, activity: null as string | null };
  const duringCompaction = { phase: null as string | null, activity: null as string | null };
  const agent = {
    planMode: false,
    acceptEdits: false,
    bypassMode: false,
    maxSteps: 40,
    hitStepLimit: false,
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
    bypassMode: false,
    setBypassMode(v: boolean) {
      ctx.bypassMode = v;
    },
    setPlanMode(v: boolean) {
      ctx.planMode = v;
    },
    addItem(item: ItemBody) {
      items.push(item);
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
    setChained(v: boolean) {
      chained.push(v);
    },
    setPrefill(v: string | null) {
      prefills.push(v);
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

  return {
    ctx,
    workspace,
    prompts,
    said,
    counts,
    duringCompaction,
    labels,
    chained,
    prefills,
    items,
  };
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

test("/flow-review refuses to run before the project has been built", async () => {
  // build writes code rather than a doc, so the usual "did the previous phase
  // leave its artifact" check passes for review trivially — and always. That
  // let a review run against a project that had never been built.
  const h = harness();
  saveProjectState(h.workspace, "my-app", "plan");
  h.ctx.raw = "/flow-review";
  await runCommand("/flow-review", h.ctx);

  assert.equal(h.prompts.length, 0, "there is nothing to review yet");
  assert.equal(loadProjectState(h.workspace)?.phase, "plan");
  assert.ok(h.said.some((s) => s.includes("has not reached build yet")));
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
  // build is not a gate, so the run continues into review — which is why the
  // recorded phase is review, not build.
  assert.match(h.prompts.at(-1) ?? "", /REVIEW phase/);
  assert.ok(h.labels.includes("build"), "the build phase ran");
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
  for (const cmd of [
    "/flow-spec",
    "/flow-plan",
    "/flow-build",
    "/flow-review",
    "/flow-fix",
    "/flow-ship",
    "/flow",
    "/flow-back",
  ]) {
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
    "/flow-ship",
    "/flow",
    "/flow-back",
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

// --- chaining: one command, several phases -------------------------------

test("an ungated phase runs the rest of the stretch as one chain", async () => {
  const h = harness();
  saveProjectState(h.workspace, "my-app", "plan");
  writeArtifact(h.workspace, "my-app", "plan");
  h.ctx.raw = "/flow-build";
  await runCommand("/flow-build", h.ctx);

  // build and review both run; fix stops the chain because review.md was never
  // written (the stub agent doesn't write artifacts).
  assert.deepEqual(h.labels, ["build", "review"]);
  assert.ok(
    h.said.some((s) => s.includes("Running 4 phases: build → review → fix → ship")),
    "the chain announces how far it will go"
  );
  assert.deepEqual(h.chained, [true, false], "bracketed as chained, then released");
});

test("a phase that hits the step limit stops the chain", async () => {
  // The turn just ends when it runs out of steps, and the message it appends
  // reads like model output. Treating that as a finished phase built the next
  // one on a half-written artifact.
  const h = harness();
  saveProjectState(h.workspace, "my-app", "plan");
  writeArtifact(h.workspace, "my-app", "plan");
  h.ctx.agent.hitStepLimit = true;
  h.ctx.raw = "/flow-build";
  await runCommand("/flow-build", h.ctx);

  assert.deepEqual(h.labels, ["build"], "nothing after the truncated phase ran");
  assert.ok(h.said.some((s) => s.includes("40-step limit")));
  assert.ok(h.said.some((s) => s.includes("review, fix, ship did not run")));
  assert.ok(h.said.some((s) => s.includes("continue")));
});

test("a chain that stops early says which phases never ran", async () => {
  // Otherwise the run just goes quiet after the blocker message, and the user
  // has to work out for themselves that phases they were promised were skipped.
  const h = harness();
  saveProjectState(h.workspace, "my-app", "plan");
  writeArtifact(h.workspace, "my-app", "plan");
  h.ctx.raw = "/flow-build";
  await runCommand("/flow-build", h.ctx);

  assert.ok(
    h.said.some((s) => s.includes("Chain stopped at fix")),
    "names the phase it died on"
  );
  assert.ok(
    h.said.some((s) => s.includes("ship did not run")),
    "and what was abandoned"
  );
  assert.ok(h.said.some((s) => s.includes("/flow to carry on")));
});

test("a gated phase does not bracket itself as a chain", async () => {
  const h = harness();
  saveProjectState(h.workspace, "my-app", "brainstorm");
  writeArtifact(h.workspace, "my-app", "brainstorm");
  h.ctx.raw = "/flow-spec";
  await runCommand("/flow-spec", h.ctx);

  assert.deepEqual(h.labels, ["spec"]);
  assert.deepEqual(h.chained, [], "one phase is not a chain, so the flag is never touched");
  assert.ok(!h.said.some((s) => s.includes("Running")));
});

test("a chain records one user line for the whole stretch, not one per phase", async () => {
  const h = harness();
  saveProjectState(h.workspace, "my-app", "plan");
  writeArtifact(h.workspace, "my-app", "plan");
  h.ctx.raw = "/flow-build";
  await runCommand("/flow-build", h.ctx);

  const userLines = h.items.filter((i) => i.kind === "user");
  assert.equal(userLines.length, 1, "the transcript shows the command once");
});

test("--auto runs the whole remaining workflow as one chain", async () => {
  const h = harness();
  h.ctx.arg = "a habit tracker --auto";
  h.ctx.raw = "/flow-brainstorm a habit tracker --auto";
  await runCommand("/flow-brainstorm", h.ctx);

  assert.ok(
    h.said.some((s) =>
      s.includes("Running 7 phases: brainstorm → spec → plan → build → review → fix → ship")
    )
  );
});

test("--fast drops the brainstorm gate, merging it into the spec stretch", async () => {
  const h = harness();
  h.ctx.arg = "a habit tracker --fast";
  h.ctx.raw = "/flow-brainstorm a habit tracker --fast";
  await runCommand("/flow-brainstorm", h.ctx);

  assert.ok(h.said.some((s) => s.includes("Running 2 phases: brainstorm → spec")));
  // The flag is an instruction to the command, not part of the idea.
  assert.match(h.prompts[0], /a habit tracker/);
  assert.doesNotMatch(h.prompts[0], /--fast/);
});

// --- /flow: continue from where the project stands ------------------------

test("/flow continues from the phase after the one that last ran", async () => {
  const h = harness();
  saveProjectState(h.workspace, "my-app", "brainstorm");
  writeArtifact(h.workspace, "my-app", "brainstorm");
  h.ctx.raw = "/flow";
  await runCommand("/flow", h.ctx);

  assert.deepEqual(h.labels, ["spec"]);
  assert.equal(loadProjectState(h.workspace)?.phase, "spec");
});

test("/flow at the last phase says the workflow is complete", async () => {
  const h = harness();
  saveProjectState(h.workspace, "my-app", "ship");
  h.ctx.raw = "/flow";
  await runCommand("/flow", h.ctx);

  assert.equal(h.prompts.length, 0);
  assert.ok(h.said.some((s) => s.includes("run every phase")));
  assert.ok(h.said.some((s) => s.includes("/flow-back")));
});

test("/flow warns when a recorded revisit is still outstanding", async () => {
  // Carrying on forward would build the rest of the workflow on top of a
  // requirement the fix phase already recorded as wrong.
  const h = harness();
  saveProjectState(h.workspace, "my-app", "fix");
  markRevisit(h.workspace, "spec", "AC3 is unmeasurable");
  writeArtifact(h.workspace, "my-app", "fix");
  h.ctx.raw = "/flow";
  await runCommand("/flow", h.ctx);

  assert.ok(h.said.some((s) => s.includes("still flagged as needing a change")));
  assert.ok(h.said.some((s) => s.includes("AC3 is unmeasurable")));
  assert.ok(
    h.said.some((s) => s.includes("/flow-back")),
    "and points at the way to act on it"
  );
  // It still runs — the warning is advice, not a block.
  assert.deepEqual(h.labels, ["ship"]);
});

test("/flow --until runs through to the named phase and stops there", async () => {
  const h = harness();
  saveProjectState(h.workspace, "my-app", "brainstorm");
  writeArtifact(h.workspace, "my-app", "brainstorm");
  writeArtifact(h.workspace, "my-app", "spec");
  h.ctx.arg = "--until plan";
  h.ctx.raw = "/flow --until plan";
  await runCommand("/flow", h.ctx);

  assert.deepEqual(h.labels, ["spec", "plan"]);
  assert.equal(loadProjectState(h.workspace)?.phase, "plan");
});

test("--until rejects an unknown phase without running anything", async () => {
  const h = harness();
  saveProjectState(h.workspace, "my-app", "brainstorm");
  h.ctx.arg = "--until design";
  h.ctx.raw = "/flow --until design";
  await runCommand("/flow", h.ctx);

  assert.equal(h.prompts.length, 0);
  assert.equal(loadProjectState(h.workspace)?.phase, "brainstorm");
  assert.ok(h.said.some((s) => s.includes("Unknown phase")));
});

test("--until behind the start phase is refused, not silently widened to everything", async () => {
  // shouldStopAfter matches on equality, so an unreachable stop never fires and
  // an explicit "stop at brainstorm" became "run the whole stretch".
  const h = harness();
  saveProjectState(h.workspace, "my-app", "brainstorm");
  writeArtifact(h.workspace, "my-app", "brainstorm");
  h.ctx.arg = "--until brainstorm";
  h.ctx.raw = "/flow --until brainstorm";
  await runCommand("/flow", h.ctx);

  assert.equal(h.prompts.length, 0, "nothing runs");
  assert.equal(loadProjectState(h.workspace)?.phase, "brainstorm", "and the phase does not move");
  assert.ok(h.said.some((s) => s.includes("never stop")));
});

test("--until equal to the start phase is allowed", async () => {
  const h = harness();
  saveProjectState(h.workspace, "my-app", "brainstorm");
  writeArtifact(h.workspace, "my-app", "brainstorm");
  h.ctx.arg = "--until spec";
  h.ctx.raw = "/flow --until spec";
  await runCommand("/flow", h.ctx);

  assert.deepEqual(h.labels, ["spec"]);
});

test("a single-phase command does not silently eat a pending revisit", async () => {
  const h = harness();
  saveProjectState(h.workspace, "my-app", "fix");
  markRevisit(h.workspace, "spec", "AC3 is unmeasurable");
  writeArtifact(h.workspace, "my-app", "spec");
  h.ctx.raw = "/flow-plan";
  await runCommand("/flow-plan", h.ctx);

  assert.equal(loadProjectState(h.workspace)?.phase, "plan", "the phase did move");
  assert.equal(
    loadProjectState(h.workspace)?.revisit?.to,
    "spec",
    "but the note pointing at spec survives"
  );
});

// --- /flow-back: the bounded loop -----------------------------------------

test("/flow-back rewinds and re-runs every phase downstream of the target", async () => {
  const h = harness();
  saveProjectState(h.workspace, "my-app", "fix");
  for (const p of ["brainstorm", "spec", "plan", "review", "fix"] as const) {
    writeArtifact(h.workspace, "my-app", p);
  }
  h.ctx.arg = "spec";
  h.ctx.raw = "/flow-back spec";
  await runCommand("/flow-back", h.ctx);

  // It stops at the phase the project had reached, so the rewind puts you back
  // where you were rather than silently carrying on to ship.
  assert.deepEqual(h.labels, ["spec", "plan", "build", "review", "fix"]);
  assert.equal(loadProjectState(h.workspace)?.phase, "fix");
  assert.equal(loadProjectState(h.workspace)?.revisits, 1, "the loop-back is counted");
  assert.ok(h.said.some((s) => s.includes("Rewinding to spec")));
});

test("/flow-back does not inject the phase name into the prompt as user input", async () => {
  // `req.arg` held the phase the user typed, and passing it through put the
  // literal string "spec" in the prompt's "User input for this phase" block.
  const h = harness();
  saveProjectState(h.workspace, "my-app", "fix");
  for (const p of ["brainstorm", "spec", "plan", "review", "fix"] as const) {
    writeArtifact(h.workspace, "my-app", p);
  }
  h.ctx.arg = "spec";
  h.ctx.raw = "/flow-back spec";
  await runCommand("/flow-back", h.ctx);

  assert.doesNotMatch(h.prompts[0], /User input for this phase/);
});

test("/flow-back --auto runs on past where the project was", async () => {
  const h = harness();
  saveProjectState(h.workspace, "my-app", "fix");
  for (const p of ["brainstorm", "spec", "plan", "review", "fix"] as const) {
    writeArtifact(h.workspace, "my-app", p);
  }
  h.ctx.arg = "spec --auto";
  h.ctx.raw = "/flow-back spec --auto";
  await runCommand("/flow-back", h.ctx);

  assert.deepEqual(h.labels, ["spec", "plan", "build", "review", "fix", "ship"]);
  assert.equal(loadProjectState(h.workspace)?.phase, "ship");
});

test("bare /flow-back acts on whatever the fix phase recorded, and shows why", async () => {
  const h = harness();
  saveProjectState(h.workspace, "my-app", "fix");
  markRevisit(h.workspace, "plan", "M2 assumed an API that doesn't exist");
  for (const p of ["brainstorm", "spec", "plan", "review", "fix"] as const) {
    writeArtifact(h.workspace, "my-app", p);
  }
  h.ctx.raw = "/flow-back";
  await runCommand("/flow-back", h.ctx);

  assert.equal(h.labels[0], "plan", "it rewinds to the recorded phase");
  assert.ok(h.said.some((s) => s.includes("M2 assumed an API that doesn't exist")));
  assert.equal(loadProjectState(h.workspace)?.revisits, 1);
});

test("/flow-back refuses a target that is not before the current phase", async () => {
  const h = harness();
  saveProjectState(h.workspace, "my-app", "plan");
  h.ctx.arg = "build";
  h.ctx.raw = "/flow-back build";
  await runCommand("/flow-back", h.ctx);

  assert.equal(h.prompts.length, 0);
  assert.equal(loadProjectState(h.workspace)?.revisits, undefined, "and spends no loop-back");
  assert.ok(h.said.some((s) => s.includes("rewinds")));
});

test("/flow-back refuses once the loop-back budget is spent", async () => {
  const h = harness();
  saveProjectState(h.workspace, "my-app", "fix");
  for (let i = 0; i < MAX_REVISITS; i++) {
    takeRevisit(h.workspace, "spec");
    saveProjectState(h.workspace, "my-app", "fix");
  }
  h.ctx.arg = "spec";
  h.ctx.raw = "/flow-back spec";
  await runCommand("/flow-back", h.ctx);

  assert.equal(h.prompts.length, 0, "the limit bounds the spend");
  assert.ok(h.said.some((s) => s.includes("limit")));
  assert.ok(
    h.said.some((s) => s.includes("/project goto")),
    "and says how to proceed by hand"
  );
});

test("/flow-back with no target and nothing recorded explains itself", async () => {
  const h = harness();
  saveProjectState(h.workspace, "my-app", "fix");
  h.ctx.raw = "/flow-back";
  await runCommand("/flow-back", h.ctx);

  assert.equal(h.prompts.length, 0);
  assert.ok(h.said.some((s) => s.includes("Usage: /flow-back")));
});

// --- ship -----------------------------------------------------------------

test("/flow-ship runs the handover once the fix writeup exists", async () => {
  const h = harness();
  saveProjectState(h.workspace, "my-app", "fix");
  writeArtifact(h.workspace, "my-app", "fix");
  h.ctx.raw = "/flow-ship";
  await runCommand("/flow-ship", h.ctx);

  assert.equal(loadProjectState(h.workspace)?.phase, "ship");
  assert.equal(h.prompts.length, 1);
  assert.match(h.prompts[0], /SHIP phase/);
});

test("/project status numbers the phases and flags the revisit", async () => {
  const h = harness();
  saveProjectState(h.workspace, "my-app", "fix");
  markRevisit(h.workspace, "spec", "AC3 is unmeasurable");
  h.ctx.raw = "/project";
  await runCommand("/project", h.ctx);

  const report = h.said.join("\n");
  assert.match(report, /fix phase \(6\/7\)/, "progress is shown as N/7");
  assert.match(report, /ship/, "the new phase is listed");
  assert.match(report, /AC3 is unmeasurable/, "the recorded revisit is surfaced");
});

// --- parking and resuming projects ----------------------------------------

/** Write a project.json with per-phase scorecards, as the agent would. */
function writeSummaries(ws: string, summaries: Record<string, string>): void {
  const state = loadProjectState(ws);
  assert.ok(state, "writeSummaries needs an active project");
  fs.writeFileSync(
    path.join(ws, ".kritya", "project.json"),
    JSON.stringify({ ...state, summaries }, null, 2) + "\n"
  );
}

test("/project list says so when there is nothing saved", async () => {
  const h = harness();
  h.ctx.arg = "list";
  h.ctx.raw = "/project list";
  await runCommand("/project", h.ctx);
  assert.ok(h.said.some((s) => s.includes("No projects yet")));
});

test("/project list works with no active project and stars the active one", async () => {
  // The state this exists for: everything parked, nothing active. It must not
  // fall into the "No active project workflow" branch.
  const h = harness();
  saveProjectState(h.workspace, "first-app", "plan");
  saveProjectState(h.workspace, "second-app", "brainstorm");
  h.ctx.arg = "list";
  h.ctx.raw = "/project list";
  await runCommand("/project", h.ctx);

  const report = h.said.join("\n");
  assert.match(report, /first-app/);
  assert.match(report, /second-app/);
  assert.match(report, /\*\s+second-app/, "the active project is starred");
  assert.doesNotMatch(report, /No active project workflow/);
});

test("/project list still works after the active project is cleared", async () => {
  const h = harness();
  saveProjectState(h.workspace, "my-app", "build");
  h.ctx.arg = "clear";
  h.ctx.raw = "/project clear";
  await runCommand("/project", h.ctx);

  h.ctx.arg = "list";
  h.ctx.raw = "/project list";
  await runCommand("/project", h.ctx);
  assert.match(h.said.join("\n"), /my-app/);
});

test("/project resume switches to a parked project at its saved phase", async () => {
  const h = harness();
  saveProjectState(h.workspace, "first-app", "plan");
  saveProjectState(h.workspace, "second-app", "brainstorm");
  h.ctx.arg = "resume first-app";
  h.ctx.raw = "/project resume first-app";
  await runCommand("/project", h.ctx);

  assert.equal(loadProjectState(h.workspace)?.name, "first-app");
  assert.equal(loadProjectState(h.workspace)?.phase, "plan");
  assert.ok(h.said.some((s) => s.includes('Resumed "first-app"') && s.includes("plan")));
});

test("/project resume with no name prints usage", async () => {
  const h = harness();
  h.ctx.arg = "resume";
  h.ctx.raw = "/project resume";
  await runCommand("/project", h.ctx);
  assert.ok(h.said.some((s) => s.includes("Usage: /project resume")));
});

test("/project resume names an unknown project as unknown", async () => {
  const h = harness();
  saveProjectState(h.workspace, "my-app", "plan");
  h.ctx.arg = "resume nope";
  h.ctx.raw = "/project resume nope";
  await runCommand("/project", h.ctx);

  assert.equal(loadProjectState(h.workspace)?.name, "my-app", "the active project is untouched");
  assert.ok(h.said.some((s) => s.includes('No project named "nope"')));
});

test("/flow-brainstorm starting a new idea parks the old project, not loses it", async () => {
  const h = harness();
  saveProjectState(h.workspace, "old-project", "build");
  h.ctx.arg = "a totally different thing";
  h.ctx.raw = "/flow-brainstorm a totally different thing";
  await runCommand("/flow-brainstorm", h.ctx);

  // The message has to name the way back, since the phase is no longer on screen.
  assert.ok(h.said.some((s) => s.includes("/project resume old-project")));

  // And the way back has to actually work.
  h.ctx.arg = "resume old-project";
  h.ctx.raw = "/project resume old-project";
  await runCommand("/project", h.ctx);
  assert.equal(loadProjectState(h.workspace)?.name, "old-project");
  assert.equal(loadProjectState(h.workspace)?.phase, "build");
});

test("/project clear tells the user the project can be resumed", async () => {
  const h = harness();
  saveProjectState(h.workspace, "my-app", "build");
  h.ctx.arg = "clear";
  h.ctx.raw = "/project clear";
  await runCommand("/project", h.ctx);

  assert.equal(loadProjectState(h.workspace), null);
  assert.ok(h.said.some((s) => s.includes("/project resume my-app")));
});

test("/project shows a phase's recorded scorecard instead of the generic blurb", async () => {
  const h = harness();
  saveProjectState(h.workspace, "my-app", "spec");
  writeSummaries(h.workspace, { brainstorm: "3 MVP features, FastAPI + SQLite" });
  h.ctx.raw = "/project";
  await runCommand("/project", h.ctx);

  const report = h.said.join("\n");
  assert.match(report, /3 MVP features, FastAPI \+ SQLite/);
  // The phases without a scorecard keep the generic description.
  assert.match(report, /goals, non-goals, contracts/);
});

// --- the end of a chain ----------------------------------------------------

test("a chain that ends at a gate announces its last phase and prefills /flow", async () => {
  // The regression: a phase's own turn teardown runs while the chain flag is
  // still set, so it stays quiet — and that meant the *last* phase of every
  // chain said nothing at all. No "✓ done" line, and no /flow waiting for
  // Enter, on exactly the path where one keypress is most welcome.
  const h = harness();
  saveProjectState(h.workspace, "my-app", "brainstorm");
  writeArtifact(h.workspace, "my-app", "brainstorm");
  writeArtifact(h.workspace, "my-app", "spec");
  h.ctx.arg = "--until plan";
  h.ctx.raw = "/flow --until plan";
  await runCommand("/flow", h.ctx);

  assert.deepEqual(h.labels, ["spec", "plan"], "both phases ran");
  assert.ok(
    h.said.some((s) => s.includes("✓ plan phase done")),
    "the last phase of a chain has to announce itself"
  );
  assert.ok(
    h.said.some((s) => s.includes("/flow-build")),
    "naming the next command"
  );
  assert.deepEqual(h.prefills, ["/flow"], "so Enter continues");
});

test("a single-phase command leaves the announcement to the turn teardown", async () => {
  // runFlow must not print it too: the teardown fires for every non-chained
  // phase, so a duplicate here would show the user the line twice.
  const h = harness();
  saveProjectState(h.workspace, "my-app", "brainstorm");
  writeArtifact(h.workspace, "my-app", "brainstorm");
  h.ctx.raw = "/flow-spec";
  await runCommand("/flow-spec", h.ctx);

  assert.deepEqual(h.labels, ["spec"]);
  assert.ok(!h.said.some((s) => s.includes("✓")), "no duplicate done line");
  assert.deepEqual(h.prefills, [], "and no duplicate prefill");
});

test("a chain that stopped early explains itself instead of announcing a next step", async () => {
  // It already said which phases never ran; adding "next: /flow-build" on top
  // would point at a phase that cannot run until the blocker is cleared.
  const h = harness();
  saveProjectState(h.workspace, "my-app", "plan");
  writeArtifact(h.workspace, "my-app", "plan");
  h.ctx.raw = "/flow-build";
  await runCommand("/flow-build", h.ctx);

  assert.ok(h.said.some((s) => s.includes("Chain stopped at fix")));
  assert.ok(!h.said.some((s) => s.includes("✓")), "a broken chain offers no next step");
  assert.deepEqual(h.prefills, []);
});

test("a chain that runs all the way to ship reports completion, with nothing to prefill", async () => {
  const h = harness();
  saveProjectState(h.workspace, "my-app", "review");
  for (const p of ["brainstorm", "spec", "plan", "review", "fix"] as const) {
    writeArtifact(h.workspace, "my-app", p);
  }
  h.ctx.arg = "--auto";
  h.ctx.raw = "/flow --auto";
  await runCommand("/flow", h.ctx);

  assert.deepEqual(h.labels, ["fix", "ship"]);
  assert.ok(h.said.some((s) => s.includes("the workflow is complete")));
  assert.deepEqual(h.prefills, [], "there is nowhere left to go");
});
