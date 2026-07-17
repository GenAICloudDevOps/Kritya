import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { resolveSafe, truncateResult } from "../tools/common.js";
import { editFileTool } from "../tools/edit.js";
import { grepTool } from "../tools/grep.js";
import { readFileTool } from "../tools/read.js";
import { writeFileTool } from "../tools/write.js";
import { buildSystemPrompt } from "../agent/systemPrompt.js";
import { parseDotEnv } from "../config/config.js";
import { PermissionManager } from "../permissions/permissions.js";
import { diffLines } from "../tools/diff.js";
import { UndoStack } from "../undo/undo.js";
import { ALL_TOOLS } from "../tools/index.js";

async function makeWorkspace(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "code-cli-test-"));
}

test("resolveSafe allows paths inside the workspace", async () => {
  const ws = await makeWorkspace();
  assert.equal(resolveSafe(ws, "a/b.txt"), path.join(ws, "a", "b.txt"));
});

test("resolveSafe rejects escapes", async () => {
  const ws = await makeWorkspace();
  assert.throws(() => resolveSafe(ws, "../outside.txt"));
  assert.throws(() => resolveSafe(ws, "/etc/passwd"));
  assert.throws(() => resolveSafe(ws, "a/../../outside.txt"));
});

test("truncateResult caps long output", () => {
  const out = truncateResult("x".repeat(100), 10);
  assert.ok(out.startsWith("xxxxxxxxxx"));
  assert.ok(out.includes("truncated"));
});

test("write then read roundtrip", async () => {
  const ws = await makeWorkspace();
  const ctx = { workspace: ws };
  await writeFileTool.execute({ path: "dir/hello.txt", content: "line1\nline2" }, ctx);
  const out = await readFileTool.execute({ path: "dir/hello.txt" }, ctx);
  assert.ok(out.includes("line1"));
  assert.ok(out.includes("line2"));
});

test("edit requires unique old_string", async () => {
  const ws = await makeWorkspace();
  const ctx = { workspace: ws };
  await writeFileTool.execute({ path: "f.txt", content: "aaa bbb aaa" }, ctx);
  await assert.rejects(
    () => editFileTool.execute({ path: "f.txt", old_string: "aaa", new_string: "ccc" }, ctx),
    /occurs 2 times/
  );
  await editFileTool.execute(
    { path: "f.txt", old_string: "aaa", new_string: "ccc", replace_all: true },
    ctx
  );
  const out = await readFileTool.execute({ path: "f.txt" }, ctx);
  assert.ok(out.includes("ccc bbb ccc"));
});

test("edit fails when old_string is missing", async () => {
  const ws = await makeWorkspace();
  const ctx = { workspace: ws };
  await writeFileTool.execute({ path: "f.txt", content: "hello" }, ctx);
  await assert.rejects(
    () => editFileTool.execute({ path: "f.txt", old_string: "nope", new_string: "x" }, ctx),
    /not found/
  );
});

test("grep finds matches with file:line format", async () => {
  const ws = await makeWorkspace();
  const ctx = { workspace: ws };
  await writeFileTool.execute({ path: "src/a.ts", content: "const foo = 1;\nconst bar = 2;" }, ctx);
  const out = await grepTool.execute({ pattern: "foo", include: "**/*.ts" }, ctx);
  assert.match(out, /src[\/\\]a\.ts:1: const foo = 1;/);
});

test("parseDotEnv handles comments, quotes, and export prefix", () => {
  const vars = parseDotEnv(
    `# comment\nNVIDIA_API_KEY=nvapi-abc123\nexport FOO="bar baz"\nQUX='quoted'\n\nnot a var line\n`
  );
  assert.deepEqual(vars, { NVIDIA_API_KEY: "nvapi-abc123", FOO: "bar baz", QUX: "quoted" });
});

test("diffLines shows removals and additions with context", () => {
  const diff = diffLines("a\nb\nc\nd", "a\nB\nc\nd");
  assert.ok(diff.includes("- b"));
  assert.ok(diff.includes("+ B"));
  assert.ok(diff.includes("  a"));
});

test("diffLines on a new file is all additions", () => {
  const diff = diffLines("", "one\ntwo");
  assert.equal(diff, "+ one\n+ two");
});

test("undo restores previous content and deletes created files", async () => {
  const ws = await makeWorkspace();
  const ctx = { workspace: ws };
  const undo = new UndoStack();
  const abs = path.join(ws, "u.txt");

  // Change 1: create a new file (did not exist before).
  undo.snapshot(abs, "u.txt");
  await fs.writeFile(abs, "v1");
  // Change 2: overwrite it.
  undo.snapshot(abs, "u.txt");
  await fs.writeFile(abs, "v2");

  assert.match(undo.undo() ?? "", /Restored/);
  assert.equal(await fs.readFile(abs, "utf8"), "v1");
  assert.match(undo.undo() ?? "", /Deleted/);
  await assert.rejects(() => fs.readFile(abs, "utf8"));
  assert.equal(undo.undo(), null);
});

test("system prompt includes CODECLI.md project memory", async () => {
  const ws = await makeWorkspace();
  await fs.writeFile(path.join(ws, "CODECLI.md"), "Always use TypeScript.");
  const prompt = buildSystemPrompt(ws);
  assert.ok(prompt.includes("Always use TypeScript."));
  assert.ok(prompt.includes("Project instructions"));

  const wsEmpty = await makeWorkspace();
  assert.ok(!buildSystemPrompt(wsEmpty).includes("Project instructions"));
});

test("permission manager: reads never prompt, writes prompt until always", () => {
  const pm = new PermissionManager();
  const read = ALL_TOOLS.find((t) => t.name === "read_file")!;
  const write = ALL_TOOLS.find((t) => t.name === "write_file")!;
  assert.equal(pm.needsPrompt(read), false);
  assert.equal(pm.needsPrompt(write), true);
  pm.record("write_file", "yes");
  assert.equal(pm.needsPrompt(write), true);
  pm.record("write_file", "always");
  assert.equal(pm.needsPrompt(write), false);
});
