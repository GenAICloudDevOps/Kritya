import fs from "node:fs";
import path from "node:path";
import { CONFIG_DIR } from "../config/config.js";

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
      if (includeAllow && Array.isArray(parsed.allow)) {
        allow.push(...parsed.allow.filter((r): r is string => typeof r === "string"));
      }
      if (Array.isArray(parsed.deny)) {
        deny.push(...parsed.deny.filter((r): r is string => typeof r === "string"));
      }
    } catch {
      // Missing or malformed settings file — no rules from it.
    }
  }
  return { allow, deny };
}

const RULE_RE = /^([a-z_]+)(?:\((.*)\))?$/;

/** The string a pattern is matched against for a given tool. */
function subjectFor(toolName: string, args: Record<string, unknown>): string {
  if (toolName === "shell") return String(args.command ?? "").trim();
  return String(args.path ?? args.pattern ?? "").trim();
}

/** Shell metacharacters that chain/substitute commands (&&, ||, ;, |, `, $(...)). */
const SHELL_METACHAR_RE = /&&|\|\||[;|`]|\$\(/;

export function matchesRule(
  rule: string,
  toolName: string,
  args: Record<string, unknown>
): boolean {
  const m = RULE_RE.exec(rule.trim());
  if (!m) return false;
  const [, ruleTool, pattern] = m;
  if (ruleTool !== toolName) return false;
  if (pattern === undefined) return true;
  const trimmedPattern = pattern.trim();
  const subject = subjectFor(toolName, args);

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
