import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  artifactPath,
  isPlanningDocWrite,
  loadProjectState,
  phasePrompt,
  saveProjectState,
  slugify,
} from "../agent/workflow.js";

function tmpWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "kritya-wf-"));
}

test("slugify makes a filesystem-safe slug and caps length", () => {
  assert.equal(slugify("My Todo API!"), "my-todo-api");
  assert.equal(slugify("  spaced  out  "), "spaced-out");
  assert.equal(slugify(""), "project");
  assert.ok(slugify("x".repeat(100)).length <= 40);
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

test("artifactPath points at docs/<name>/<phase>.md, and null for build", () => {
  assert.equal(artifactPath("My App", "brainstorm"), "docs/my-app/brainstorm.md");
  assert.equal(artifactPath("My App", "plan"), "docs/my-app/plan.md");
  assert.equal(artifactPath("My App", "spec"), "docs/my-app/spec.md");
  assert.equal(artifactPath("My App", "build"), null);
});

test("isPlanningDocWrite allows Markdown docs under docs/ but not code", () => {
  assert.equal(isPlanningDocWrite("write_file", { path: "docs/my-app/plan.md" }), true);
  assert.equal(isPlanningDocWrite("edit_file", { path: "./docs/my-app/spec.md" }), true);
  assert.equal(isPlanningDocWrite("write_file", { path: "docs\\my-app\\plan.md" }), true);
  assert.equal(isPlanningDocWrite("write_file", { path: "src/index.ts" }), false);
  assert.equal(isPlanningDocWrite("write_file", { path: "docs/notes.txt" }), false);
  assert.equal(isPlanningDocWrite("shell", { path: "docs/my-app/plan.md" }), false);
});

test("phasePrompt names the slug and its artifact for each phase", () => {
  assert.match(phasePrompt("My App", "brainstorm", ""), /docs\/my-app\/brainstorm\.md/);
  assert.match(phasePrompt("My App", "plan", ""), /docs\/my-app\/plan\.md/);
  assert.match(phasePrompt("My App", "spec", ""), /docs\/my-app\/spec\.md/);
  assert.match(phasePrompt("My App", "build", ""), /docs\/my-app\/spec\.md/);
});

test("phasePrompt appends the user's input when provided", () => {
  const prompt = phasePrompt("app", "brainstorm", "a habit tracker");
  assert.match(prompt, /a habit tracker/);
});
