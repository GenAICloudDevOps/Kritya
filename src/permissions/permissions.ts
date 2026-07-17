import type { PermissionDecision, ToolDef } from "../types.js";

/**
 * Session-scoped permission policy. Read-only tools never prompt; mutating
 * tools prompt unless the user chose "always allow" for that tool earlier
 * in the session.
 */
export class PermissionManager {
  private alwaysAllowed = new Set<string>();

  needsPrompt(tool: ToolDef): boolean {
    return tool.requiresPermission && !this.alwaysAllowed.has(tool.name);
  }

  record(toolName: string, decision: PermissionDecision): void {
    if (decision === "always") this.alwaysAllowed.add(toolName);
  }
}
