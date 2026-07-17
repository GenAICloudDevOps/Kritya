import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { globTool } from "../tools/glob.js";
import { grepTool } from "../tools/grep.js";
import { writeFileTool } from "../tools/write.js";

async function makeWorkspace(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "kritya-ignore-test-"));
}

test("glob skips files matched by .krityaignore", async () => {
  const ws = await makeWorkspace();
  const ctx = { workspace: ws };
  await writeFileTool.execute({ path: "src/keep.ts", content: "keep" }, ctx);
  await writeFileTool.execute({ path: "dist/skip.ts", content: "skip" }, ctx);
  await fs.writeFile(path.join(ws, ".krityaignore"), "dist/\n");

  const out = await globTool.execute({ pattern: "**/*.ts" }, ctx);
  assert.match(out, /src[/\\]keep\.ts/);
  assert.doesNotMatch(out, /dist/);
});

test("grep skips files matched by .krityaignore", async () => {
  const ws = await makeWorkspace();
  const ctx = { workspace: ws };
  await writeFileTool.execute({ path: "src/keep.ts", content: "const secret = 1;" }, ctx);
  await writeFileTool.execute({ path: "vendor/lib.ts", content: "const secret = 2;" }, ctx);
  await fs.writeFile(path.join(ws, ".krityaignore"), "vendor/\n");

  const out = await grepTool.execute({ pattern: "secret" }, ctx);
  assert.match(out, /src[/\\]keep\.ts/);
  assert.doesNotMatch(out, /vendor/);
});

test("glob and grep work as before when .krityaignore is absent", async () => {
  const ws = await makeWorkspace();
  const ctx = { workspace: ws };
  await writeFileTool.execute({ path: "a.ts", content: "x" }, ctx);
  const out = await globTool.execute({ pattern: "**/*.ts" }, ctx);
  assert.match(out, /a\.ts/);
});
