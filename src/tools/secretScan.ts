/**
 * Content-based secret scanning, independent of the filename checks in
 * common.ts (isSensitivePath). Filenames only catch secrets kept in files
 * that *look* sensitive (.env, *secret*, etc.) — they do nothing to stop the
 * model from writing a real API key it saw in some tool output (a log, an
 * error message, a fetched page) into an ordinary file like README.md or
 * config.ts. This scans content being written/edited for known secret
 * formats and high-entropy assignments, and blocks the write.
 *
 * This is a heuristic defense-in-depth measure, not a guarantee: it can miss
 * novel key formats and can false-positive on random-looking test fixtures.
 * Callers should surface the specific match kind so a false positive is easy
 * to diagnose and override deliberately (e.g. by restructuring the string).
 */

export interface SecretMatch {
  kind: string;
  /** Short, redacted excerpt for the error message — never the full secret. */
  snippet: string;
}

interface NamedPattern {
  kind: string;
  re: RegExp;
}

// Well-known key/token formats with distinctive prefixes or structure —
// these have a very low false-positive rate.
const NAMED_PATTERNS: NamedPattern[] = [
  { kind: "AWS Access Key ID", re: /\bAKIA[0-9A-Z]{16}\b/g },
  { kind: "AWS Secret Access Key", re: /\baws(.{0,20})?['"]\s*[:=]\s*['"][0-9a-zA-Z/+]{40}['"]/gi },
  { kind: "GitHub token", re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g },
  { kind: "GitLab token", re: /\bglpat-[A-Za-z0-9\-_]{20,}\b/g },
  { kind: "Slack token", re: /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/g },
  { kind: "Slack webhook URL", re: /\bhooks\.slack\.com\/services\/[A-Za-z0-9/]{20,}\b/g },
  { kind: "Google API key", re: /\bAIza[0-9A-Za-z\-_]{35}\b/g },
  { kind: "Stripe key", re: /\b(sk|rk)_(live|test)_[0-9a-zA-Z]{20,}\b/g },
  { kind: "Anthropic API key", re: /\bsk-ant-[A-Za-z0-9\-_]{20,}\b/g },
  {
    kind: "OpenAI API key",
    re: /\bsk-[A-Za-z0-9]{20,}T3BlbkFJ[A-Za-z0-9]{20,}\b|\bsk-proj-[A-Za-z0-9\-_]{20,}\b/g,
  },
  {
    kind: "JSON Web Token",
    re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  },
  {
    kind: "Private key block",
    re: /-----BEGIN (RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/g,
  },
  { kind: "npm access token", re: /\bnpm_[A-Za-z0-9]{36}\b/g },
  { kind: "PyPI upload token", re: /\bpypi-AgEIcHlwaS5vcmc[A-Za-z0-9_-]{50,}\b/g },
  { kind: "Azure Storage Account key", re: /\b[A-Za-z0-9+/]{86}==(?![A-Za-z0-9+/=])/g },
  {
    kind: "GCP service account key",
    re: /\b[a-z0-9-]+@[a-z0-9-]+\.iam\.gserviceaccount\.com\b/gi,
  },
];

// Generic "KEY = <opaque token>" assignments, gated by an entropy check so
// ordinary identifiers/URLs/sentences don't trip it.
// No leading `\b`: env vars are routinely prefixed (OPENAI_API_KEY,
// STRIPE_SECRET_KEY, DB_PASSWORD) and `_` is a word character, so a boundary
// requirement before the key phrase would silently skip almost every real
// `.env` entry. A trailing `\b` still stops the phrase mid-identifier.
const ASSIGNMENT_RE =
  /(api[_-]?key|apikey|secret|token|access[_-]?key|private[_-]?key|passwd|password|pwd|auth)\w*\s*[:=]\s*["'`]?([A-Za-z0-9/+_.-]{16,})["'`]?/gi;

function shannonEntropy(s: string): number {
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / s.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

/** Placeholder-looking values (env var refs, obvious examples) that shouldn't be flagged. */
function looksLikePlaceholder(value: string): boolean {
  if (
    /^(x+|\*+|0+|1+|<[^>]+>|\{\{.*\}\}|\$\{?[A-Z0-9_]+\}?|your[_-]|example|changeme|placeholder|dummy|fake|test)/i.test(
      value
    )
  ) {
    return true;
  }
  // Low variety of distinct characters (e.g. "aaaaaaaaaaaaaaaaaaaa") is not a real secret.
  return new Set(value).size < 6;
}

const MIN_ENTROPY = 3.5;
const MAX_SNIPPET = 12;

function redact(value: string): string {
  if (value.length <= MAX_SNIPPET) return value.slice(0, 4) + "…";
  return value.slice(0, 4) + "…" + value.slice(-4);
}

/**
 * Scan `content` for strings that look like real secrets. Returns an empty
 * array if none are found.
 */
export function scanForSecrets(content: string): SecretMatch[] {
  const matches: SecretMatch[] = [];
  const seen = new Set<string>();

  for (const { kind, re } of NAMED_PATTERNS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content))) {
      const value = m[0];
      const key = `${kind}:${value}`;
      if (!seen.has(key)) {
        seen.add(key);
        matches.push({ kind, snippet: redact(value) });
      }
      if (!re.global) break;
    }
  }

  ASSIGNMENT_RE.lastIndex = 0;
  let am: RegExpExecArray | null;
  while ((am = ASSIGNMENT_RE.exec(content))) {
    const value = am[2];
    if (looksLikePlaceholder(value)) continue;
    if (shannonEntropy(value) < MIN_ENTROPY) continue;
    const key = `assignment:${value}`;
    if (!seen.has(key)) {
      seen.add(key);
      matches.push({ kind: `high-entropy ${am[1].toLowerCase()} value`, snippet: redact(value) });
    }
  }

  return matches;
}

/**
 * Scans `content` the same way `scanForSecrets` does, but instead of
 * blocking, replaces each matched secret with a `[REDACTED: <kind>]`
 * placeholder. Used for shell output, which — unlike a file write — has
 * already happened by the time we see it; redacting the display is the
 * only lever left, so masking rather than throwing is the right shape here.
 */
export function redactSecrets(content: string): { redacted: string; matches: SecretMatch[] } {
  const matches = scanForSecrets(content);
  if (matches.length === 0) return { redacted: content, matches };

  let redacted = content;
  for (const { kind, re } of NAMED_PATTERNS) {
    redacted = redacted.replace(re, () => `[REDACTED: ${kind}]`);
  }
  redacted = redacted.replace(ASSIGNMENT_RE, (full, _label, value) => {
    if (looksLikePlaceholder(value) || shannonEntropy(value) < MIN_ENTROPY) return full;
    // `full` is `key<sep><quote?>value<quote?>` — replace just the value
    // substring so the key (useful context) stays visible. `value` is at
    // least 16 chars, so a spurious earlier occurrence inside the key/label
    // portion of `full` is not a realistic concern.
    return full.replace(value, "[REDACTED]");
  });

  return { redacted, matches };
}

export function formatSecretWarning(matches: SecretMatch[], path: string): string {
  const lines = matches.map((m) => `  - ${m.kind}: ${m.snippet}`);
  return (
    `Blocked write to ${path}: content looks like it contains real secret(s):\n` +
    lines.join("\n") +
    `\n\nIf this is genuinely not a secret (e.g. a test fixture), rewrite it so it doesn't ` +
    `match common key formats or lower its entropy — for example, using an obvious placeholder ` +
    `like "sk-ant-EXAMPLE...".`
  );
}
