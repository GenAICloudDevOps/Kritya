import type { ToolDef } from "../types.js";
import { buildRepoMap } from "../repomap/repoMap.js";

export const repoMapTool: ToolDef = {
  name: "repo_map",
  description:
    "Get a structural overview of the codebase: a ranked skeleton of source files with their " +
    "class/function/type signatures (no bodies). Use this FIRST to orient yourself in an " +
    "unfamiliar or large repository before grepping or reading files — it shows where things " +
    "live at a fraction of the token cost of reading files. Pass a `path` to focus on one " +
    "subdirectory. Covers mainstream languages (TS/JS, Python, Go, Rust, Java, Kotlin, C#, " +
    "C/C++, Ruby, PHP, Swift, Scala); files in other languages are omitted.",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description:
          "Optional subdirectory to map, relative to the workspace root (default: whole workspace)",
      },
    },
  },
  requiresPermission: false,
  summarize: (args) => (args.path ? `Repo map: ${args.path}` : "Repo map (whole workspace)"),
  async execute(args, ctx) {
    return buildRepoMap(ctx.workspace, String(args.path ?? "."));
  },
};
