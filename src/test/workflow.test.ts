import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  artifactExists,
  artifactPath,
  BACK_COMMAND,
  clearProjectState,
  DEFAULT_GATES,
  isPlanningDocWrite,
  loadProjectState,
  markRevisit,
  MAX_REVISITS,
  nextPhase,
  parseIdea,
  parsePhase,
  phaseBlocker,
  phaseIndex,
  phasePrompt,
  planRun,
  previousPhase,
  PHASE_ORDER,
  renameProject,
  revisitsRemaining,
  saveProjectState,
  shouldStopAfter,
  slugify,
  staleArtifacts,
  takeRevisit,
  type WorkflowPhase,
} from "../agent/workflow.js";

function tmpWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "kritya-wf-"));
}

/** Write a phase's artifact so the next phase's prerequisite check passes. */
function writeArtifact(ws: string, name: string, phase: WorkflowPhase, body = "content"): void {
  const rel = artifactPath(name, phase);
  assert.ok(rel, `${phase} has no artifact`);
  fs.mkdirSync(path.join(ws, path.dirname(rel)), { recursive: true });
  fs.writeFileSync(path.join(ws, rel), body);
}

test("slugify makes a filesystem-safe slug and caps length", () => {
  assert.equal(slugify("My Todo API!"), "my-todo-api");
  assert.equal(slugify("  spaced  out  "), "spaced-out");
  assert.equal(slugify(""), "project");
  assert.ok(slugify("x".repeat(100)).length <= 40);
});

test("slugify trims to whole words rather than cutting mid-token", () => {
  // The old cap produced `a-script-that-reverses-a-string-python-s` — cut mid-word.
  assert.equal(
    slugify("a script that reverses a string — Python, single file, no dependencies"),
    "a-script-that-reverses-a-string-python"
  );
  // A single word longer than the cap still has to be cut somewhere.
  assert.equal(slugify("x".repeat(60)).length, 40);
});

test("parseIdea takes a short name: prefix, and leaves prose alone", () => {
  assert.deepEqual(parseIdea("reverser: a script that reverses a string"), {
    name: "reverser",
    idea: "a script that reverses a string",
  });
  assert.deepEqual(parseIdea("water tracker: logs daily intake"), {
    name: "water tracker",
    idea: "logs daily intake",
  });

  // No colon: the whole thing is the idea, and names it.
  const plain = parseIdea("a script that reverses a string");
  assert.equal(plain.name, "a script that reverses a string");
  assert.equal(plain.idea, "a script that reverses a string");

  // A colon deep in prose is not a name.
  const prose = parseIdea("a tool that reads config, then does this: parse and print");
  assert.equal(prose.name, prose.idea);
  // Punctuation in the prefix means prose, not a name.
  const punct = parseIdea("build it, quickly: a script");
  assert.equal(punct.name, punct.idea);
  // A colon with nothing after it names nothing.
  const empty = parseIdea("something:");
  assert.equal(empty.name, empty.idea);
});

test("renameProject moves the docs folder and keeps the phase", () => {
  const ws = tmpWorkspace();
  saveProjectState(ws, "old-name", "plan");
  writeArtifact(ws, "old-name", "spec");

  const result = renameProject(ws, "old-name", "New Name");
  assert.deepEqual(result, { ok: true, name: "new-name" });
  assert.equal(loadProjectState(ws)?.name, "new-name");
  assert.equal(loadProjectState(ws)?.phase, "plan");
  assert.ok(fs.existsSync(path.join(ws, "docs/new-name/spec.md")));
  assert.ok(!fs.existsSync(path.join(ws, "docs/old-name")));
});

test("renameProject refuses to merge into an existing folder", () => {
  const ws = tmpWorkspace();
  saveProjectState(ws, "old-name", "spec");
  writeArtifact(ws, "old-name", "spec");
  writeArtifact(ws, "taken", "spec", "someone else's work");

  const result = renameProject(ws, "old-name", "taken");
  assert.equal(result.ok, false);
  assert.equal(loadProjectState(ws)?.name, "old-name");
  // The other project's artifact is untouched.
  assert.equal(fs.readFileSync(path.join(ws, "docs/taken/spec.md"), "utf8"), "someone else's work");
});

