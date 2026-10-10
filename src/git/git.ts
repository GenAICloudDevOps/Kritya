import { execFileSync } from "node:child_process";

function git(cwd: string, args: string[]): string | null {
  try {
    return execFileSync("git", args, {
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 3000,
    })
      .toString()
      .trimEnd();
  } catch {
    return null; // not a repo, or git missing
  }
}

export function gitBranch(cwd: string): string | null {
  const out = git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  return out || null;
}

/** Remote URL of `origin`, or null when there is none. */
export function gitRemoteUrl(cwd: string): string | null {
  const out = git(cwd, ["remote", "get-url", "origin"]);
  return out || null;
}

/**
 * The repo's default branch, from the origin/HEAD symref. Falls back to
 * "main" when the symref is missing (a repo cloned without --no-remote-head
 * oddities, or a remote the local clone has never fetched).
 */
export function gitDefaultBranch(cwd: string): string {
  const out = git(cwd, ["symbolic-ref", "refs/remotes/origin/HEAD"]);
  const m = out && /^refs\/remotes\/origin\/(.+)$/.exec(out);
  return m ? m[1] : "main";
}

/** Whether `branch` has an upstream configured. */
export function gitHasUpstream(cwd: string, branch: string): boolean {
  return git(cwd, ["rev-parse", "--verify", `refs/remotes/${branch}@{upstream}`]) !== null;
}

/** Whether `ref` (branch, tag, …) exists locally. */
export function gitRefExists(cwd: string, ref: string): boolean {
  return git(cwd, ["rev-parse", "--verify", ref]) !== null;
}

/** Commits on the current branch not yet on its upstream. 0 when there is no upstream. */
export function gitUnpushedCount(cwd: string): number {
  const out = git(cwd, ["rev-list", "--count", "@{u}..HEAD"]);
  const n = out === null ? NaN : parseInt(out, 10);
  return Number.isFinite(n) ? n : 0;
}

/** One commit's subject and body, for building a PR title and description. */
export interface GitCommit {
  subject: string;
  body: string;
}

/**
 * Commits on HEAD that `base` does not have, oldest first. Empty when the
 * branch is up to date with base (or on any git failure).
 */
export function gitCommitsAhead(cwd: string, base: string): GitCommit[] {
  // \x1e separates records, \x1f separates subject from body — both are
  // control characters that cannot appear in a commit message as written by
  // any sane tooling, and far less likely than newlines.
  const out = git(cwd, ["log", "--reverse", "--format=%s%x1f%b%x1e", `${base}..HEAD`]);
  if (!out) return [];
  return out
    .split("\x1e")
    .filter((rec) => rec.trim().length > 0)
    .map((rec) => {
      const [subject = "", body = ""] = rec.split("\x1f");
      return { subject: subject.trim(), body: body.trim() };
    });
}

/**
 * Push the branch, setting the upstream when it has none. Returns an error
 * message rather than throwing — the caller is a slash command reporting
 * back to the user. The push runs under the user's own git credentials,
 * exactly as if they had typed it themselves.
 */
export function gitPush(cwd: string, branch: string, setUpstream: boolean): string | null {
  const args = setUpstream ? ["push", "-u", "origin", branch] : ["push", "origin", branch];
  try {
    execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"], timeout: 60000 });
    return null;
  } catch (err) {
    const stderr = (err as { stderr?: Buffer })?.stderr?.toString().trim();
    // Git's own error already says what went wrong (auth, rejected, no
    // network); keep the first few lines so the user sees that, not a
    // stack trace.
    const detail = stderr ? stderr.split("\n").slice(0, 4).join("\n") : (err as Error).message;
    return `git push failed:\n${detail}`;
  }
}

/** Branch + working-tree status, capped at 30 lines; null outside a repo. */
export function gitStatusShort(cwd: string): string | null {
  const out = git(cwd, ["status", "--porcelain", "-b"]);
  if (out === null) return null;
  const lines = out.split("\n");
  return lines.length > 30
    ? [...lines.slice(0, 30), `… (${lines.length - 30} more changed files)`].join("\n")
    : out;
}

/**
 * A summary of uncommitted changes: the diffstat plus a capped unified diff of
 * both staged and unstaged work. Null outside a repo; empty string if clean.
 */
export function gitDiffStat(cwd: string, maxLines = 200): string | null {
  const stat = git(cwd, ["diff", "HEAD", "--stat"]);
  if (stat === null) return null;
  if (!stat.trim()) return "";
  const diff = git(cwd, ["diff", "HEAD"]) ?? "";
  const lines = diff.split("\n");
  const capped =
    lines.length > maxLines
      ? [...lines.slice(0, maxLines), `… (${lines.length - maxLines} more diff lines)`].join("\n")
      : diff;
  return `${stat}\n\n${capped}`;
}
