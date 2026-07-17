import type { ToolDef } from "../types.js";

/**
 * Dispatches a focused subtask to a fresh, read-only agent that has its own
 * context window and returns only a summary. Useful for wide searches and
 * codebase questions that would otherwise flood the main conversation with
 * tool output. The subagent cannot write, edit, or run shell commands.
 */
export const spawnAgentTool: ToolDef = {
  name: "spawn_agent",
  description:
    "Run a read-only subagent on a focused investigation (e.g. 'find everywhere X is used and " +
    "summarize how it works') in its own fresh context. It can read, list, glob, and grep, but " +
    "cannot modify files or run commands. Returns the subagent's findings. Prefer this for broad " +
    "searches so the main context stays lean.",
  parameters: {
    type: "object",
    properties: {
      task: {
        type: "string",
        description:
          "A self-contained instruction for the subagent. Include all context it needs; it does " +
          "not see the current conversation.",
      },
    },
    required: ["task"],
  },
  requiresPermission: false,
  async execute(args, ctx) {
    const task = String(args.task ?? "").trim();
    if (!task) return "Error: task is required.";
    if (!ctx.spawnSubagent) return "Error: subagents are not available in this session.";
    return ctx.spawnSubagent(task);
  },
  summarize: (args) => `Subagent: ${String(args.task ?? "").slice(0, 60)}`,
};
