import { exec, execFile } from "node:child_process";
import { scrubbedShellEnv } from "../config/config.js";
import { gitDiffStat } from "../git/git.js";
import { backgroundManager } from "../shell/background.js";
import {
  buildSandboxedCommand,
  sandboxUnavailableReason,
  shouldSandbox,
} from "../shell/sandbox.js";
import type { ToolDef } from "../types.js";
import { truncateTail } from "./common.js";

const DEFAULT_TIMEOUT_S = 120;
const MAX_TIMEOUT_S = 600;

/** git subcommands that rewrite the working tree, index, or history. */
const GIT_MUTATING_RE =
  /\bgit\s+(commit|merge|rebase|pull|checkout|reset|clean|stash|cherry-pick|revert|apply|am|rm|mv|restore|add)\b/i;

export const shellTool: ToolDef = {
  name: "shell",
  description:
    "Run a shell command from the workspace root (sh on Linux/macOS, cmd on Windows). " +
    "Returns stdout, stderr, and the exit code. Use `cd subdir && cmd` to run in a subdirectory. " +
    "For long-running processes (dev servers, watchers) pass background:true — the command " +
    "returns an id immediately; use bg_output to read its output and bg_kill to stop it. " +
    "Foreground commands time out after timeout_seconds (default 120, max 600).",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "The command to run" },
      timeout_seconds: {
        type: "number",
        description: "Foreground timeout in seconds (default 120, max 600)",
      },
      background: {
        type: "boolean",
        description: "Run detached for servers/watchers; returns an id for bg_output/bg_kill",
      },
    },
    required: ["command"],
  },
  requiresPermission: true,
  // Self-managed: timeout_seconds (max 600) is enforced by exec below, and a
  // background command returns immediately. A second, shorter cap from the
  // agent loop would cut off commands the user explicitly asked to run longer.
  timeoutMs: 0,
  summarize: (args) => `Run${args.background ? " in background" : ""}: ${args.command}`,
  async preview(args, ctx) {
    const command = String(args.command ?? "");
    if (!GIT_MUTATING_RE.test(command)) return null;
    return gitDiffStat(ctx.workspace) || null;
  },
  execute(args, ctx, signal) {
    const command = String(args.command);

    if (args.background) {
      const { id } = backgroundManager.start(command, ctx.workspace);
      return Promise.resolve(
        `Started background process ${id}: ${command}\nUse bg_output {"id":"${id}"} to read its output and bg_kill {"id":"${id}"} to stop it.`
      );
    }

    const timeoutS = Math.min(
      Math.max(Number(args.timeout_seconds) || DEFAULT_TIMEOUT_S, 1),
      MAX_TIMEOUT_S
    );
    const runOpts = {
      cwd: ctx.workspace,
      env: scrubbedShellEnv(),
      timeout: timeoutS * 1000,
      maxBuffer: 10 * 1024 * 1024,
      windowsHide: true,
      signal,
    };

    const finish = (
      resolve: (v: string) => void,
      error: { killed?: boolean; code?: number | string | null } | null,
      stdout: string,
      stderr: string,
      note?: string
    ) => {
      const parts: string[] = [];
      if (note) parts.push(note);
      if (stdout) parts.push(stdout.trimEnd());
      if (stderr) parts.push(`[stderr]\n${stderr.trimEnd()}`);
      if (error) {
        if (signal?.aborted) {
          parts.push("[command cancelled by user]");
        } else if (error.killed) {
          parts.push(
            `[command timed out after ${timeoutS}s — for servers/watchers use background:true]`
          );
        } else {
          parts.push(`[exit code: ${error.code ?? "unknown"}]`);
        }
      }
      resolve(truncateTail(parts.join("\n") || "(no output)"));
    };

    return new Promise((resolve) => {
      if (shouldSandbox(ctx.sandboxMode, command)) {
        const wrapped = buildSandboxedCommand(command, ctx.workspace);
        if (wrapped) {
          execFile(wrapped.cmd, wrapped.args, runOpts, (error, stdout, stderr) => {
            wrapped.cleanup?.();
            finish(resolve, error, stdout, stderr);
          });
          return;
        }
        // Sandboxing was requested but no sandbox binary is available here —
        // fall back to a plain run rather than silently failing, but say so.
        exec(command, runOpts, (error, stdout, stderr) =>
          finish(
            resolve,
            error,
            stdout,
            stderr,
            `[sandbox unavailable (${sandboxUnavailableReason()}) — ran without sandbox]`
          )
        );
        return;
      }

      // exec (not execFile) on purpose: this tool exists to run arbitrary
      // shell commands, and every invocation is gated by a user permission prompt.
      exec(command, runOpts, (error, stdout, stderr) => finish(resolve, error, stdout, stderr));
    });
  },
};
