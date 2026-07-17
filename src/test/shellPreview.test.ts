import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { shellTool } from "../tools/shell.js";

async function makeGitRepo(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "kritya-shell-preview-"));
  const run = (args: string[]) => execFileSync("git", args, { cwd: dir });
  run(["init", "-q"]);
  run(["config", "user.email", "test@example.com"]);
  run(["config", "user.name", "Test"]);
  run(["config", "commit.gpgsign", "false"]);
  await fs.writeFile(path.join(dir, "file.txt"), "original\n");
  run(["add", "."]);
  run(["commit", "-q", "-m", "initial"]);
  return dir;
}

test("shell preview shows a git diff --stat for git-mutating commands", async () => {
  const ws = await makeGitRepo();
  await fs.writeFile(path.join(ws, "file.txt"), "changed\n");

  const preview = await shellTool.preview!(
    { command: "git checkout -- file.txt" },
    { workspace: ws }
  );
  assert.ok(preview);
  assert.match(preview!, /file\.txt/);
  assert.match(preview!, /1 file changed/);
});

test("shell preview is absent for ordinary, non-git-mutating commands", async () => {
  const ws = await makeGitRepo();
  const preview = await shellTool.preview!({ command: "ls -la" }, { workspace: ws });
  assert.equal(preview, null);
});

test("shell preview is absent for a clean git-mutating command with no local changes", async () => {
  const ws = await makeGitRepo();
  const preview = await shellTool.preview!({ command: "git pull" }, { workspace: ws });
  assert.ok(!preview);
});
