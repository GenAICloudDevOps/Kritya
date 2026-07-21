import type { PermissionDecision, ToolDef } from "../types.js";
import { matchesRule, type PermissionRules } from "./rules.js";

/**
 * Permission policy. Read-only tools never prompt; mutating tools prompt
 * unless allowed by a settings-file rule or the user chose "always allow"
 * for that tool earlier in the session. A deny rule blocks the call outright
 * and cannot be overridden by an allow rule or an "always" choice.
 */
/**
 * Key under which an "always allow" decision is recorded for a tool call.
 * For `shell`, this is scoped to the command's first word (e.g. "git") so
 * that approving one command doesn't silently pre-approve every future shell
 * command for the rest of the session — only future commands starting with
 * the same program name.
 */
function alwaysAllowKey(toolName: string, args: Record<string, unknown>): string {
  if (toolName !== "shell") return toolName;
  const firstWord = String(args.command ?? "")
    .trim()
    .split(/\s+/)[0];
  return firstWord ? `shell:${firstWord}` : "shell";
}

export class PermissionManager {
  private alwaysAllowed = new Set<string>();
  private allow: string[];
  private deny: string[];

  constructor(rules: string[] | PermissionRules = []) {
    if (Array.isArray(rules)) {
      this.allow = rules;
      this.deny = [];
    } else {
      this.allow = rules.allow;
      this.deny = rules.deny;
    }
  }

  /** True if a deny rule blocks this call; such calls are never prompted, always refused. */
  isDenied(tool: ToolDef, args: Record<string, unknown> = {}): boolean {
    return this.deny.some((rule) => matchesRule(rule, tool.name, args));
  }

  needsPrompt(tool: ToolDef, args: Record<string, unknown> = {}): boolean {
    if (!tool.requiresPermission) return false;
    if (this.alwaysAllowed.has(alwaysAllowKey(tool.name, args))) return false;
    return !this.allow.some((rule) => matchesRule(rule, tool.name, args));
  }

  record(toolName: string, decision: PermissionDecision, args: Record<string, unknown> = {}): void {
    if (decision === "always") this.alwaysAllowed.add(alwaysAllowKey(toolName, args));
  }

  /**
   * True if this call is pre-approved by an earlier "always allow" choice this
   * session (as opposed to a settings allow rule). Lets the audit log record
   * the precise source of an allowed decision.
   */
  isAlwaysAllowed(toolName: string, args: Record<string, unknown> = {}): boolean {
    return this.alwaysAllowed.has(alwaysAllowKey(toolName, args));
  }
}
