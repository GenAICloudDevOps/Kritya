import fs from "node:fs/promises";
import type { ToolDef } from "../types.js";
import { writeFileAtomic } from "../atomicWrite.js";
import { resolveSafe, truncateResult } from "./common.js";

/**
 * Jupyter notebooks (.ipynb) are just JSON: a top-level object with a `cells`
 * array. Unlike the Office formats in document.ts — which we can only read
 * whole or rewrite whole — a notebook is edited one cell at a time, and its
 * cell outputs (rendered charts, printed results, error tracebacks) are often
 * the most valuable part of the file. So these tools work per-cell and leave
 * every other cell, and its saved outputs, exactly as they were on disk.
 */

interface NotebookCell {
  cell_type: string;
  source: string | string[];
  outputs?: unknown[];
  execution_count?: number | null;
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
}

interface Notebook {
  cells: NotebookCell[];
  metadata?: Record<string, unknown>;
  nbformat?: number;
  nbformat_minor?: number;
  [key: string]: unknown;
}

/** nbformat stores text as either a single string or an array of lines. */
function joinSource(source: string | string[] | undefined): string {
  if (Array.isArray(source)) return source.join("");
  return source ?? "";
}

/** Store text the way Jupyter does: one array entry per line, newline kept on all but the last. */
function splitSource(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  return lines.map((line, i) => (i < lines.length - 1 ? line + "\n" : line));
}

const MAX_OUTPUT_CHARS = 2000;

/** Collapse one cell's outputs into a short, token-cheap text summary. */
function summarizeOutputs(outputs: unknown[]): string {
  const parts: string[] = [];
  for (const raw of outputs) {
    const out = raw as Record<string, unknown>;
    switch (out.output_type) {
      case "stream":
        parts.push(joinSource(out.text as string | string[]));
        break;
      case "execute_result":
      case "display_data": {
        const data = (out.data ?? {}) as Record<string, unknown>;
        if (data["text/plain"]) {
          parts.push(joinSource(data["text/plain"] as string | string[]));
        }
        // Rich outputs (images, HTML) are large and unreadable as text: name them, drop the bytes.
        for (const mime of Object.keys(data)) {
          if (mime !== "text/plain") parts.push(`[${mime} output]`);
        }
        break;
      }
      case "error": {
        const ename = String(out.ename ?? "Error");
        const evalue = String(out.evalue ?? "");
        parts.push(`${ename}: ${evalue}`);
        if (Array.isArray(out.traceback)) {
          parts.push((out.traceback as string[]).join("\n"));
        }
        break;
      }
      default:
        break;
    }
  }
  const text = parts.join("\n").trimEnd();
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  return (
    text.slice(0, MAX_OUTPUT_CHARS) +
    `\n... [output truncated, ${text.length - MAX_OUTPUT_CHARS} more characters]`
  );
}

/**
 * Cell *output* text is already capped post-parse (MAX_OUTPUT_CHARS above),
 * but nothing bounded the input file itself — a pathologically large
 * .ipynb (corrupt, or a runaway export) would otherwise be read and
 * JSON.parse'd whole regardless of size. Real notebooks are nowhere near
 * this large even with heavy output.
 */
const MAX_NOTEBOOK_FILE_BYTES = 50 * 1024 * 1024;

async function loadNotebook(abs: string): Promise<Notebook> {
  const { size } = await fs.stat(abs);
  if (size > MAX_NOTEBOOK_FILE_BYTES) {
    throw new Error(
      `Notebook file is ${Math.round(size / (1024 * 1024))}MB, over the ` +
        `${MAX_NOTEBOOK_FILE_BYTES / (1024 * 1024)}MB limit for reading a .ipynb file.`
    );
  }
  const text = await fs.readFile(abs, "utf8");
  let nb: Notebook;
  try {
    nb = JSON.parse(text) as Notebook;
  } catch {
    throw new Error("File is not valid JSON — a .ipynb notebook must be a JSON document");
  }
  if (!Array.isArray(nb.cells)) {
    throw new Error("Not a valid notebook: missing a top-level `cells` array");
  }
  return nb;
}

async function saveNotebook(abs: string, nb: Notebook): Promise<void> {
  // Jupyter writes notebooks with 1-space indent and a trailing newline; match it to keep diffs small.
  await writeFileAtomic(abs, JSON.stringify(nb, null, 1) + "\n");
}

