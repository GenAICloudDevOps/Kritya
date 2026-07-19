import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface Worktree {
  /** Absolute path of the isolated checkout a write subagent operates in. */
  dir: string;
  /** Branch the worktree is checked out to; holds the subagent's commits. */
  branch: string;
  /** Branch the worktree was created from, for diffing and reporting. */
  baseBranch: string;
}

interface GitResult {
  ok: boolean;
  out: string;
}

function git(cwd: string, args: string[], timeout = 15_000): GitResult {
  try {
    const out = execFileSync("git", args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      timeout,
    }).toString();
    return { ok: true, out };
  } catch (err) {
    const stderr =
      err && typeof err === "object" && "stderr" in err
        ? String((err as { stderr: unknown }).stderr)
        : "";
    const message = stderr.trim() || (err instanceof Error ? err.message : String(err));
    return { ok: false, out: message };
  }
}

/** Whether `workspace` is inside a git working tree (required for isolated write subagents). */
export function isGitRepo(workspace: string): boolean {
  return git(workspace, ["rev-parse", "--is-inside-work-tree"]).ok;
}

/**
 * Creates a fresh branch + worktree off the current HEAD so a write subagent
 * can edit and run commands without ever touching the user's real working
 * tree. Returns null if worktree creation failed (e.g. dirty index conflict,
 * git missing, or an existing branch name collision — vanishingly unlikely
 * given the random suffix, but handled defensively).
 */
export function createWorktree(workspace: string): Worktree | null {
  const headRes = git(workspace, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const baseBranch = headRes.ok ? headRes.out.trim() : "HEAD";
  const id = `${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`;
  const branch = `kritya/agent-${id}`;
  const root = path.join(os.tmpdir(), "kritya-worktrees");
  const dir = path.join(root, id);

  try {
    fs.mkdirSync(root, { recursive: true });
  } catch {
    return null;
  }

  const add = git(workspace, ["worktree", "add", "-b", branch, dir, "HEAD"]);
  if (!add.ok) return null;
  return { dir, branch, baseBranch };
}

/**
 * Stages and commits whatever the subagent changed inside its worktree, so
 * the diff survives after the worktree checkout is removed (it lives on in
 * the branch's history). Returns "clean" if there was nothing to commit,
 * "committed" on success, or "failed" (e.g. a pre-commit hook rejected it) —
 * callers must not discard the worktree on "failed" so the work isn't lost.
 */
export function commitWorktree(wt: Worktree, message: string): "clean" | "committed" | "failed" {
  const status = git(wt.dir, ["status", "--porcelain"]);
  if (status.ok && !status.out.trim()) return "clean";
  git(wt.dir, ["add", "-A"]);
  const commit = git(wt.dir, ["commit", "-m", message]);
  return commit.ok ? "committed" : "failed";
}

/** Diffstat of the subagent's branch against the branch it was forked from. */
export function worktreeDiffStat(workspace: string, wt: Worktree): string {
  const res = git(workspace, ["diff", `${wt.baseBranch}...${wt.branch}`, "--stat"]);
  return res.ok ? res.out.trim() : "";
}

/**
 * Tears down a worktree checkout. `deleteBranch` should be true only when the
 * branch made no changes worth keeping — otherwise leave the branch in place
 * so the user can review/merge it later (`git diff <base>...<branch>`,
 * `git merge <branch>`).
 */
export function removeWorktree(workspace: string, wt: Worktree, deleteBranch: boolean): void {
  git(workspace, ["worktree", "remove", "--force", wt.dir]);
  try {
    fs.rmSync(wt.dir, { recursive: true, force: true });
  } catch {
    // best-effort cleanup; a leftover temp dir is harmless
  }
  if (deleteBranch) git(workspace, ["branch", "-D", wt.branch]);
}
