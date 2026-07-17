import path from "node:path";

/**
 * Resolve a user/model-supplied path against the workspace root and refuse
 * anything that escapes it.
 */
export function resolveSafe(workspace: string, p: string): string {
  const abs = path.resolve(workspace, p);
  const rel = path.relative(workspace, abs);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
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
