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

test("resolveSafe rejects a symlinked file pointing outside the workspace", async () => {
  const ws = await makeWorkspace();
  const outside = await makeWorkspace();
  const target = path.join(outside, "secret.txt");
  await fs.writeFile(target, "secret");
  await fs.symlink(target, path.join(ws, "link.txt"));
  assert.throws(() => resolveSafe(ws, "link.txt"));
});

test("resolveSafe rejects escapes through a symlinked directory", async () => {
  const ws = await makeWorkspace();
  const outside = await makeWorkspace();
  await fs.writeFile(path.join(outside, "secret.txt"), "secret");
  await fs.symlink(outside, path.join(ws, "escape"), "dir");
  assert.throws(() => resolveSafe(ws, "escape/secret.txt"));
});

test("resolveSafe rejects escapes through a symlinked directory for a not-yet-existing file", async () => {
  const ws = await makeWorkspace();
  const outside = await makeWorkspace();
  await fs.symlink(outside, path.join(ws, "escape"), "dir");
  assert.throws(() => resolveSafe(ws, "escape/new-file.txt"));
});

test("resolveSafe allows symlinks that stay inside the workspace", async () => {
  const ws = await makeWorkspace();
  await fs.mkdir(path.join(ws, "real"));
  await fs.symlink(path.join(ws, "real"), path.join(ws, "alias"), "dir");
  assert.equal(resolveSafe(ws, "alias/file.txt"), path.join(ws, "alias", "file.txt"));
});

