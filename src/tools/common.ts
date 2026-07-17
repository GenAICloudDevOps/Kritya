import fs from "node:fs";
import path from "node:path";

/** Resolve symlinks in `p`, walking up to the nearest existing ancestor if it doesn't exist yet. */
function realpathAllowMissing(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    const parent = path.dirname(p);
    if (parent === p) return p;
    return path.join(realpathAllowMissing(parent), path.basename(p));
  }
}

/**
 * Resolve a user/model-supplied path against the workspace root and refuse
 * anything that escapes it, including via a symlink inside the workspace
 * that points outside of it.
 */
export function resolveSafe(workspace: string, p: string): string {
  const abs = path.resolve(workspace, p);
  const rel = path.relative(workspace, abs);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`Path "${p}" is outside the workspace (${workspace})`);
  }

  const realWorkspace = realpathAllowMissing(workspace);
  const realAbs = realpathAllowMissing(abs);
  const realRel = path.relative(realWorkspace, realAbs);
  if (realRel.startsWith("..") || path.isAbsolute(realRel)) {
    throw new Error(`Path "${p}" is outside the workspace (${workspace})`);
  }

  return abs;
}

const MAX_RESULT_CHARS = 30_000;

export function truncateResult(s: string, max = MAX_RESULT_CHARS): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n... [truncated, ${s.length - max} more characters]`;
}

/** Truncate keeping the END — for command output, where errors and summaries come last. */
export function truncateTail(s: string, max = MAX_RESULT_CHARS): string {
  if (s.length <= max) return s;
  return `[... truncated, ${s.length - max} earlier characters]\n` + s.slice(-max);
}
