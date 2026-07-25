import fs from "node:fs/promises";
import path from "node:path";
import type { ToolDef } from "../types.js";
import { writeFileAtomic } from "../atomicWrite.js";
import { resolveSafe, truncateResult } from "./common.js";
import { readDocx, writeDocx } from "./document/docx.js";
import { readXlsx, writeXlsx, editXlsx } from "./document/xlsx.js";
import { readPptx, writePptx } from "./document/pptx.js";
import { readPdf, writePdf, editPdf } from "./document/pdf.js";
import type { DocumentContent, CellEdit, PdfEdit } from "./document/types.js";

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
          `Unsupported extension "${ext}" for read_document. Supported: ` +
            `${READABLE_EXTENSIONS.join(", ")}. For text formats such as .md, .txt, or .csv, use read_file.`
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
            description:
              "Slides, for .pptx. Every slide needs its body text in `bullets` — a slide with " +
              "only a `title` renders as a single line on an otherwise empty slide.",
            items: {
              type: "object",
              properties: {
                title: { type: "string", description: "Slide heading, one short line." },
                bullets: {
                  type: "array",
                  items: { type: "string" },
                  description:
                    "The slide's body, one string per bullet. Put all visible content here; " +
                    "aim for 3-6 bullets of at most ~15 words each.",
                },
                notes: {
                  type: "string",
                  description: "Speaker notes; not shown on the slide itself.",
                },
              },
              required: ["title", "bullets"],
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
    const content = extractContent(args);
    if (content.blocks) return `${content.blocks.length} content block(s)`;
    if (content.sheets) return `${content.sheets.length} sheet(s)`;
    if (content.slides) return `${content.slides.length} slide(s)`;
    return null;
  },
  async execute(args, ctx) {
    const relPath = String(args.path);
    const abs = resolveSafe(ctx.workspace, relPath);
    const ext = path.extname(abs).toLowerCase();
    const content = extractContent(args);

    let buf: Buffer;
    switch (ext) {
      case ".docx":
        buf = await writeDocx(requireField(content.blocks, "blocks", ext, args));
        break;
      case ".pdf":
        buf = await writePdf(requireField(content.blocks, "blocks", ext, args));
        break;
      case ".xlsx":
        buf = await writeXlsx(requireField(content.sheets, "sheets", ext, args));
        break;
      case ".pptx":
        buf = await writePptx(requireField(content.slides, "slides", ext, args));
        break;
      default:
        throw new Error(
          `Unsupported extension "${ext}" for write_document. Supported: ` +
            `${READABLE_EXTENSIONS.join(", ")}. For text formats such as .md, .txt, or .csv, use write_file.`
        );
    }

    await fs.mkdir(path.dirname(abs), { recursive: true });
    ctx.undo?.snapshot(abs, relPath);
    await writeFileAtomic(abs, buf);
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
    await writeFileAtomic(abs, out);
    const detail = applied.map((a) => `${a.sheet}!${a.cell}=${a.newValue}`).join(", ");
    return `Updated ${applied.length} cell(s) in ${relPath}: ${detail}`;
  },
};

/** Build a validated PdfEdit from the tool arguments. */
function toPdfEdit(args: Record<string, unknown>): PdfEdit {
  const op = String(args.op);
  const asPages = (v: unknown, field: string): number[] => {
    if (!Array.isArray(v) || v.length === 0) {
      throw new Error(`edit_pdf: "${field}" must be a non-empty array of page numbers`);
    }
    return v.map(Number);
  };
  switch (op) {
    case "delete_pages":
      return { op, pages: asPages(args.pages, "pages") };
    case "extract_pages":
      return { op, pages: asPages(args.pages, "pages") };
    case "reorder_pages":
      return { op, order: asPages(args.order, "order") };
    case "rotate_page":
      if (args.page === undefined || args.degrees === undefined) {
        throw new Error('edit_pdf: rotate_page requires "page" and "degrees"');
      }
      return { op, page: Number(args.page), degrees: Number(args.degrees) };
    default:
      throw new Error(`edit_pdf: unknown op "${op}"`);
  }
}

