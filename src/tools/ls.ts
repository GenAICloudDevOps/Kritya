import fs from "node:fs/promises";
import type { ToolDef } from "../types.js";
import { resolveSafe, truncateResult } from "./common.js";

export const listDirTool: ToolDef = {
  name: "list_dir",
  description: "List the entries of a directory in the workspace. Directories end with '/'.",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Directory path relative to the workspace root (default: '.')",
      },
    },
  },
  requiresPermission: false,
  summarize: (args) => `List ${args.path ?? "."}`,
  async execute(args, ctx) {
    const abs = resolveSafe(ctx.workspace, String(args.path ?? "."));
    const entries = await fs.readdir(abs, { withFileTypes: true });
    const names = entries
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
      .sort()
      .slice(0, 500);
    return truncateResult(names.join("\n") || "(empty)");
  },
};
