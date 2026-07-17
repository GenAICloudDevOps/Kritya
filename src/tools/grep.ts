import fs from "node:fs/promises";
import path from "node:path";
import fg from "fast-glob";
import type { ToolDef } from "../types.js";
import { resolveSafe, truncateResult } from "./common.js";
import { loadIgnorePatterns } from "./ignore.js";

const MAX_MATCHES = 200;
const MAX_FILE_BYTES = 1024 * 1024;

export const grepTool: ToolDef = {
  name: "grep",
  description:
    "Search file contents with a regular expression. Returns 'file:line: text' matches. " +
    "Ignores node_modules, .git, binary files, and anything matched by a .krityaignore " +
    "file in the workspace root.",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "JavaScript regular expression to search for" },
      path: { type: "string", description: "Directory to search in (default: workspace root)" },
      include: {
        type: "string",
        description: "Glob filter for files to search, e.g. '**/*.ts' (default: all files)",
      },
    },
    required: ["pattern"],
  },
  requiresPermission: false,
  summarize: (args) => `Grep /${args.pattern}/ in ${args.path ?? "."}`,
  async execute(args, ctx) {
    const regex = new RegExp(String(args.pattern));
    const searchRoot = resolveSafe(ctx.workspace, String(args.path ?? "."));
    // Models on Windows sometimes emit backslash paths; fast-glob needs forward slashes.
    const files = await fg(String(args.include ?? "**/*").replaceAll("\\", "/"), {
      cwd: searchRoot,
      dot: false,
      onlyFiles: true,
      ignore: ["**/node_modules/**", "**/.git/**", ...loadIgnorePatterns(ctx.workspace)],
      suppressErrors: true,
    });

    const matches: string[] = [];
    for (const file of files) {
      if (matches.length >= MAX_MATCHES) break;
      const abs = path.join(searchRoot, file);
      let stat;
      try {
        stat = await fs.stat(abs);
      } catch {
        continue;
      }
      if (stat.size > MAX_FILE_BYTES) continue;
      let content: string;
      try {
        content = await fs.readFile(abs, "utf8");
      } catch {
        continue;
      }
      if (content.slice(0, 8000).includes("\0")) continue;
      const rel = path.relative(ctx.workspace, abs);
      const lines = content.split("\n");
      for (let i = 0; i < lines.length && matches.length < MAX_MATCHES; i++) {
        if (regex.test(lines[i])) {
          matches.push(`${rel}:${i + 1}: ${lines[i].slice(0, 250)}`);
        }
      }
    }
    const suffix = matches.length >= MAX_MATCHES ? `\n... [match limit reached]` : "";
    return truncateResult(matches.join("\n") + suffix || "(no matches)");
  },
};