test("renameProject rejects an empty name and is a no-op for the same name", () => {
  const ws = tmpWorkspace();
  saveProjectState(ws, "my-app", "spec");
  assert.equal(renameProject(ws, "my-app", "   ").ok, false);
  assert.deepEqual(renameProject(ws, "my-app", "My App"), { ok: true, name: "my-app" });
});

test("phases run brainstorm -> spec -> plan -> build -> review -> fix -> ship", () => {
  assert.deepEqual(PHASE_ORDER, ["brainstorm", "spec", "plan", "build", "review", "fix", "ship"]);
});

test("previousPhase and nextPhase walk the order and stop at the ends", () => {
  assert.equal(previousPhase("brainstorm"), null);
  assert.equal(previousPhase("spec"), "brainstorm");
  assert.equal(previousPhase("plan"), "spec");
  assert.equal(previousPhase("build"), "plan");
  assert.equal(previousPhase("review"), "build");
  assert.equal(previousPhase("fix"), "review");
  assert.equal(previousPhase("ship"), "fix");
  assert.equal(nextPhase("brainstorm"), "spec");
  assert.equal(nextPhase("review"), "fix");
  assert.equal(nextPhase("fix"), "ship");
  assert.equal(nextPhase("ship"), null);
});

test("phaseIndex numbers the phases from 1, for progress display", () => {
  assert.equal(phaseIndex("brainstorm"), 1);
  assert.equal(phaseIndex("plan"), 3);
  assert.equal(phaseIndex("build"), 4);
  assert.equal(phaseIndex("ship"), PHASE_ORDER.length);
});

test("the workflow stops after brainstorm, spec and plan, and runs the rest through", () => {
  // Where it stops is a policy, not a property of the phase list: up to plan a
  // wrong turn costs a document, from build on it costs the code.
  assert.deepEqual(DEFAULT_GATES, ["brainstorm", "spec", "plan"]);
  assert.equal(shouldStopAfter("brainstorm"), true);
  assert.equal(shouldStopAfter("spec"), true);
  assert.equal(shouldStopAfter("plan"), true);
  assert.equal(shouldStopAfter("build"), false);
  assert.equal(shouldStopAfter("review"), false);
  assert.equal(shouldStopAfter("fix"), false);
  assert.equal(shouldStopAfter("ship"), false);
});

test("--auto runs every remaining phase without stopping", () => {
  for (const phase of PHASE_ORDER) assert.equal(shouldStopAfter(phase, { auto: true }), false);
});

test("--until stops at the named phase and nowhere else", () => {
  assert.equal(shouldStopAfter("spec", { until: "spec" }), true);
  assert.equal(shouldStopAfter("brainstorm", { until: "spec" }), false);
  assert.equal(shouldStopAfter("build", { until: "spec" }), false);
  // until wins over the gates it would otherwise stop after.
  assert.equal(shouldStopAfter("plan", { until: "spec" }), false);
});

test("--fast drops brainstorm from the gates, merging it into the spec stretch", () => {
  const gates: WorkflowPhase[] = DEFAULT_GATES.filter((p) => p !== "brainstorm");
  assert.equal(shouldStopAfter("brainstorm", { gates }), false);
  assert.equal(shouldStopAfter("spec", { gates }), true);
});

test("planRun from brainstorm stops at the first gate by default", () => {
  assert.deepEqual(planRun("brainstorm"), ["brainstorm"]);
});

test("planRun from build runs build through ship, because none of them is a gate", () => {
  assert.deepEqual(planRun("build"), ["build", "review", "fix", "ship"]);
});

test("planRun honours until, auto and the gate override", () => {
  assert.deepEqual(planRun("brainstorm", { until: "plan" }), ["brainstorm", "spec", "plan"]);
  assert.deepEqual(planRun("fix", { auto: true }), ["fix", "ship"]);
  assert.deepEqual(planRun("brainstorm", { gates: [] }), [
    "brainstorm",
    "spec",
    "plan",
    "build",
    "review",
    "fix",
    "ship",
  ]);
});

