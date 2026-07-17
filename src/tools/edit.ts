import fs from "node:fs/promises";
import type { ToolDef } from "../types.js";
import { resolveSafe } from "./common.js";
import { diffLines } from "./diff.js";

export const editFileTool: ToolDef = {
  name: "edit_file",
  description:
    "Replace an exact string in a file. old_string must match the file content exactly " +
    "(including whitespace) and must be unique in the file unless replace_all is true.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path relative to the workspace root" },
      old_string: { type: "string", description: "Exact text to find" },
      new_string: { type: "string", description: "Text to replace it with" },
      replace_all: {
        type: "boolean",
        description: "Replace every occurrence instead of requiring uniqueness",
      },
    },
    required: ["path", "old_string", "new_string"],
  },
  requiresPermission: true,
  summarize: (args) => `Edit ${args.path}`,
  async preview(args) {
    return diffLines(String(args.old_string ?? ""), String(args.new_string ?? ""));
  },
  async execute(args, ctx) {
    const abs = resolveSafe(ctx.workspace, String(args.path));
    const oldStr = String(args.old_string);
    const newStr = String(args.new_string);
    if (oldStr === newStr) throw new Error("old_string and new_string are identical");
    const content = await fs.readFile(abs, "utf8");
    const count = content.split(oldStr).length - 1;
    if (count === 0) {
      throw new Error(`old_string not found in ${args.path}. Read the file and retry with the exact text.`);
    }
    if (count > 1 && !args.replace_all) {
      throw new Error(
        `old_string occurs ${count} times in ${args.path}. Provide a longer unique string or set replace_all.`
      );
    }
    const next = args.replace_all
      ? content.split(oldStr).join(newStr)
      : content.replace(oldStr, newStr);
    ctx.undo?.snapshot(abs, String(args.path));
    await fs.writeFile(abs, next, "utf8");
    return `Replaced ${args.replace_all ? count : 1} occurrence(s) in ${args.path}`;
  },
};
