import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { debugLog } from "../config/debug.js";

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
  } catch (err) {
    debugLog(`createWorktree mkdir(${root})`, err);
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
 *
 * Signs with `-c commit.gpgsign=false`: this is an internal bookkeeping
 * commit on a scratch branch, not something attributed to the user — it
 * exists only so the subagent's diff survives worktree teardown, and the
 * user re-commits (with their own signing) when they actually merge it. A
 * user with `commit.gpgsign=true` set globally but not overridden in this
 * repo would otherwise hit an interactive GPG passphrase prompt with no
 * terminal to answer it on, silently losing every write subagent's work.
 */
export function commitWorktree(wt: Worktree, message: string): "clean" | "committed" | "failed" {
  const status = git(wt.dir, ["status", "--porcelain"]);
  if (status.ok && !status.out.trim()) return "clean";
  git(wt.dir, ["add", "-A"]);
  const commit = git(wt.dir, ["-c", "commit.gpgsign=false", "commit", "-m", message]);
  return commit.ok ? "committed" : "failed";
}

/** Diffstat of the subagent's branch against the branch it was forked from. */
export function worktreeDiffStat(workspace: string, wt: Worktree): string {
  const res = git(workspace, ["diff", `${wt.baseBranch}...${wt.branch}`, "--stat"]);
  return res.ok ? res.out.trim() : "";
}

/** Synchronous sleep — used only for a short retry backoff on a flaky `git branch -D`. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Tears down a worktree checkout. `deleteBranch` should be true only when the
 * branch made no changes worth keeping — otherwise leave the branch in place
 * so the user can review/merge it later (`git diff <base>...<branch>`,
 * `git merge <branch>`).
 *
 * Returns false if `deleteBranch` was requested but the branch still exists
 * afterward (e.g. a transient lock on the ref, more common on network/9p
 * filesystems) — callers should surface this rather than silently leaving an
 * empty orphaned branch with no indication anything went wrong.
 */
export function removeWorktree(workspace: string, wt: Worktree, deleteBranch: boolean): boolean {
  git(workspace, ["worktree", "remove", "--force", wt.dir]);
  try {
    fs.rmSync(wt.dir, { recursive: true, force: true });
  } catch {
    // best-effort cleanup; a leftover temp dir is harmless
  }
  if (!deleteBranch) return true;

  git(workspace, ["branch", "-D", wt.branch]);
  if (!git(workspace, ["rev-parse", "--verify", wt.branch]).ok) return true;

  // First attempt raced with worktree teardown finishing (ref still locked) —
  // one short retry clears it in practice; if not, report it rather than
  // leave a silently-orphaned empty branch.
  sleepSync(150);
  git(workspace, ["branch", "-D", wt.branch]);
  return !git(workspace, ["rev-parse", "--verify", wt.branch]).ok;
}