test("planRun always includes the starting phase, and never runs off the end", () => {
  assert.deepEqual(planRun("ship"), ["ship"]);
  assert.deepEqual(planRun("ship", { auto: true }), ["ship"]);
});

test("parsePhase accepts known phases and rejects anything else", () => {
  assert.equal(parsePhase("  SPEC "), "spec");
  assert.equal(parsePhase("design"), null);
  assert.equal(parsePhase(""), null);
});

test("save then load round-trips the project state", () => {
  const ws = tmpWorkspace();
  saveProjectState(ws, "My App", "brainstorm");
  const state = loadProjectState(ws);
  assert.equal(state?.name, "my-app");
  assert.equal(state?.phase, "brainstorm");
  assert.ok(state?.updatedAt);
});

test("loadProjectState returns null when there is no state file", () => {
  assert.equal(loadProjectState(tmpWorkspace()), null);
});

test("loadProjectState returns null for an invalid phase", () => {
  const ws = tmpWorkspace();
  fs.mkdirSync(path.join(ws, ".kritya"), { recursive: true });
  fs.writeFileSync(
    path.join(ws, ".kritya", "project.json"),
    JSON.stringify({ name: "x", phase: "nope" })
  );
  assert.equal(loadProjectState(ws), null);
});

test("markRevisit records where a finding belongs, and the status reads it back", () => {
  const ws = tmpWorkspace();
  saveProjectState(ws, "my-app", "fix");
  assert.equal(markRevisit(ws, "spec", "AC3 contradicts AC5"), true);
  const state = loadProjectState(ws);
  assert.deepEqual(state?.revisit, { to: "spec", reason: "AC3 contradicts AC5" });
  assert.equal(state?.phase, "fix", "recording a revisit must not move the phase");
});

test("markRevisit is a no-op with no active project", () => {
  assert.equal(markRevisit(tmpWorkspace(), "spec", "why"), false);
});

test("loadProjectState drops a malformed revisit rather than trusting it", () => {
  // The agent writes this file itself during an autonomous run, so anything
  // malformed has to be treated as absent.
  const ws = tmpWorkspace();
  fs.mkdirSync(path.join(ws, ".kritya"), { recursive: true });
  fs.writeFileSync(
    path.join(ws, ".kritya", "project.json"),
    JSON.stringify({ name: "x", phase: "fix", revisit: { to: "design", reason: "nope" } })
  );
  assert.equal(loadProjectState(ws)?.revisit, undefined);

  fs.writeFileSync(
    path.join(ws, ".kritya", "project.json"),
    JSON.stringify({ name: "x", phase: "fix", revisit: "just a string" })
  );
  assert.equal(loadProjectState(ws)?.revisit, undefined);
});

test("moving to a phase consumes the revisit but keeps the loop-back count", () => {
  const ws = tmpWorkspace();
  saveProjectState(ws, "my-app", "fix");
  markRevisit(ws, "spec", "AC3 is wrong");
  takeRevisit(ws, "spec");
  // saveProjectState runs when the spec phase actually starts.
  saveProjectState(ws, "my-app", "spec");
  const state = loadProjectState(ws);
  assert.equal(state?.revisit, undefined, "acting on the revisit clears it");
  assert.equal(state?.revisits, 1, "but the count survives, because it bounds the loop");
});

test("a rename keeps the loop-back count, so it cannot be used to reset the budget", () => {
  const ws = tmpWorkspace();
  saveProjectState(ws, "my-app", "fix");
  takeRevisit(ws, "spec");
  saveProjectState(ws, "my-app", "fix");
  assert.equal(loadProjectState(ws)?.revisits, 1);

  assert.deepEqual(renameProject(ws, "my-app", "renamed-app"), { ok: true, name: "renamed-app" });
  assert.equal(
    loadProjectState(ws)?.revisits,
    1,
    "the same project under a new name keeps its count"
  );
});

test("a genuinely new project starts with a fresh loop-back budget", () => {
  const ws = tmpWorkspace();
  saveProjectState(ws, "my-app", "fix");
  takeRevisit(ws, "spec");
  saveProjectState(ws, "other-app", "brainstorm");
  assert.equal(loadProjectState(ws)?.revisits, undefined);
  assert.equal(revisitsRemaining(ws), MAX_REVISITS);
});

