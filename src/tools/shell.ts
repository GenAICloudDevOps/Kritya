import { exec } from "node:child_process";
import type { ToolDef } from "../types.js";
import { truncateResult } from "./common.js";

const TIMEOUT_MS = 120_000;

export const shellTool: ToolDef = {
  name: "shell",
  description:
    "Run a shell command in the workspace root (sh on Linux/macOS, cmd on Windows). " +
    "Returns stdout, stderr, and the exit code. Times out after 2 minutes.",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "The command to run" },
    },
    required: ["command"],
  },
  requiresPermission: true,
  summarize: (args) => `Run: ${args.command}`,
  execute(args, ctx) {
    const command = String(args.command);
    // exec (not execFile) on purpose: this tool exists to run arbitrary
    // shell commands, and every invocation is gated by a user permission prompt.
    return new Promise((resolve) => {
      exec(
        command,
        {
          cwd: ctx.workspace,
          timeout: TIMEOUT_MS,
          maxBuffer: 10 * 1024 * 1024,
          windowsHide: true,
        },
        (error, stdout, stderr) => {
          const parts: string[] = [];
          if (stdout) parts.push(stdout.trimEnd());
          if (stderr) parts.push(`[stderr]\n${stderr.trimEnd()}`);
          if (error) {
            if (error.killed) {
              parts.push(`[command timed out after ${TIMEOUT_MS / 1000}s]`);
            } else {
              parts.push(`[exit code: ${error.code ?? "unknown"}]`);
            }
          }
          resolve(truncateResult(parts.join("\n") || "(no output)"));
        }
      );
    });
  },
};
