import type { PermissionDecision, ToolDef } from "../types.js";
import { matchesRule } from "./rules.js";

/**
 * Permission policy. Read-only tools never prompt; mutating tools prompt
 * unless allowed by a settings-file rule or the user chose "always allow"
 * for that tool earlier in the session.
 */
export class PermissionManager {
  private alwaysAllowed = new Set<string>();

  constructor(private rules: string[] = []) {}

  needsPrompt(tool: ToolDef, args: Record<string, unknown> = {}): boolean {
    if (!tool.requiresPermission) return false;
    if (this.alwaysAllowed.has(tool.name)) return false;
    return !this.rules.some((rule) => matchesRule(rule, tool.name, args));
  }

  record(toolName: string, decision: PermissionDecision): void {
    if (decision === "always") this.alwaysAllowed.add(toolName);
  }
}
