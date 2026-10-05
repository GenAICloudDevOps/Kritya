import type { ToolDef } from "../types.js";
import { subagentStatusNote } from "../agent/subagents.js";

const MAX_AGENTS = 6;

/**
 * Dispatches one or more focused, read-only subtasks to fresh agents that each
 * get their own context window and return only a summary. Useful for wide
 * searches and codebase questions that would otherwise flood the main
 * conversation with tool output. Subagents cannot write, edit, or run shell
 * commands. Multiple tasks run concurrently.
 */
export const spawnAgentTool: ToolDef = {
  name: "spawn_agent",
  description:
    "Run one or more read-only subagents on focused investigations (e.g. 'find everywhere X is " +
    "used and summarize how it works'), each in its own fresh context. They can read, list, glob, " +
    "and grep, but cannot modify files or run commands. Pass multiple tasks to investigate several " +
    "independent things at once — they run concurrently. Returns each subagent's findings. Prefer " +
    "this for broad searches so the main context stays lean.",
  parameters: {
    type: "object",
    properties: {
      tasks: {
        type: "array",
        items: { type: "string" },
        minItems: 1,
        maxItems: MAX_AGENTS,
        description:
          "Self-contained instructions for each subagent, one per investigation. Each must include " +
          "all context it needs; subagents do not see the current conversation.",
      },
    },
    required: ["tasks"],
  },
  requiresPermission: false,
  // Self-managed: each subagent has its own wall-clock cap and the batch runs
  // several in sequence, so the total legitimately exceeds any per-tool limit.
  timeoutMs: 0,
  async execute(args, ctx, signal, onProgress) {
    const tasks = Array.isArray(args.tasks)
      ? args.tasks.map((t) => String(t).trim()).filter(Boolean)
      : [];
    if (!tasks.length) return "Error: tasks is required and must be a non-empty array of strings.";
    if (tasks.length > MAX_AGENTS) return `Error: at most ${MAX_AGENTS} tasks per call.`;
    if (!ctx.spawnAgents) return "Error: subagents are not available in this session.";

    const results = await ctx.spawnAgents(
      tasks.map((task) => ({ task, write: false })),
      signal,
      // The runner reports per-subagent status; the batch is what knows how
      // many there are, so the "2/6" framing is added here.
      (index, text) => onProgress?.(`subagent ${index + 1}/${tasks.length} · ${text}`)
    );
    if (results.length === 1) {
      const note = subagentStatusNote(results[0]);
      return note ? `${results[0].summary}\n\n${note}` : results[0].summary;
    }
    return results
      .map((r, i) => {
        const note = subagentStatusNote(r);
        const header = `--- Subagent ${i + 1}: ${r.task.slice(0, 60)} ---`;
        return note ? `${header}\n${r.summary}\n${note}` : `${header}\n${r.summary}`;
      })
      .join("\n\n");
  },
  summarize: (args) => {
    const tasks = Array.isArray(args.tasks) ? args.tasks : [];
    if (tasks.length <= 1) return `Subagent: ${String(tasks[0] ?? "").slice(0, 60)}`;
    return `${tasks.length} subagents in parallel`;
  },
};
