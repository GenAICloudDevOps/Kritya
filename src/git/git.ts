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
