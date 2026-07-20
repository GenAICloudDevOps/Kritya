import fs from "node:fs/promises";
import path from "node:path";
import type { ToolDef } from "../types.js";
import { resolveSafe, truncateResult } from "./common.js";
import { readDocx, writeDocx } from "./document/docx.js";
import { readXlsx, writeXlsx, editXlsx } from "./document/xlsx.js";
import { readPptx, writePptx } from "./document/pptx.js";
import { readPdf, writePdf } from "./document/pdf.js";
import type { DocumentContent, CellEdit } from "./document/types.js";

const READABLE_EXTENSIONS = [".docx", ".xlsx", ".pptx", ".pdf"];

const BLOCK_SCHEMA = {
  type: "array",
  description: "Flowed content blocks, in document order.",
  items: {
    type: "object",
    properties: {
      type: {
        type: "string",
        enum: ["heading1", "heading2", "heading3", "paragraph", "bullet", "numbered"],
      },
      text: { type: "string" },
    },
    required: ["type", "text"],
  },
};

export const readDocumentTool: ToolDef = {
  name: "read_document",
  description:
    "Read a Word (.docx), Excel (.xlsx), PowerPoint (.pptx), or PDF (.pdf) file from the " +
    "workspace and return its text content. For plain text, Markdown, or CSV files use read_file instead.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path relative to the workspace root" },
    },
    required: ["path"],
  },
  requiresPermission: false,
  summarize: (args) => `Read ${args.path}`,
  async execute(args, ctx) {
    const relPath = String(args.path);
    const abs = resolveSafe(ctx.workspace, relPath);
    const ext = path.extname(abs).toLowerCase();
    const buf = await fs.readFile(abs);

    switch (ext) {
      case ".docx":
        return truncateResult(await readDocx(buf));
      case ".xlsx":
        return truncateResult(await readXlsx(buf));
      case ".pptx":
        return truncateResult(await readPptx(buf));
      case ".pdf":
        return truncateResult(await readPdf(buf));
      default:
        throw new Error(
          `Unsupported extension "${ext}" for read_document. Supported: ${READABLE_EXTENSIONS.join(", ")}`
        );
    }
  },
};

export const writeDocumentTool: ToolDef = {
  name: "write_document",
  description:
    "Create or overwrite a Word (.docx), Excel (.xlsx), PowerPoint (.pptx), or PDF (.pdf) file " +
    "in the workspace from structured content. Always replaces the whole document. " +
    "For .docx and .pdf, pass `content.blocks`. For .xlsx, pass `content.sheets`. For .pptx, pass `content.slides`.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path relative to the workspace root" },
      content: {
        type: "object",
        properties: {
          blocks: BLOCK_SCHEMA,
          sheets: {
            type: "array",
            description: "Worksheets, for .xlsx.",
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                rows: {
                  type: "array",
                  items: {
                    type: "array",
                    items: { type: ["string", "number", "boolean", "null"] },
                  },
                },
              },
              required: ["name", "rows"],
            },
          },
          slides: {
            type: "array",
            description: "Slides, for .pptx.",
            items: {
              type: "object",
              properties: {
                title: { type: "string" },
                bullets: { type: "array", items: { type: "string" } },
                notes: { type: "string" },
              },
            },
          },
        },
      },
    },
    required: ["path", "content"],
  },
  requiresPermission: true,
  summarize: (args) => `Write ${args.path}`,
  async preview(args) {
    const content = (args.content ?? {}) as DocumentContent;
    if (content.blocks) return `${content.blocks.length} content block(s)`;
    if (content.sheets) return `${content.sheets.length} sheet(s)`;
    if (content.slides) return `${content.slides.length} slide(s)`;
    return null;
  },
  async execute(args, ctx) {
    const relPath = String(args.path);
    const abs = resolveSafe(ctx.workspace, relPath);
    const ext = path.extname(abs).toLowerCase();
    const content = (args.content ?? {}) as DocumentContent;

    let buf: Buffer;
    switch (ext) {
      case ".docx":
        buf = await writeDocx(requireField(content.blocks, "content.blocks", ext));
        break;
      case ".pdf":
        buf = await writePdf(requireField(content.blocks, "content.blocks", ext));
        break;
      case ".xlsx":
        buf = await writeXlsx(requireField(content.sheets, "content.sheets", ext));
        break;
      case ".pptx":
        buf = await writePptx(requireField(content.slides, "content.slides", ext));
        break;
      default:
        throw new Error(
          `Unsupported extension "${ext}" for write_document. Supported: ${READABLE_EXTENSIONS.join(", ")}`
        );
    }

    await fs.mkdir(path.dirname(abs), { recursive: true });
    ctx.undo?.snapshot(abs, relPath);
    await fs.writeFile(abs, buf);
    return `Wrote ${relPath}`;
  },
};

