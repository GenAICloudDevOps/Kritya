import fs from "node:fs";
import path from "node:path";
import { CONFIG_DIR } from "../config/config.js";

/**
 * Allowlist rules from settings files. A rule is either a bare tool name
 * ("write_file") or, for shell, a command pattern where * is a wildcard:
 * "shell(npm test)" allows exactly `npm test`; "shell(git *)" allows any git
 * command. Matching is anchored — "shell(npm test)" does NOT allow
 * `npm test && rm -rf /`.
 */
export function loadAllowRules(workspace: string): string[] {
  const rules: string[] = [];
  for (const file of [
    path.join(CONFIG_DIR, "settings.json"),
    path.join(workspace, ".kritya", "settings.json"),
  ]) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { allow?: unknown };
      if (Array.isArray(parsed.allow)) {
        rules.push(...parsed.allow.filter((r): r is string => typeof r === "string"));
      }
    } catch {
      // Missing or malformed settings file — no rules from it.
    }
  }
  return rules;
}

const RULE_RE = /^([a-z_]+)(?:\((.*)\))?$/;

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
  if (toolName !== "shell") return false; // patterns only make sense for shell
  const command = String(args.command ?? "").trim();
  const regex = new RegExp(
    "^" + pattern.trim().split("*").map(escapeRegExp).join(".*") + "$"
  );
  return regex.test(command);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
