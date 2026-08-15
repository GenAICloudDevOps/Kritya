import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  artifactExists,
  artifactPath,
  clearProjectState,
  isPlanningDocWrite,
  loadProjectState,
  nextPhase,
  parseIdea,
  parsePhase,
  phaseBlocker,
  phasePrompt,
  previousPhase,
  PHASE_ORDER,
  renameProject,
  saveProjectState,
  slugify,
  staleArtifacts,
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

test("phases run brainstorm -> spec -> plan -> build -> review -> fix", () => {
  assert.deepEqual(PHASE_ORDER, ["brainstorm", "spec", "plan", "build", "review", "fix"]);
});

test("previousPhase and nextPhase walk the order and stop at the ends", () => {
  assert.equal(previousPhase("brainstorm"), null);
  assert.equal(previousPhase("spec"), "brainstorm");
  assert.equal(previousPhase("plan"), "spec");
  assert.equal(previousPhase("build"), "plan");
  assert.equal(previousPhase("review"), "build");
  assert.equal(previousPhase("fix"), "review");
  assert.equal(nextPhase("brainstorm"), "spec");
  assert.equal(nextPhase("review"), "fix");
  assert.equal(nextPhase("fix"), null);
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
  // Build writes code rather than a doc, so review is never blocked on a file.
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
    if (artifact) assert.match(prompt, new RegExp(artifact.replace(/[/.]/g, "\\$&")), phase);
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

test("phase prompts hand off to the next phase's command, and fix ends the chain", () => {
  assert.match(phasePrompt("app", "brainstorm", ""), /\/flow-spec/);
  assert.match(phasePrompt("app", "spec", ""), /\/flow-plan/);
  assert.match(phasePrompt("app", "plan", ""), /\/flow-build/);
  assert.match(phasePrompt("app", "build", ""), /\/flow-review/);
  assert.match(phasePrompt("app", "review", ""), /\/flow-fix/);
  assert.doesNotMatch(phasePrompt("app", "fix", ""), /they will run/);
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
