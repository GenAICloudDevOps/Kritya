import fs from "node:fs/promises";
import type { ToolDef } from "../types.js";
import { resolveSafe } from "./common.js";
import { diffLines } from "./diff.js";
import { applyEdit } from "./fuzzyMatch.js";

export const editFileTool: ToolDef = {
  name: "edit_file",
  description:
    "Replace a string in a file. Prefer an exact match of old_string (including whitespace); " +
    "if the exact text isn't found, a whitespace-tolerant line match is attempted as a fallback. " +
    "old_string must be unique in the file unless replace_all is true.",
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
    const replaceAll = Boolean(args.replace_all);
    if (oldStr === newStr) throw new Error("old_string and new_string are identical");
    const content = await fs.readFile(abs, "utf8");

    const match = applyEdit(content, oldStr, newStr, replaceAll);
    if (!match.matched) {
      throw new Error(
        `old_string not found in ${args.path} (tried exact and whitespace-tolerant matching). ` +
          `Read the file and retry with text copied from it.`
      );
    }
    if (match.count > 1 && !replaceAll) {
      throw new Error(
        `old_string occurs ${match.count} times in ${args.path}. Provide a longer unique string or set replace_all.`
      );
    }

    ctx.undo?.snapshot(abs, String(args.path));
    await fs.writeFile(abs, match.result!, "utf8");
    const fuzzy = match.strategy === "line-trimmed" ? " (matched ignoring whitespace)" : "";
    return `Replaced ${replaceAll ? match.count : 1} occurrence(s) in ${args.path}${fuzzy}`;
  },
};
