import type { PermissionDecision, ToolDef } from "../types.js";
import { matchesRule, type PermissionRules } from "./rules.js";

/**
 * Permission policy. Read-only tools never prompt; mutating tools prompt
 * unless allowed by a settings-file rule or the user chose "always allow"
 * for that tool earlier in the session. A deny rule blocks the call outright
 * and cannot be overridden by an allow rule or an "always" choice.
 */
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
    if (this.alwaysAllowed.has(tool.name)) return false;
    return !this.allow.some((rule) => matchesRule(rule, tool.name, args));
  }

  record(toolName: string, decision: PermissionDecision): void {
    if (decision === "always") this.alwaysAllowed.add(toolName);
  }
}
