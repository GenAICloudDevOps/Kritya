import path from "node:path";
import fg from "fast-glob";
import type { ToolDef } from "../types.js";
import { isPathSafe, truncateResult } from "./common.js";
import { loadIgnorePatterns } from "./ignore.js";

export const globTool: ToolDef = {
  name: "glob",
  description:
    "Find files matching a glob pattern (e.g. 'src/**/*.ts'). Ignores node_modules, .git, " +
    "and anything matched by a .krityaignore file in the workspace root.",
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
      followSymbolicLinks: false,
      ignore: ["**/node_modules/**", "**/.git/**", ...loadIgnorePatterns(ctx.workspace)],
      suppressErrors: true,
    });
    const safeFiles = files.filter((f) => isPathSafe(ctx.workspace, path.join(ctx.workspace, f)));
    const capped = safeFiles.sort().slice(0, 200);
    const suffix = safeFiles.length > 200 ? `\n... [${safeFiles.length - 200} more]` : "";
    return truncateResult(capped.join("\n") + suffix || "(no matches)");
  },
};
