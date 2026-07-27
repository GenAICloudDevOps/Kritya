import fs from "node:fs/promises";
import path from "node:path";
import type { ToolDef } from "../types.js";
import { writeFileAtomic } from "../atomicWrite.js";
import { resolveSafe } from "./common.js";
import { diffLines } from "./diff.js";
import { formatSecretWarning, scanForSecrets } from "./secretScan.js";

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
  // The summary line already names the file and its size; "Wrote <path>" under
  // it is the same sentence twice.
  resultSummary: () => "",
  summarize: (args) =>
    `Write ${args.path} (${Buffer.byteLength(String(args.content ?? ""), "utf8")} bytes)`,
  async preview(args, ctx) {
    const abs = resolveSafe(ctx.workspace, String(args.path));
    let existing: string;
    try {
      existing = await fs.readFile(abs, "utf8");
    } catch {
      existing = "";
    }
    return diffLines(existing, String(args.content ?? ""));
  },
  async execute(args, ctx) {
    const abs = resolveSafe(ctx.workspace, String(args.path));
    const content = String(args.content);
    const secrets = scanForSecrets(content);
    if (secrets.length > 0) {
      throw new Error(formatSecretWarning(secrets, String(args.path)));
    }
    await fs.mkdir(path.dirname(abs), { recursive: true });
    ctx.undo?.snapshot(abs, String(args.path));
    await writeFileAtomic(abs, content);
    return `Wrote ${args.path}`;
  },
};
