import type { ToolDef } from "../types.js";

const MAX_AGENTS = 4;

/**
 * Dispatches one or more subagents that can write files, edit files, and run
 * shell commands — each isolated on its own git branch/worktree so nothing
 * touches the user's real working tree until they review and merge it.
 * Always requires permission: this is the one tool that lets the model make
 * unattended file/shell changes, so the user approves the task list up front.
 */
export const spawnWriteAgentTool: ToolDef = {
  name: "spawn_write_agent",
  description:
    "Run one or more subagents that can write/edit files and run shell commands, for independent " +
    "chunks of work that can proceed in parallel (e.g. 'implement the API client' and 'write its " +
    "tests' at the same time). Each subagent works in an isolated git worktree on its own branch — " +
    "it never touches your real working tree. Requires the workspace to be a git repository. " +
    "Returns a summary of each subagent's changes and the branch name to review/merge " +
    "(git diff <base>...<branch>, git merge <branch>); branches with no changes are cleaned up " +
    "automatically. Destructive shell commands (rm -rf, force push, etc.) are still blocked inside " +
    "these subagents since there's no one to confirm them.",
  parameters: {
    type: "object",
    properties: {
      tasks: {
        type: "array",
        items: { type: "string" },
        minItems: 1,
        maxItems: MAX_AGENTS,
        description:
          "Self-contained instructions for each subagent, one per independent piece of work. Each " +
          "must include all context it needs — subagents do not see the current conversation.",
      },
    },
    required: ["tasks"],
  },
  requiresPermission: true,
  summarize: (args) => {
    const tasks = Array.isArray(args.tasks) ? args.tasks : [];
    if (tasks.length <= 1) return `Write subagent: ${String(tasks[0] ?? "").slice(0, 60)}`;
    return `${tasks.length} write subagents in parallel`;
  },
  async preview(args) {
    const tasks = Array.isArray(args.tasks) ? args.tasks : [];
    return (
      `About to run ${tasks.length} write-capable subagent(s), each isolated on its own git branch:\n` +
      tasks.map((t, i) => `  ${i + 1}. ${String(t).slice(0, 100)}`).join("\n") +
      `\n\nNone of this touches your working tree directly — review each branch's diff before merging.`
    );
  },
  async execute(args, ctx, signal) {
    const tasks = Array.isArray(args.tasks)
      ? args.tasks.map((t) => String(t).trim()).filter(Boolean)
      : [];
    if (!tasks.length) return "Error: tasks is required and must be a non-empty array of strings.";
    if (tasks.length > MAX_AGENTS) return `Error: at most ${MAX_AGENTS} tasks per call.`;
    if (!ctx.spawnAgents) return "Error: subagents are not available in this session.";

    const results = await ctx.spawnAgents(
      tasks.map((task) => ({ task, write: true })),
      signal
    );
    return results
      .map((r, i) => {
        const header = `--- Write subagent ${i + 1}: ${r.task.slice(0, 60)} ---`;
        if (r.error) return `${header}\n${r.summary}\n[error: ${r.error}]`;
        const branchNote = r.branch
          ? `\n\nChanges committed to branch "${r.branch}". Review with ` +
            `\`git diff main...${r.branch}\` (or your base branch), merge with \`git merge ${r.branch}\`.`
          : "\n\n(no file changes were made)";
        return `${header}\n${r.summary}${branchNote}`;
      })
      .join("\n\n");
  },
};