test("takeRevisit spends the budget and then refuses", () => {
  const ws = tmpWorkspace();
  saveProjectState(ws, "my-app", "fix");
  assert.equal(revisitsRemaining(ws), MAX_REVISITS);
  for (let i = 0; i < MAX_REVISITS; i++) {
    assert.equal(takeRevisit(ws, "spec"), true, `loop-back ${i + 1} should be allowed`);
    assert.equal(loadProjectState(ws)?.phase, "spec", "takeRevisit rewinds the phase");
    saveProjectState(ws, "my-app", "fix");
  }
  assert.equal(revisitsRemaining(ws), 0);
  assert.equal(takeRevisit(ws, "spec"), false, "past the limit the workflow refuses");
  assert.equal(loadProjectState(ws)?.phase, "fix", "and leaves the phase alone");
});

test("takeRevisit is a no-op with no active project", () => {
  assert.equal(takeRevisit(tmpWorkspace(), "spec"), false);
});

test("clearProjectState ends the workflow but keeps the artifacts", () => {
  const ws = tmpWorkspace();
  saveProjectState(ws, "my-app", "build");
  writeArtifact(ws, "my-app", "spec");
  assert.equal(clearProjectState(ws), true);
  assert.equal(loadProjectState(ws), null);
  assert.ok(fs.existsSync(path.join(ws, "docs/my-app/spec.md")));
  // Clearing again is a no-op, not a throw.
  assert.equal(clearProjectState(ws), false);
});

test("artifactPath points at docs/<name>/<phase>.md, and null for build", () => {
  assert.equal(artifactPath("My App", "brainstorm"), "docs/my-app/brainstorm.md");
  assert.equal(artifactPath("My App", "spec"), "docs/my-app/spec.md");
  assert.equal(artifactPath("My App", "plan"), "docs/my-app/plan.md");
  assert.equal(artifactPath("My App", "review"), "docs/my-app/review.md");
  assert.equal(artifactPath("My App", "fix"), "docs/my-app/fix.md");
  assert.equal(artifactPath("My App", "build"), null);
});

test("artifactExists needs a non-empty file, and build has nothing to check", () => {
  const ws = tmpWorkspace();
  assert.equal(artifactExists(ws, "my-app", "spec"), false);
  writeArtifact(ws, "my-app", "spec", "");
  assert.equal(artifactExists(ws, "my-app", "spec"), false, "an empty artifact is not an artifact");
  writeArtifact(ws, "my-app", "spec");
  assert.equal(artifactExists(ws, "my-app", "spec"), true);
  assert.equal(artifactExists(ws, "my-app", "build"), true);
});

test("phaseBlocker stops a phase whose input was never written", () => {
  const ws = tmpWorkspace();
  // Nothing to require before the first phase.
  assert.equal(phaseBlocker(ws, "my-app", "brainstorm"), null);

  const blocked = phaseBlocker(ws, "my-app", "plan");
  assert.match(blocked ?? "", /docs\/my-app\/spec\.md/);
  assert.match(blocked ?? "", /\/spec/);

  writeArtifact(ws, "my-app", "spec");
  assert.equal(phaseBlocker(ws, "my-app", "plan"), null);
});

test("phaseBlocker for build looks at the plan, and for review at the build", () => {
  const ws = tmpWorkspace();
  assert.match(phaseBlocker(ws, "my-app", "build") ?? "", /plan\.md/);
  writeArtifact(ws, "my-app", "plan");
  assert.equal(phaseBlocker(ws, "my-app", "build"), null);
  // Build writes code rather than a doc, so there is no file to look for. With
  // no recorded phase there is nothing to go on, so review is not blocked.
  assert.equal(phaseBlocker(ws, "my-app", "review"), null);
});

