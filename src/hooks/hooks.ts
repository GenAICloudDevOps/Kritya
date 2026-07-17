import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { CONFIG_DIR } from "../config/config.js";
import { safeCompileRegex } from "../tools/common.js";

/**
 * User-configured shell hooks, from the `hooks` key of settings.json (workspace
 * or global). They let users automate actions around the agent's work — e.g.
 * format after every edit, or block edits to protected paths.
 *
 *   "hooks": {
 *     "preToolUse":  [{ "match": "write_file|edit_file", "command": "...", "blocking": true }],
 *     "postToolUse": [{ "match": "edit_file", "command": "prettier --write \"$KRITYA_TOOL_PATH\"" }],
 *     "stop":        [{ "command": "npm run lint" }]
 *   }
 *
 * preToolUse hooks run after permission is granted, before the tool executes;
 * a non-zero exit from a `blocking` hook cancels the call and feeds the hook's
 * output back to the model. postToolUse hooks run after a successful call.
 * stop hooks run when a turn ends. Commands receive KRITYA_TOOL_NAME,
 * KRITYA_TOOL_PATH, KRITYA_TOOL_COMMAND, and KRITYA_TOOL_ARGS (JSON) in the env.
 *
 * Workspace-level hooks only load once the workspace has been trusted (see
 * src/trust/trust.ts), since a hook runs arbitrary shell commands
 * automatically. Global (~/.kritya/settings.json) hooks are always trusted.
 */
export interface HookDef {
  /** Regex tested against the tool name; omit to match every tool. */
  match?: string;
  command: string;
  /** Only meaningful for preToolUse: a non-zero exit cancels the tool call. */
  blocking?: boolean;
}

export type HookEvent = "preToolUse" | "postToolUse" | "stop";

export type HooksConfig = Partial<Record<HookEvent, HookDef[]>>;

export interface HookResult {
  blocked: boolean;
  output: string;
}

const HOOK_TIMEOUT_MS = 30_000;

export function loadHooks(workspace: string, trustWorkspace = true): HooksConfig {
  const merged: HooksConfig = {};
  const files = [path.join(CONFIG_DIR, "settings.json")];
  if (trustWorkspace) files.push(path.join(workspace, ".kritya", "settings.json"));
  for (const file of files) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { hooks?: HooksConfig };
      if (!parsed.hooks) continue;
      for (const event of ["preToolUse", "postToolUse", "stop"] as HookEvent[]) {
        const defs = parsed.hooks[event];
        if (Array.isArray(defs)) merged[event] = [...(merged[event] ?? []), ...defs];
      }
    } catch {
      // No hooks from a missing/malformed file.
    }
  }
  return merged;
}

export class HookRunner {
  constructor(
    private hooks: HooksConfig,
    private workspace: string
  ) {}

  has(event: HookEvent): boolean {
    return (this.hooks[event]?.length ?? 0) > 0;
  }

  /** Run tool-related hooks. For preToolUse, `blocked` is true if a blocking hook failed. */
  runToolHooks(
    event: "preToolUse" | "postToolUse",
    toolName: string,
    args: Record<string, unknown>
  ): HookResult {
    const defs = this.hooks[event] ?? [];
    const env = {
      ...process.env,
      KRITYA_TOOL_NAME: toolName,
      KRITYA_TOOL_PATH: String(args.path ?? ""),
      KRITYA_TOOL_COMMAND: String(args.command ?? ""),
      KRITYA_TOOL_ARGS: safeJson(args),
    };
    const outputs: string[] = [];
    for (const def of defs) {
      if (def.match) {
        let matches: boolean;
        try {
          matches = safeCompileRegex(def.match).test(toolName);
        } catch {
          continue; // malformed or unsafe pattern in settings.json — skip this hook
        }
        if (!matches) continue;
      }
      try {
        const out = execSync(def.command, {
          cwd: this.workspace,
          env,
          timeout: HOOK_TIMEOUT_MS,
          stdio: ["ignore", "pipe", "pipe"],
          encoding: "utf8",
        });
        if (out.trim()) outputs.push(out.trim());
      } catch (err) {
        const e = err as { stdout?: string; stderr?: string; message?: string };
        const detail = (e.stderr || e.stdout || e.message || "hook failed").toString().trim();
        outputs.push(detail);
        if (event === "preToolUse" && def.blocking) {
          return {
            blocked: true,
            output: `A preToolUse hook blocked this ${toolName} call:\n${detail}`,
          };
        }
      }
    }
    return { blocked: false, output: outputs.join("\n") };
  }

  runStop(): void {
    for (const def of this.hooks.stop ?? []) {
      try {
        execSync(def.command, {
          cwd: this.workspace,
          timeout: HOOK_TIMEOUT_MS,
          stdio: "ignore",
        });
      } catch {
        // stop hooks are best-effort.
      }
    }
  }
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return "{}";
  }
}