export const editSpreadsheetTool: ToolDef = {
  name: "edit_spreadsheet",
  description:
    "Change specific cells of an existing Excel (.xlsx) file in place, leaving every other cell, " +
    "formula, and sheet untouched. Pass one or more edits, each with a cell in A1 notation and a " +
    'new value; a value beginning with "=" is stored as a formula. Use read_document first to ' +
    "see the sheet. To create a new spreadsheet or replace one wholesale, use write_document instead.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path relative to the workspace root" },
      edits: {
        type: "array",
        description: "Cell changes to apply, in order.",
        items: {
          type: "object",
          properties: {
            sheet: {
              type: "string",
              description: "Sheet name; defaults to the first worksheet if omitted.",
            },
            cell: { type: "string", description: 'Cell in A1 notation, e.g. "B7".' },
            value: {
              type: ["string", "number", "boolean", "null"],
              description: 'New value; a string starting with "=" becomes a formula.',
            },
          },
          required: ["cell", "value"],
        },
      },
    },
    required: ["path", "edits"],
  },
  requiresPermission: true,
  summarize: (args) => {
    const edits = (args.edits ?? []) as CellEdit[];
    return `Edit ${args.path} (${edits.length} cell${edits.length === 1 ? "" : "s"})`;
  },
  async preview(args, ctx) {
    const edits = (args.edits ?? []) as CellEdit[];
    if (edits.length === 0) return null;
    try {
      const abs = resolveSafe(ctx.workspace, String(args.path));
      const buf = await fs.readFile(abs);
      const { applied } = await editXlsx(buf, edits);
      return applied
        .map((a) => `${a.sheet}!${a.cell}:  ${a.oldValue || "(empty)"}  →  ${a.newValue}`)
        .join("\n");
    } catch {
      // Fall back to a value-only preview if the file can't be read yet.
      return edits
        .map((e) => `${e.sheet ? e.sheet + "!" : ""}${e.cell} → ${String(e.value)}`)
        .join("\n");
    }
  },
  async execute(args, ctx) {
    const relPath = String(args.path);
    const abs = resolveSafe(ctx.workspace, relPath);
    const ext = path.extname(abs).toLowerCase();
    if (ext !== ".xlsx") {
      throw new Error(`edit_spreadsheet only supports .xlsx files, got "${ext}"`);
    }
    const edits = (args.edits ?? []) as CellEdit[];
    if (edits.length === 0) throw new Error("edit_spreadsheet: `edits` must be non-empty");

    const buf = await fs.readFile(abs);
    const { buf: out, applied } = await editXlsx(buf, edits);

    ctx.undo?.snapshot(abs, relPath);
    await fs.writeFile(abs, out);
    const detail = applied.map((a) => `${a.sheet}!${a.cell}=${a.newValue}`).join(", ");
    return `Updated ${applied.length} cell(s) in ${relPath}: ${detail}`;
  },
};

function requireField<T>(value: T[] | undefined, fieldName: string, ext: string): T[] {
  if (!value || value.length === 0) {
    throw new Error(
      `write_document: "${fieldName}" is required and must be non-empty for ${ext} files`
    );
  }
  return value;
}