export const readNotebookTool: ToolDef = {
  name: "read_notebook",
  description:
    "Read a Jupyter notebook (.ipynb) and return a clean, per-cell view: each cell's index, " +
    "type (code/markdown/raw), source, and a compacted summary of its outputs. Large binary " +
    "outputs like images are shown as placeholders rather than raw data. Use the cell index " +
    "shown here with edit_notebook.",
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
    const abs = resolveSafe(ctx.workspace, String(args.path));
    const nb = await loadNotebook(abs);

    const parts: string[] = [];
    nb.cells.forEach((cell, i) => {
      const type = cell.cell_type ?? "code";
      const exec =
        type === "code" && cell.execution_count != null ? ` (exec ${cell.execution_count})` : "";
      parts.push(`[${i}] ${type}${exec}`);
      parts.push(joinSource(cell.source));
      if (type === "code" && Array.isArray(cell.outputs) && cell.outputs.length > 0) {
        const summary = summarizeOutputs(cell.outputs);
        if (summary) {
          parts.push("--- output ---");
          parts.push(summary);
        }
      }
      parts.push("");
    });
    return truncateResult(parts.join("\n").trimEnd());
  },
};

export const editNotebookTool: ToolDef = {
  name: "edit_notebook",
  description:
    "Edit a single cell of a Jupyter notebook (.ipynb) in place, leaving all other cells and " +
    "their saved outputs untouched. op=replace changes a cell's source (and clears that cell's " +
    "stale outputs); op=insert adds a new cell at the given index; op=delete removes the cell at " +
    "the given index. Cell indexes match what read_notebook prints. This does not run any code.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path relative to the workspace root" },
      op: { type: "string", enum: ["replace", "insert", "delete"] },
      index: {
        type: "number",
        description:
          "Target cell index. For insert, the new cell is placed at this index (use the cell count to append at the end).",
      },
      source: {
        type: "string",
        description: "New cell text. Required for replace and insert; ignored for delete.",
      },
      cell_type: {
        type: "string",
        enum: ["code", "markdown", "raw"],
        description: "Cell type for insert (default code), or to change a cell's type on replace.",
      },
    },
    required: ["path", "op", "index"],
  },
  requiresPermission: true,
  summarize: (args) => `Edit ${args.path} (${args.op} cell ${args.index})`,
  async preview(args) {
    const op = String(args.op);
    if (op === "delete") return `Delete cell ${args.index}`;
    const src = String(args.source ?? "");
    const preview = src.length > 200 ? src.slice(0, 200) + "…" : src;
    return `${op} cell ${args.index}:\n${preview}`;
  },
  async execute(args, ctx) {
    const relPath = String(args.path);
    const abs = resolveSafe(ctx.workspace, relPath);
    const op = String(args.op);
    const index = Number(args.index);
    if (!Number.isInteger(index) || index < 0) {
      throw new Error(`index must be a non-negative integer, got ${args.index}`);
    }

    const nb = await loadNotebook(abs);
    const cells = nb.cells;

    switch (op) {
      case "replace": {
        if (index >= cells.length) {
          throw new Error(`Cannot replace cell ${index}: notebook has ${cells.length} cell(s)`);
        }
        if (args.source === undefined) throw new Error("replace requires `source`");
        const cell = cells[index];
        cell.source = splitSource(String(args.source));
        if (args.cell_type !== undefined) cell.cell_type = String(args.cell_type);
        // The stored source no longer matches these outputs, so clear them.
        if (cell.cell_type === "code") {
          cell.outputs = [];
          cell.execution_count = null;
        } else {
          delete cell.outputs;
          delete cell.execution_count;
        }
        break;
      }
      case "insert": {
        if (index > cells.length) {
          throw new Error(
            `Cannot insert at ${index}: notebook has ${cells.length} cell(s) (max index ${cells.length})`
          );
        }
        if (args.source === undefined) throw new Error("insert requires `source`");
        const cellType = args.cell_type !== undefined ? String(args.cell_type) : "code";
        const cell: NotebookCell = {
          cell_type: cellType,
          source: splitSource(String(args.source)),
          metadata: {},
        };
        if (cellType === "code") {
          cell.outputs = [];
          cell.execution_count = null;
        }
        cells.splice(index, 0, cell);
        break;
      }
      case "delete": {
        if (index >= cells.length) {
          throw new Error(`Cannot delete cell ${index}: notebook has ${cells.length} cell(s)`);
        }
        cells.splice(index, 1);
        break;
      }
      default:
        throw new Error(`Unknown op "${op}". Use replace, insert, or delete.`);
    }

    ctx.undo?.snapshot(abs, relPath);
    await saveNotebook(abs, nb);
    return `${op === "delete" ? "Deleted" : op === "insert" ? "Inserted" : "Replaced"} cell ${index} in ${relPath}`;
  },
};
