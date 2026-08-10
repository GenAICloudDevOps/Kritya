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
 * Filename/path patterns that are treated as sensitive and blocked from being
 * read or written by tools, regardless of allowlist rules. This is a
 * defense-in-depth measure against prompt injection tricking the agent into
 * exfiltrating secrets — it is not a substitute for keeping real secrets out
 * of the workspace.
 */
const SENSITIVE_PATH_PATTERNS: RegExp[] = [
  /(^|[\\/])\.env(\..*)?$/i,
  // The whole .git/ directory, not just .git/config: .git/hooks/* runs
  // automatically on the next commit/checkout/push, so a write anywhere in
  // there is arbitrary code execution disguised as a file edit.
  /(^|[\\/])\.git[\\/]/i,
  /(^|[\\/])\.gitconfig$/i,
  /(^|[\\/])[^\\/]*credentials[^\\/]*$/i,
  /(^|[\\/])[^\\/]*secret[^\\/]*$/i,
  /(^|[\\/])id_rsa(\.[^\\/]*)?$/i,
  /(^|[\\/])id_ed25519(\.[^\\/]*)?$/i,
  /(^|[\\/])id_ecdsa(\.[^\\/]*)?$/i,
  /(^|[\\/])id_dsa(\.[^\\/]*)?$/i,
  /\.pem$/i,
  /\.key$/i,
  /\.ppk$/i,
  /\.jks$/i,
  /(^|[\\/])\.npmrc$/i,
  /(^|[\\/])\.netrc$/i,
  /(^|[\\/])\.pypirc$/i,
  /(^|[\\/])\.git-credentials$/i,
  /(^|[\\/])\.kube[\\/]config$/i,
  /(^|[\\/])\.docker[\\/]config\.json$/i,
  /\.p12$/i,
  /\.pfx$/i,
];

function isSensitivePath(relPath: string): boolean {
  return SENSITIVE_PATH_PATTERNS.some((re) => re.test(relPath));
}

/** Splits a shell command into path-like tokens, stripping quotes/metacharacters. */
const COMMAND_TOKEN_SPLIT_RE = /[\s|;&<>()"'`$]+/;

/**
 * Best-effort check for whether a shell command references a sensitive file
 * (.env, credentials, private keys, etc.) by name — e.g. `cat .env` or
 * `grep foo .env`. Mirrors {@link isSensitivePath}, which already gates
 * read_file/write_file, so the shell tool gets the same filename-based
 * defense instead of relying solely on post-hoc output redaction.
 *
 * This is necessarily heuristic (arbitrary shell quoting/expansion can't be
 * fully parsed without a real shell), so it only catches the literal
 * filename appearing in the command text.
 */
export function commandTouchesSensitivePath(command: string): string | null {
  const tokens = command.split(COMMAND_TOKEN_SPLIT_RE).filter(Boolean);
  for (const token of tokens) {
    if (isSensitivePath(token)) return token;
  }
  return null;
}

/**
 * Resolve a user/model-supplied path against the workspace root and refuse
 * anything that escapes it, including via a symlink inside the workspace
 * that points outside of it. Also refuses paths that look like secrets
 * (.env, credentials, private keys, etc.) — see SENSITIVE_PATH_PATTERNS.
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

  if (isSensitivePath(realRel) || isSensitivePath(rel)) {
    throw new Error(`Path "${p}" looks like a secret file and is blocked from tool access`);
  }

  return abs;
}

/**
 * Like {@link resolveSafe} but never throws — returns false for any path
 * that escapes the workspace (directly or via symlink) or looks like a
 * secret file. Used by tools (grep) that scan many candidate paths and
 * should silently skip unsafe ones rather than aborting the whole search.
 */
export function isPathSafe(workspace: string, p: string): boolean {
  try {
    resolveSafe(workspace, p);
    return true;
  } catch {
    return false;
  }
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

const MAX_REGEX_PATTERN_LENGTH = 500;
/** Nested-quantifier shapes like (a+)+, (a*)*, (a+)*, (.*)+ — classic catastrophic backtracking. */
const CATASTROPHIC_BACKTRACKING_RE = /\([^()]*[+*][^()]*\)[+*]/;

/**
 * Compile a regex supplied by the model or a settings file, rejecting
 * patterns that are excessively long or match a known catastrophic-
 * backtracking shape. This is a heuristic backstop, not a guarantee — Node
 * has no built-in regex execution timeout — but it catches the common cases
 * (e.g. a model emitting `(a+)+$` as a grep pattern) before they can hang the
 * process on adversarial input.
 */
export function safeCompileRegex(pattern: string, flags?: string): RegExp {
  if (pattern.length > MAX_REGEX_PATTERN_LENGTH) {
    throw new Error(`Pattern too long (max ${MAX_REGEX_PATTERN_LENGTH} characters)`);
  }
  if (CATASTROPHIC_BACKTRACKING_RE.test(pattern)) {
    throw new Error("Pattern rejected: nested quantifiers can cause catastrophic backtracking");
  }
  return new RegExp(pattern, flags);
}

/**
 * Lines of a tool's output that carry information — no leading banner, no
 * "(empty)" placeholder, no trailing truncation note. What's left is what a
 * result summary should count.
 */
export function meaningfulLines(output: string): string[] | null {
  const lines = output
    .split("\n")
    .filter((l) => l.trim() && !/^\((no |empty)/i.test(l.trim()) && !/^\[?\.\.\. /.test(l.trim()));
  return lines.length ? lines : null;
}

/** "10 entries", "1 line" — the shape of a result, for the tool-call line. */
export function countLines(output: string, one: string, many: string): string {
  const lines = meaningfulLines(output);
  const n = lines?.length ?? 0;
  return `${n} ${n === 1 ? one : many}`;
}
