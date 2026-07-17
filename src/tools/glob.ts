import fg from "fast-glob";
import type { ToolDef } from "../types.js";
import { truncateResult } from "./common.js";

export const globTool: ToolDef = {
  name: "glob",
  description:
    "Find files matching a glob pattern (e.g. 'src/**/*.ts'). Ignores node_modules and .git.",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Glob pattern relative to the workspace root" },
    },
    required: ["pattern"],
  },
  requiresPermission: false,
  summarize: (args) => `Glob ${args.pattern}`,
  async execute(args, ctx) {
    // Models on Windows sometimes emit backslash paths; fast-glob needs forward slashes.
    const files = await fg(String(args.pattern).replaceAll("\\", "/"), {
      cwd: ctx.workspace,
      dot: false,
      onlyFiles: true,
      ignore: ["**/node_modules/**", "**/.git/**"],
      suppressErrors: true,
    });
    const capped = files.sort().slice(0, 200);
    const suffix = files.length > 200 ? `\n... [${files.length - 200} more]` : "";
    return truncateResult(capped.join("\n") + suffix || "(no matches)");
  },
};
