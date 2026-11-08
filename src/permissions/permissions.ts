import type { PermissionDecision, ToolDef } from "../types.js";
import { scanForSecrets } from "../tools/secretScan.js";
import { matchesRule, type PermissionRules } from "./rules.js";

/**
 * Permission policy. Read-only tools never prompt; mutating tools prompt
 * unless allowed by a settings-file rule or the user chose "always allow"
 * for that tool earlier in the session. A deny rule blocks the call outright
 * and cannot be overridden by an allow rule or an "always" choice.
 */
/**
 * Key under which an "always allow" decision is recorded for a tool call.
 * For `shell`, this is scoped to the *exact* command string, so approving
 * one invocation (e.g. `python train.py`) only pre-approves that same
 * invocation again — not every future command starting with the same
 * program (`python -c "..."`, `python other_script.py`). Interpreters and
 * other general-purpose runners make a first-word-only key unsafe: the
 * first word tells you almost nothing about what the full command does.
 * Users who want broader pre-approval on purpose can still write a wildcard
 * rule (e.g. `shell(git *)`) into settings.json — see rules.ts.
 */
function alwaysAllowKey(toolName: string, args: Record<string, unknown>): string {
  if (toolName !== "shell") return toolName;
  const command = String(args.command ?? "").trim();
  return command ? `shell:${command}` : "shell";
}

/**
 * Whether any string argument of a call carries a secret-shaped value (for
 * shell, the command string itself; for file tools, a path or a content
 * payload). Used to keep such calls out of the "always allow" table: the
 * recorded key for shell *is* the verbatim command, so remembering an
 * approval for a command that embeds a literal credential would keep that
 * credential in the approval table and silently re-run it for the rest of
 * the session. A secret-bearing call can still be approved — once.
 */
export function argsContainSecret(args: Record<string, unknown>): boolean {
  for (const value of Object.values(args)) {
    if (typeof value === "string" && scanForSecrets(value).length > 0) return true;
  }
  return false;
}

export class PermissionManager {
  private alwaysAllowed = new Set<string>();
  private allow: string[];
  private deny: string[];
  private workspace?: string;

  constructor(rules: string[] | PermissionRules = [], workspace?: string) {
    if (Array.isArray(rules)) {
      this.allow = rules;
      this.deny = [];
    } else {
      this.allow = rules.allow;
      this.deny = rules.deny;
    }
    this.workspace = workspace;
  }

  /** True if a deny rule blocks this call; such calls are never prompted, always refused. */
  isDenied(tool: ToolDef, args: Record<string, unknown> = {}): boolean {
    return this.deny.some((rule) => matchesRule(rule, tool.name, args, this.workspace));
  }

  needsPrompt(tool: ToolDef, args: Record<string, unknown> = {}): boolean {
    if (!tool.requiresPermission) return false;
    if (this.alwaysAllowed.has(alwaysAllowKey(tool.name, args))) return false;
    return !this.allow.some((rule) => matchesRule(rule, tool.name, args, this.workspace));
  }

  record(toolName: string, decision: PermissionDecision, args: Record<string, unknown> = {}): void {
    if (decision !== "always") return;
    // Never record an "always" decision for a call whose arguments carry a
    // secret-shaped value — see argsContainSecret. The approval stands for
    // this one call; the next identical call prompts again.
    if (argsContainSecret(args)) return;
    this.alwaysAllowed.add(alwaysAllowKey(toolName, args));
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
