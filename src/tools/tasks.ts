import type { TaskItem, ToolDef } from "../types.js";

const VALID_STATUS = new Set(["pending", "in_progress", "done"]);

export const updateTasksTool: ToolDef = {
  name: "update_tasks",
  description:
    "Maintain a visible checklist for multi-step work. Call with the FULL task list " +
    "(it replaces the previous list) whenever you plan steps or a step's status changes. " +
    "Use it at the start of any request that needs more than 2 distinct steps.",
  parameters: {
    type: "object",
    properties: {
      tasks: {
        type: "array",
        description: "The complete, ordered task list",
        items: {
          type: "object",
          properties: {
            text: { type: "string", description: "Short description of the step" },
            status: { type: "string", enum: ["pending", "in_progress", "done"] },
          },
          required: ["text", "status"],
        },
      },
    },
    required: ["tasks"],
  },
  requiresPermission: false,
  summarize: (args) => {
    const tasks = Array.isArray(args.tasks) ? (args.tasks as TaskItem[]) : [];
    const done = tasks.filter((t) => t.status === "done").length;
    return `Update tasks (${done}/${tasks.length} done)`;
  },
  async execute(args, ctx) {
    if (!Array.isArray(args.tasks)) throw new Error("tasks must be an array");
    const tasks: TaskItem[] = (args.tasks as Record<string, unknown>[]).map((t) => ({
      text: String(t.text ?? ""),
      status: VALID_STATUS.has(String(t.status))
        ? (String(t.status) as TaskItem["status"])
        : "pending",
    }));
    ctx.onTasksUpdate?.(tasks);
    return `Task list updated (${tasks.length} tasks).`;
  },
};
