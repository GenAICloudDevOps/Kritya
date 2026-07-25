import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  commitWorktree,
  createWorktree,
  isGitRepo,
  removeWorktree,
  worktreeDiffStat,
} from "../agent/worktree.js";

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

function freshRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kritya-worktree-test-"));
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "user.name", "Test"]);
  fs.writeFileSync(path.join(dir, "README.md"), "hello\n");
  git(dir, ["add", "-A"]);
  git(dir, ["-c", "commit.gpgsign=false", "commit", "-q", "-m", "initial"]);
  return dir;
}

test("isGitRepo is true inside a git working tree and false outside one", () => {
  const repo = freshRepo();
  assert.equal(isGitRepo(repo), true);

  const notARepo = fs.mkdtempSync(path.join(os.tmpdir(), "kritya-not-a-repo-"));
  assert.equal(isGitRepo(notARepo), false);
});

test("createWorktree checks out a fresh branch off HEAD in an isolated directory", () => {
  const repo = freshRepo();
  const wt = createWorktree(repo);
  assert.ok(wt, "worktree creation succeeds inside a git repo");
  assert.ok(
    fs.existsSync(path.join(wt!.dir, "README.md")),
    "the new worktree has the repo's files"
  );
  assert.equal(wt!.baseBranch, "main");
  assert.match(wt!.branch, /^kritya\/agent-/);
  removeWorktree(repo, wt!, true);
});

test("createWorktree returns null when the workspace isn't a git repo", () => {
  const notARepo = fs.mkdtempSync(path.join(os.tmpdir(), "kritya-not-a-repo-"));
  assert.equal(createWorktree(notARepo), null);
});

test("commitWorktree reports 'clean' when the subagent changed nothing", () => {
  const repo = freshRepo();
  const wt = createWorktree(repo)!;
  assert.equal(commitWorktree(wt, "no-op"), "clean");
  removeWorktree(repo, wt, true);
});

test("commitWorktree commits new changes and worktreeDiffStat reflects them", () => {
  const repo = freshRepo();
  const wt = createWorktree(repo)!;
  fs.writeFileSync(path.join(wt.dir, "new-file.txt"), "subagent work\n");
  assert.equal(commitWorktree(wt, "subagent change"), "committed");

  const stat = worktreeDiffStat(repo, wt);
  assert.match(stat, /new-file\.txt/);
  removeWorktree(repo, wt, false);
});

test("removeWorktree with deleteBranch=true removes the checkout and the branch", () => {
  const repo = freshRepo();
  const wt = createWorktree(repo)!;
  const ok = removeWorktree(repo, wt, true);
  assert.equal(ok, true);
  assert.equal(fs.existsSync(wt.dir), false);
  assert.throws(() => execFileSync("git", ["rev-parse", "--verify", wt.branch], { cwd: repo }));
});

test("removeWorktree with deleteBranch=false leaves the branch behind for review", () => {
  const repo = freshRepo();
  const wt = createWorktree(repo)!;
  const ok = removeWorktree(repo, wt, false);
  assert.equal(ok, true);
  assert.equal(fs.existsSync(wt.dir), false);
  // Branch survives: rev-parse succeeds instead of throwing.
  execFileSync("git", ["rev-parse", "--verify", wt.branch], { cwd: repo });
});
