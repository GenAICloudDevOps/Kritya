import fs from "node:fs/promises";
import type { ToolDef } from "../types.js";
import { resolveSafe, truncateResult, countLines } from "./common.js";

export const readFileTool: ToolDef = {
  name: "read_file",
  description:
    "Read a text file from the workspace. Returns the content with line numbers. " +
    "Use offset/limit for large files. Refuses binary files — use read_document for .pdf/.docx/.xlsx/.pptx.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path relative to the workspace root" },
      offset: { type: "number", description: "1-based line number to start from (optional)" },
      limit: { type: "number", description: "Maximum number of lines to return (optional)" },
    },
    required: ["path"],
  },
  requiresPermission: false,
  summarize: (args) => `Read ${args.path}`,
  resultSummary: (output) => countLines(output, "line", "lines"),
  async execute(args, ctx) {
    const abs = resolveSafe(ctx.workspace, String(args.path));
    const buffer = await fs.readFile(abs);
    // Binary sniff, same as grep: a NUL byte in the first 8KB means this is
    // not text. Decoding it as UTF-8 anyway would dump garbage into the
    // context and burn tokens on bytes no one can read.
    if (buffer.subarray(0, 8000).includes(0)) {
      throw new Error(
        `"${args.path}" looks like a binary file — read_file only reads text. ` +
          `For .pdf, .docx, .xlsx, or .pptx use read_document instead.`
      );
    }
    const content = buffer.toString("utf8");
    const lines = content.split("\n");
    const offset = Math.max(1, Number(args.offset) || 1);
    const limit = Number(args.limit) || 2000;
    const slice = lines.slice(offset - 1, offset - 1 + limit);
    const numbered = slice.map((l, i) => `${String(offset + i).padStart(5)}\t${l}`).join("\n");
    const header =
      lines.length > slice.length
        ? `[showing lines ${offset}-${offset + slice.length - 1} of ${lines.length}]\n`
        : "";
    return truncateResult(header + numbered);
  },
};