test("phaseBlocker falls back to the recorded phase for review", () => {
  // The artifact check cannot see build's output, so a project that never
  // reached build would otherwise sail into a review of nothing.
  const ws = tmpWorkspace();
  saveProjectState(ws, "my-app", "plan");
  assert.match(phaseBlocker(ws, "my-app", "review") ?? "", /has not reached build yet/);

  saveProjectState(ws, "my-app", "build");
  assert.equal(phaseBlocker(ws, "my-app", "review"), null);

  // Past build is fine too — that is the normal case for a re-review.
  saveProjectState(ws, "my-app", "fix");
  assert.equal(phaseBlocker(ws, "my-app", "review"), null);
});

test("phaseBlocker for fix looks at the review", () => {
  const ws = tmpWorkspace();
  assert.match(phaseBlocker(ws, "my-app", "fix") ?? "", /review\.md/);
  writeArtifact(ws, "my-app", "review");
  assert.equal(phaseBlocker(ws, "my-app", "fix"), null);
});

test("isPlanningDocWrite allows only the active project's own docs", () => {
  const ws = tmpWorkspace();
  const ok = (p: string, tool = "write_file", name: string | null = "my-app") =>
    isPlanningDocWrite(ws, tool, { path: p }, name);

  assert.equal(ok("docs/my-app/plan.md"), true);
  assert.equal(ok("./docs/my-app/spec.md", "edit_file", "My App"), true);
  assert.equal(ok("docs/my-app/plan.md", "edit_file"), true);
  assert.equal(ok("src/index.ts"), false);
  assert.equal(ok("docs/my-app/notes.txt"), false);
  assert.equal(ok("docs/my-app/plan.md", "shell"), false);
});

test("isPlanningDocWrite accepts an absolute path inside the workspace", () => {
  // The regression that made the plan phase unable to write its own plan.md:
  // models pass an absolute path even when told the argument is relative, and
  // a plain "docs/" prefix test rejects those. Plan mode then blocked the one
  // write it is supposed to permit.
  const ws = tmpWorkspace();
  const abs = path.join(ws, "docs", "my-app", "plan.md");
  assert.equal(isPlanningDocWrite(ws, "write_file", { path: abs }, "my-app"), true);
});

test("isPlanningDocWrite does not let plan mode edit unrelated documentation", () => {
  // The whole point of the scoping: plan mode must not become a way to rewrite
  // a repo's own docs as a side effect of planning something else.
  const ws = tmpWorkspace();
  const ok = (p: string, name: string | null = "my-app") =>
    isPlanningDocWrite(ws, "write_file", { path: p }, name);

  assert.equal(ok("docs/ARCHITECTURE.md"), false);
  assert.equal(ok("docs/other/plan.md"), false);
  assert.equal(ok("docs/my-app/../../etc/x.md"), false);
  // Absolute paths get no special treatment either, in or out of the workspace.
  assert.equal(ok(path.join(ws, "docs", "other", "plan.md")), false);
  assert.equal(ok("/etc/passwd.md"), false);
  assert.equal(ok(""), false);
  // With no active project there is no planning doc to exempt.
  assert.equal(ok("docs/my-app/plan.md", null), false);
  assert.equal(
    isPlanningDocWrite(ws, "write_file", { path: "docs/my-app/plan.md" }, undefined),
    false
  );
});

