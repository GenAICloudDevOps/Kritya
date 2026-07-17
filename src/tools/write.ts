import fs from "node:fs/promises";
import path from "node:path";
import type { ToolDef } from "../types.js";
import { resolveSafe } from "./common.js";
import { diffLines } from "./diff.js";

export const writeFileTool: ToolDef = {
  name: "write_file",
  description:
    "Create or overwrite a file in the workspace with the given content. " +
    "Parent directories are created automatically.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path relative to the workspace root" },
      content: { type: "string", description: "Full content to write" },
    },
    required: ["path", "content"],
  },
  requiresPermission: true,
  summarize: (args) =>
    `Write ${args.path} (${Buffer.byteLength(String(args.content ?? ""), "utf8")} bytes)`,
  async preview(args, ctx) {
    const abs = resolveSafe(ctx.workspace, String(args.path));
    let existing = "";
    try {
      existing = await fs.readFile(abs, "utf8");
    } catch {
      existing = "";
    }
    return diffLines(existing, String(args.content ?? ""));
  },
  async execute(args, ctx) {
    const abs = resolveSafe(ctx.workspace, String(args.path));
    await fs.mkdir(path.dirname(abs), { recursive: true });
    ctx.undo?.snapshot(abs, String(args.path));
    await fs.writeFile(abs, String(args.content), "utf8");
    return `Wrote ${args.path}`;
  },
};