test("resolveSafe blocks credential-store and key files", async () => {
  const ws = await makeWorkspace();
  for (const p of [
    ".npmrc",
    ".netrc",
    ".pypirc",
    ".git-credentials",
    "certs/client.p12",
    "certs/client.pfx",
  ]) {
    assert.throws(() => resolveSafe(ws, p), new RegExp("secret"), `${p} should be blocked`);
  }
  // Ordinary files with similar names stay accessible.
  assert.ok(resolveSafe(ws, "npmrc.md"));
  assert.ok(resolveSafe(ws, "src/token.ts"));
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

test("write_file blocks content containing a real-looking secret", async () => {
  const ws = await makeWorkspace();
  const ctx = { workspace: ws };
  await assert.rejects(
    () =>
      writeFileTool.execute(
        { path: "config.ts", content: `const key = "AKIAABCDEFGHIJKLMNOP";` },
        ctx
      ),
    /looks like it contains real secret/
  );
  await assert.rejects(
    () =>
      writeFileTool.execute(
        {
          path: "notes.md",
          content: "-----BEGIN RSA PRIVATE KEY-----\nMIIB...\n-----END RSA PRIVATE KEY-----",
        },
        ctx
      ),
    /looks like it contains real secret/
  );
});

test("write_file allows ordinary content and placeholder-looking secrets", async () => {
  const ws = await makeWorkspace();
  const ctx = { workspace: ws };
  await writeFileTool.execute(
    { path: "README.md", content: "Set ANTHROPIC_API_KEY to your key, e.g. sk-ant-EXAMPLE-KEY." },
    ctx
  );
  await writeFileTool.execute(
    { path: "settings.txt", content: `API_KEY=your_api_key_here\nTOKEN=xxxxxxxxxxxxxxxxxxxx` },
    ctx
  );
  const out = await readFileTool.execute({ path: "README.md" }, ctx);
  assert.ok(out.includes("ANTHROPIC_API_KEY"));
});

test("edit_file blocks introducing a secret via new_string", async () => {
  const ws = await makeWorkspace();
  const ctx = { workspace: ws };
  await writeFileTool.execute({ path: "f.txt", content: "placeholder" }, ctx);
  await assert.rejects(
    () =>
      editFileTool.execute(
        { path: "f.txt", old_string: "placeholder", new_string: "ghp_" + "a".repeat(36) },
        ctx
      ),
    /looks like it contains real secret/
  );
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
  assert.match(out, /src[/\\]a\.ts:1: const foo = 1;/);
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

test("diffLines marks the changed characters on a single-line edit", () => {
  const diff = diffLines("value = 3000;", "value = 9999;");
  assert.ok(diff.includes("- value = «3000»;"));
  assert.ok(diff.includes("+ value = «9999»;"));
});

test("undo restores previous content and deletes created files", async () => {
  const ws = await makeWorkspace();
  const undo = new UndoStack();
  const abs = path.join(ws, "u.txt");

  // Turn 1: create a new file (did not exist before).
  undo.beginTurn();
  undo.snapshot(abs, "u.txt");
  await fs.writeFile(abs, "v1");
  // Turn 2: overwrite it.
  undo.beginTurn();
  undo.snapshot(abs, "u.txt");
  await fs.writeFile(abs, "v2");

  assert.match(undo.undo() ?? "", /Restored/);
  assert.equal(await fs.readFile(abs, "utf8"), "v1");
  assert.match(undo.undo() ?? "", /Removed/);
  await assert.rejects(() => fs.readFile(abs, "utf8"));
  assert.equal(undo.undo(), null);
});

test("redo reapplies the most recently undone turn", async () => {
  const ws = await makeWorkspace();
  const undo = new UndoStack();
  const abs = path.join(ws, "r.txt");
  await fs.writeFile(abs, "v1");

  undo.beginTurn();
  undo.snapshot(abs, "r.txt");
  await fs.writeFile(abs, "v2");

  assert.match(undo.undo() ?? "", /Restored/);
  assert.equal(await fs.readFile(abs, "utf8"), "v1");
  assert.match(undo.redo() ?? "", /Restored/);
  assert.equal(await fs.readFile(abs, "utf8"), "v2");
  // Undo again works after a redo.
  assert.match(undo.undo() ?? "", /Restored/);
  assert.equal(await fs.readFile(abs, "utf8"), "v1");
  assert.equal(undo.redo() !== null, true);
});

test("rewindTo reverts every file change made after a checkpoint turn", async () => {
  const ws = await makeWorkspace();
  const undo = new UndoStack();
  const abs = path.join(ws, "c.txt");
  await fs.writeFile(abs, "v0");

  // Turn 1: the point we'll checkpoint at.
  undo.beginTurn();
  undo.snapshot(abs, "c.txt");
  await fs.writeFile(abs, "v1");
  const mark = undo.currentTurn();

  // Two more turns of changes after the checkpoint.
  undo.beginTurn();
  undo.snapshot(abs, "c.txt");
  await fs.writeFile(abs, "v2");
  undo.beginTurn();
  undo.snapshot(abs, "c.txt");
  await fs.writeFile(abs, "v3");

  const result = undo.rewindTo(mark);
  assert.match(result ?? "", /Restored/);
  // Rolled back to the checkpoint's state, not all the way to v0.
  assert.equal(await fs.readFile(abs, "utf8"), "v1");
  // Nothing newer than the checkpoint remains to revert.
  assert.equal(undo.rewindTo(mark), null);
});

test("undo reverts all files changed in the same turn together", async () => {
  const ws = await makeWorkspace();
  const undo = new UndoStack();
  const a = path.join(ws, "a.txt");
  const b = path.join(ws, "b.txt");
  await fs.writeFile(a, "a-old");

  undo.beginTurn();
  undo.snapshot(a, "a.txt");
  await fs.writeFile(a, "a-new");
  undo.snapshot(b, "b.txt");
  await fs.writeFile(b, "b-new");

  const result = undo.undo() ?? "";
  assert.match(result, /Reverted 2 files/);
  assert.equal(await fs.readFile(a, "utf8"), "a-old");
  await assert.rejects(() => fs.readFile(b, "utf8"));
  assert.equal(undo.undo(), null);
});

test("undo checkpoints an external edit made between turns via the file watcher", async () => {
  const ws = await makeWorkspace();
  const undo = new UndoStack();
  const abs = path.join(ws, "w.txt");
  let notified = "";
  undo.onExternalChange = (relPath) => {
    notified = relPath;
  };

  undo.beginTurn();
  undo.snapshot(abs, "w.txt");
  await fs.writeFile(abs, "kritya-wrote-this");

  // Wait past the own-write grace window so the watcher treats the next
  // change as external, then simulate the user hand-editing the file.
  await new Promise((r) => setTimeout(r, 900));
  await fs.writeFile(abs, "user-hand-edited-this");

  // fs.watch delivers change events asynchronously; poll briefly for it.
  const deadline = Date.now() + 3000;
  while (undo.size < 2 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
  }

  assert.equal(notified, "w.txt");
  assert.match(undo.undo() ?? "", /Restored/);
  assert.equal(await fs.readFile(abs, "utf8"), "kritya-wrote-this");
  assert.match(undo.redo() ?? "", /Restored/);
  assert.equal(await fs.readFile(abs, "utf8"), "user-hand-edited-this");

  undo.closeAll();
});

test("system prompt includes KRITYA.md project memory", async () => {
  const ws = await makeWorkspace();
  await fs.writeFile(path.join(ws, "KRITYA.md"), "Always use TypeScript.");
  const prompt = buildSystemPrompt(ws);
  assert.ok(prompt.includes("Always use TypeScript."));
  assert.ok(prompt.includes("Project instructions"));

  const wsEmpty = await makeWorkspace();
  assert.ok(!buildSystemPrompt(wsEmpty).includes("Project instructions"));
});

test("system prompt keeps a cache-stable prefix: volatile sections come last", async () => {
  const ws = await makeWorkspace();
  await fs.writeFile(path.join(ws, "KRITYA.md"), "Prefer tabs.");
  const prompt = buildSystemPrompt(ws);

  // Stable sections (rules/style), then memory, then volatile (env, listing,
  // git status, plan mode) — in that order, so a workspace change only
  // invalidates the provider's prompt cache from the volatile tail onward.
  const order = [
    "# Tool rules",
    "# Style",
    "Prefer tabs.",
    "# Environment",
    "# Workspace top-level contents",
  ];
  const positions = order.map((s) => prompt.indexOf(s));
  assert.ok(
    positions.every((p, i) => p !== -1 && (i === 0 || p > positions[i - 1])),
    `sections out of order: ${order.map((s, i) => `${s}@${positions[i]}`).join(", ")}`
  );

  // The prefix before the volatile tail must be identical across workspaces
  // with the same memory — nothing workspace- or time-dependent above it.
  const ws2 = await makeWorkspace();
  await fs.writeFile(path.join(ws2, "KRITYA.md"), "Prefer tabs.");
  await fs.writeFile(path.join(ws2, "extra-file.txt"), "changes the listing");
  const prompt2 = buildSystemPrompt(ws2);
  assert.equal(
    prompt.slice(0, prompt.indexOf("# Environment")),
    prompt2.slice(0, prompt2.indexOf("# Environment"))
  );

  // Plan mode must not disturb the stable prefix either.
  const planPrompt = buildSystemPrompt(ws, true);
  assert.equal(
    prompt.slice(0, prompt.indexOf("# Environment")),
    planPrompt.slice(0, planPrompt.indexOf("# Environment"))
  );
  assert.ok(planPrompt.includes("PLAN MODE"));
});

test("system prompt no longer honors the legacy CODECLI.md filename", async () => {
  const ws = await makeWorkspace();
  await fs.writeFile(path.join(ws, "CODECLI.md"), "Always use TypeScript.");
  const prompt = buildSystemPrompt(ws);
  assert.ok(!prompt.includes("Project instructions"));
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
