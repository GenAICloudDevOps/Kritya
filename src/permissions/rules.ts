import fs from "node:fs";
import path from "node:path";
import { CONFIG_DIR } from "../config/config.js";
import { warnUser } from "../config/debug.js";
import { scanForSecrets } from "../tools/secretScan.js";

/**
 * allow/deny rules from settings files. A rule is either a bare tool name
 * ("write_file") or a tool name with a pattern where * is a wildcard:
 *   shell(npm test)      — exactly `npm test`
 *   shell(git *)         — any git command
 *   write_file(.env*)    — writing any path starting with .env
 *   edit_file(*secret*)  — editing any path containing "secret"
 * For shell the pattern matches the command; for file tools it matches the
 * path argument. Matching is anchored — shell(npm test) does NOT allow
 * `npm test && rm -rf /`. deny rules win over allow rules and never prompt.
 *
 * The workspace settings file's `allow` rules only take effect once the
 * workspace has been trusted (see src/trust/trust.ts) — an untrusted
 * workspace could otherwise ship an `allow` rule that self-grants broad
 * permissions. Its `deny` rules always apply; they only remove permissions.
 */
export interface PermissionRules {
  allow: string[];
  deny: string[];
}

export function loadRules(workspace: string, trustWorkspace = true): PermissionRules {
  const allow: string[] = [];
  const deny: string[] = [];
  const files = [
    { file: path.join(CONFIG_DIR, "settings.json"), includeAllow: true },
    { file: path.join(workspace, ".kritya", "settings.json"), includeAllow: trustWorkspace },
  ];
  for (const { file, includeAllow } of files) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as {
        allow?: unknown;
        deny?: unknown;
      };
      // Settings files are exactly the kind of file that gets shared with a
      // team or committed to a repository, so a rule must never carry a
      // literal credential (e.g. an approved command with a password or a
      // token spelled out in it). Such rules are dropped, not applied, and
      // the warning names only the redacted match — never the value itself.
      const dropped: string[] = [];
      const clean = (r: unknown): r is string => {
        if (typeof r !== "string") return false;
        const matches = scanForSecrets(r);
        if (matches.length === 0) return true;
        for (const m of matches) dropped.push(`${m.kind} (${m.snippet})`);
        return false;
      };
      if (includeAllow && Array.isArray(parsed.allow)) {
        allow.push(...parsed.allow.filter(clean));
      }
      if (Array.isArray(parsed.deny)) {
        deny.push(...parsed.deny.filter(clean));
      }
      if (dropped.length > 0) {
        warnUser(
          `permission rules in ${file}`,
          new Error(
            `dropped ${dropped.length} rule(s) containing what looks like a secret ` +
              `(${dropped.join(", ")}). Settings files are often shared or committed, ` +
              `so a literal credential must never be written into a rule — reference ` +
              `the value from the environment instead (e.g. $API_KEY).`
          )
        );
      }
    } catch {
      // Missing or malformed settings file — no rules from it.
    }
  }
  return { allow, deny };
}

const RULE_RE = /^([a-z_]+)(?:\((.*)\))?$/;

/**
 * The string a pattern is matched against for a given tool.
 *
 * File-tool paths are resolved against `workspace` (when given) before
 * matching, the same way {@link resolveSafe} normalizes them: "./.env" and
 * "sub/../.env" both become ".env". Without this, a rule like
 * `write_file(.env*)` only matches the exact literal string the model
 * happened to pass, and a differently-spelled equivalent path slips past it.
 */
function subjectFor(toolName: string, args: Record<string, unknown>, workspace?: string): string {
  if (toolName === "shell") return String(args.command ?? "").trim();
  const rawPath = args.path;
  if (workspace && typeof rawPath === "string" && rawPath.trim()) {
    const rel = path.relative(workspace, path.resolve(workspace, rawPath));
    return rel.split(path.sep).join("/");
  }
  return String(rawPath ?? args.pattern ?? "").trim();
}

/**
 * Shell metacharacters that chain/substitute commands or redirect I/O
 * (&&, ||, ;, |, `, $(...), ${...}, >, >>, <, <<, a bare & to background /
 * chain, and newlines). Redirection is included because `shell(git *)` must
 * not silently allow `git log > ~/.bashrc` or `git log < /etc/passwd` just
 * because the allowed pattern never spelled those characters out.
 */
const SHELL_METACHAR_RE = /&&|\|\||[;|`&\n]|\$\(|\$\{|<|>/;

export function matchesRule(
  rule: string,
  toolName: string,
  args: Record<string, unknown>,
  workspace?: string
): boolean {
  const m = RULE_RE.exec(rule.trim());
  if (!m) return false;
  const [, ruleTool, pattern] = m;
  if (ruleTool !== toolName) return false;
  if (pattern === undefined) return true;
  const trimmedPattern = pattern.trim();
  const subject = subjectFor(toolName, args, workspace);

  // A wildcard shell(...) rule (e.g. shell(git *)) is only meant to allow one
  // command, not an arbitrary chain appended after it. If the actual command
  // contains shell metacharacters that the allowed pattern itself didn't
  // spell out, refuse the match so it falls through to a permission prompt
  // instead of silently auto-approving `git status && rm -rf /`.
  if (
    toolName === "shell" &&
    trimmedPattern.includes("*") &&
    SHELL_METACHAR_RE.test(subject) &&
    !SHELL_METACHAR_RE.test(trimmedPattern)
  ) {
    return false;
  }

  const regex = new RegExp("^" + trimmedPattern.split("*").map(escapeRegExp).join(".*") + "$");
  return regex.test(subject);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