export const editPdfTool: ToolDef = {
  name: "edit_pdf",
  description:
    "Modify the pages of an existing PDF (.pdf) in place: delete_pages, rotate_page, " +
    "reorder_pages, or extract_pages (write chosen pages to a new file). Page numbers are " +
    "1-based. This does structural page operations only — PDF text cannot be reliably " +
    "find-and-replaced. To create a PDF from text, use write_document.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path relative to the workspace root" },
      op: {
        type: "string",
        enum: ["delete_pages", "rotate_page", "reorder_pages", "extract_pages"],
      },
      pages: {
        type: "array",
        items: { type: "number" },
        description: "1-based page numbers, for delete_pages and extract_pages.",
      },
      page: { type: "number", description: "1-based page number, for rotate_page." },
      degrees: {
        type: "number",
        description:
          "Rotation in multiples of 90 (added to the page's current angle), for rotate_page.",
      },
      order: {
        type: "array",
        items: { type: "number" },
        description: "New page order as a permutation of every page 1..N, for reorder_pages.",
      },
      out_path: {
        type: "string",
        description:
          "Destination for extract_pages (a new .pdf); the source file is left unchanged.",
      },
    },
    required: ["path", "op"],
  },
  requiresPermission: true,
  summarize: (args) => `Edit ${args.path} (${args.op})`,
  async preview(args, ctx) {
    try {
      const abs = resolveSafe(ctx.workspace, String(args.path));
      const buf = await fs.readFile(abs);
      const { summary } = await editPdf(buf, toPdfEdit(args));
      return summary;
    } catch (err) {
      return err instanceof Error ? err.message : null;
    }
  },
  async execute(args, ctx) {
    const relPath = String(args.path);
    const abs = resolveSafe(ctx.workspace, relPath);
    if (path.extname(abs).toLowerCase() !== ".pdf") {
      throw new Error(`edit_pdf only supports .pdf files, got "${path.extname(abs)}"`);
    }
    const edit = toPdfEdit(args);
    const buf = await fs.readFile(abs);
    const { buf: out, summary } = await editPdf(buf, edit);

    // extract_pages writes a new file and leaves the source untouched; every other op edits in place.
    if (edit.op === "extract_pages") {
      if (args.out_path === undefined) throw new Error("extract_pages requires `out_path`");
      const outRel = String(args.out_path);
      const outAbs = resolveSafe(ctx.workspace, outRel);
      if (path.extname(outAbs).toLowerCase() !== ".pdf") {
        throw new Error(`out_path must be a .pdf file, got "${path.extname(outAbs)}"`);
      }
      await fs.mkdir(path.dirname(outAbs), { recursive: true });
      ctx.undo?.snapshot(outAbs, outRel);
      await writeFileAtomic(outAbs, out);
      return `${summary} → ${outRel}`;
    }

    ctx.undo?.snapshot(abs, relPath);
    await writeFileAtomic(abs, out);
    return `${summary} in ${relPath}`;
  },
};

/** The payload field each extension is written from. */
const CONTENT_FIELD: Record<string, keyof DocumentContent> = {
  ".docx": "blocks",
  ".pdf": "blocks",
  ".xlsx": "sheets",
  ".pptx": "slides",
};

/**
 * Pull blocks/sheets/slides out of the arguments however the model arranged
 * them. The documented shape is `{path, content: {slides: [...]}}`, but models
 * routinely flatten it to `{path, slides: [...]}` or send `content` as a JSON
 * string. Rejecting those was a dead end for the caller: the payload was right
 * there and the write failed anyway.
 */
function extractContent(args: Record<string, unknown>): DocumentContent {
  let raw: unknown = args.content;
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch {
      raw = undefined; // fall through to the top-level fields
    }
  }
  const nested = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const pick = (key: keyof DocumentContent): unknown[] | undefined => {
    for (const source of [nested, args]) {
      const value = source[key];
      if (Array.isArray(value) && value.length > 0) return value;
    }
    return undefined;
  };
  return {
    blocks: pick("blocks") as DocumentContent["blocks"],
    sheets: pick("sheets") as DocumentContent["sheets"],
    slides: pick("slides") as DocumentContent["slides"],
  };
}

function requireField<T>(
  value: T[] | undefined,
  fieldName: keyof DocumentContent,
  ext: string,
  args: Record<string, unknown>
): T[] {
  if (!value || value.length === 0) {
    // Name what did arrive: the usual cause is content for a different
    // extension, e.g. `blocks` sent to a .pptx.
    const present = (["blocks", "sheets", "slides"] as const).filter(
      (k) => extractContent(args)[k]?.length
    );
    const mismatch = present.length
      ? ` Received "${present.join('", "')}" instead — that content belongs to ` +
        `${present
          .map((k) =>
            Object.keys(CONTENT_FIELD)
              .filter((e) => CONTENT_FIELD[e] === k)
              .join("/")
          )
          .join(", ")} files.`
      : "";
    throw new Error(
      `write_document: ${ext} files are written from "${fieldName}", which is required and must be ` +
        `non-empty. Pass it as content.${fieldName} (a top-level "${fieldName}" is also accepted).${mismatch}`
    );
  }
  return value;
}
