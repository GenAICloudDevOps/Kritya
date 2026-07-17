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