test("every phase prompt names the project and the artifact it writes", () => {
  for (const phase of PHASE_ORDER) {
    const prompt = phasePrompt("My App", phase, "");
    assert.match(prompt, /my-app/, `${phase} prompt should name the slug`);
    const artifact = artifactPath("My App", phase);
    if (artifact) {
      assert.match(prompt, new RegExp(artifact.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")), phase);
    }
  }
});

test("each phase prompt points at the phase before it, not a later one", () => {
  assert.match(phasePrompt("app", "spec", ""), /Read docs\/app\/brainstorm\.md first/);
  assert.match(phasePrompt("app", "plan", ""), /Read docs\/app\/spec\.md first/);
  assert.match(phasePrompt("app", "build", ""), /Read docs\/app\/plan\.md/);
  assert.match(phasePrompt("app", "fix", ""), /Read docs\/app\/review\.md/);
  // The spec phase must not reach forward into the plan's territory.
  assert.doesNotMatch(phasePrompt("app", "spec", ""), /docs\/app\/plan\.md/);
});

test("phase prompts require the artifact to be written before approval is asked", () => {
  // Models otherwise print the document in chat and ask whether to save it,
  // leaving the next phase with no file to read.
  for (const phase of PHASE_ORDER) {
    const artifact = artifactPath("app", phase);
    if (!artifact) continue;
    assert.match(phasePrompt("app", phase, ""), /BEFORE you ask/, phase);
  }
});

test("the plan phase is told its own write will succeed under plan mode", () => {
  const prompt = phasePrompt("app", "plan", "");
  assert.match(prompt, /do not ask the user to turn plan mode off/i);
});

test("a gated phase hands off to the next command; an ungated one carries straight on", () => {
  // Gated: the run stops here, so the prompt names the command the user runs next.
  assert.match(phasePrompt("app", "brainstorm", ""), /\/flow-spec/);
  assert.match(phasePrompt("app", "spec", ""), /\/flow-plan/);
  assert.match(phasePrompt("app", "plan", ""), /\/flow-build/);
  // Ungated: the chain runs the next phase itself, so asking for approval here
  // would stall a stretch the user asked to run through.
  assert.doesNotMatch(phasePrompt("app", "build", ""), /they will run/);
  assert.match(phasePrompt("app", "build", ""), /carry straight on into the review phase/);
  assert.doesNotMatch(phasePrompt("app", "review", ""), /they will run/);
  assert.match(phasePrompt("app", "review", ""), /carry straight on into the fix phase/);
});

test("stopAfter can be forced either way, overriding the gate policy", () => {
  // --until plan: build is not a gate, but the run still ends at plan, so the
  // plan prompt asks for approval even though its own policy would not.
  assert.match(phasePrompt("app", "build", "", { stopAfter: true }), /they will run/);
  // --auto: spec is a gate, but the run was told not to stop.
  assert.match(phasePrompt("app", "spec", "", { stopAfter: false }), /Do not stop for approval/);
});

test("the fix phase offers the loop-back when a finding belongs upstream", () => {
  const prompt = phasePrompt("app", "fix", "");
  assert.match(prompt, /revisit/);
  assert.match(prompt, new RegExp(BACK_COMMAND.replace("/", "\\/")));
  assert.match(prompt, /belongs upstream|requirement itself is wrong/);
});

test("the ship phase runs the real test suite and asks before committing", () => {
  const prompt = phasePrompt("app", "ship", "");
  assert.match(prompt, /actually run the project's test suite/i);
  assert.match(prompt, /docs\/app\/ship\.md/);
  assert.match(prompt, /Do NOT commit/);
  // A handover that claims success without running anything is worse than none.
  assert.match(prompt, /worse than no handover/i);
});

test("the build phase treats tests as part of the deliverable", () => {
  const prompt = phasePrompt("app", "build", "");
  assert.match(prompt, /acceptance criteria/i);
  assert.match(prompt, /tests/i);
  assert.match(prompt, /pass/i);
});

test("the review phase dispatches read-only subagents for spec compliance and security", () => {
  const prompt = phasePrompt("app", "review", "");
  assert.match(prompt, /spawn_agent/);
  assert.match(prompt, /SPEC COMPLIANCE/);
  assert.match(prompt, /SECURITY/);
  assert.match(prompt, /docs\/app\/review\.md/);
  // Reviewing and fixing in one pass gives neither a real review nor a real fix.
  assert.match(prompt, /Do not fix/i);
  assert.match(prompt, /SCORECARD/);
});

test("the plan phase tags milestones by risk", () => {
  const prompt = phasePrompt("app", "plan", "");
  assert.match(prompt, /RISKY/);
  assert.match(prompt, /ROUTINE/);
});

test("the build phase stops instead of retrying a milestone forever", () => {
  const prompt = phasePrompt("app", "build", "");
  assert.match(prompt, /fail(s|ed)? twice/i);
  assert.match(prompt, /blocked/i);
});

test("the fix phase re-verifies findings with a read-only subagent", () => {
  const prompt = phasePrompt("app", "fix", "");
  assert.match(prompt, /docs\/app\/review\.md/);
  assert.match(prompt, /docs\/app\/fix\.md/);
  assert.match(prompt, /read-only subagent/i);
});

test("phase prompts cap artifact length so later phases stay cheap to run", () => {
  for (const phase of ["brainstorm", "spec", "plan", "review", "fix"] as WorkflowPhase[]) {
    assert.match(phasePrompt("app", phase, ""), /under ~\d+ words/, phase);
  }
});

test("phasePrompt appends the user's input when provided", () => {
  const prompt = phasePrompt("app", "brainstorm", "a habit tracker");
  assert.match(prompt, /a habit tracker/);
});

test("the brainstorm phase prefers ask_user over open-ended prose questions", () => {
  const prompt = phasePrompt("app", "brainstorm", "");
  assert.match(prompt, /ask_user/);
  assert.match(prompt, /sensible default/i);
});

test("the spec phase asks for must-have vs later priority on each criterion", () => {
  const prompt = phasePrompt("app", "spec", "");
  assert.match(prompt, /MUST/);
  assert.match(prompt, /LATER/);
});

test("the spec phase surfaces non-functional requirements via ask_user", () => {
  const prompt = phasePrompt("app", "spec", "");
  assert.match(prompt, /ask_user/);
  assert.match(prompt, /Non-functional requirements/);
  assert.match(prompt, /SEC1/);
  assert.match(prompt, /REL1/);
  assert.match(prompt, /do not invent security or reliability requirements/i);
});

test("the plan phase surfaces trust boundaries for SEC\\/REL milestones, but only if spec has them", () => {
  const prompt = phasePrompt("app", "plan", "");
  assert.match(prompt, /Non-functional requirements/);
  assert.match(prompt, /trust boundary/i);
  assert.match(prompt, /skip this/i);
});

test("the build phase enforces test-first ordering", () => {
  const prompt = phasePrompt("app", "build", "");
  assert.match(prompt, /before the code it tests/i);
  assert.match(prompt, /confirm it fails/i);
  assert.match(prompt, /Do not write the implementation first/i);
});

test("the build phase requires negative-path tests for SEC\\/REL milestones", () => {
  const prompt = phasePrompt("app", "build", "");
  assert.match(prompt, /negative\/failure-path test/i);
  assert.match(prompt, /SEC or REL/);
});

test("the review phase adds a third reliability subagent", () => {
  const prompt = phasePrompt("app", "review", "");
  assert.match(prompt, /RELIABILITY/);
  assert.match(prompt, /error handling/i);
  assert.match(prompt, /REL-labelled/);
});

test("staleArtifacts is quiet when nothing has drifted", () => {
  const ws = tmpWorkspace();
  writeArtifact(ws, "app", "brainstorm");
  writeArtifact(ws, "app", "spec");
  assert.deepEqual(staleArtifacts(ws, "app", "spec"), []);
});

test("staleArtifacts flags a downstream doc written before an upstream edit", () => {
  const ws = tmpWorkspace();
  writeArtifact(ws, "app", "brainstorm");
  writeArtifact(ws, "app", "spec");
  writeArtifact(ws, "app", "plan");
  // Force spec.md's mtime after plan.md's, simulating an edit made later.
  const specPath = path.join(ws, artifactPath("app", "spec")!);
  const future = new Date(Date.now() + 60_000);
  fs.utimesSync(specPath, future, future);

  const warnings = staleArtifacts(ws, "app", "plan");
  assert.ok(warnings.some((w) => /plan\.md/.test(w)));
});

test("staleArtifacts warns about the build itself once a stale plan has been built from", () => {
  const ws = tmpWorkspace();
  writeArtifact(ws, "app", "spec");
  writeArtifact(ws, "app", "plan");
  const specPath = path.join(ws, artifactPath("app", "spec")!);
  const future = new Date(Date.now() + 60_000);
  fs.utimesSync(specPath, future, future);

  // Before build has been reached, no claim is made about "the code".
  assert.ok(!staleArtifacts(ws, "app", "plan").some((w) => /code/.test(w)));
  // Once the project has reached build (or beyond), the code is called out too.
  assert.ok(staleArtifacts(ws, "app", "build").some((w) => /code/.test(w)));
});
