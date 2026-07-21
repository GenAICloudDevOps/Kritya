import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { lspManager } from "../lsp/manager.js";
import type { LspDiagnostic, LspFileEdits, LspLocation, LspPosition } from "../lsp/client.js";
import type { ToolDef } from "../types.js";
import { resolveSafe, truncateResult } from "./common.js";

const MAX_LOCATIONS = 100;

const positionParams = {
  type: "object",
  properties: {
    path: { type: "string", description: "File path relative to the workspace root" },
    line: { type: "number", description: "1-based line number of the symbol" },
    column: {
      type: "number",
      description: "1-based column of a character inside the symbol name",
    },
  },
  required: ["path", "line", "column"],
};

function parsePosition(args: Record<string, unknown>): { line: number; character: number } {
  const line = Number(args.line);
  const column = Number(args.column);
  if (!Number.isInteger(line) || line < 1 || !Number.isInteger(column) || column < 1) {
    throw new Error("line and column must be 1-based positive integers");
  }
  return { line: line - 1, character: column - 1 };
}

/**
 * Render locations as "path:line:col  <source line>". The snippet is read
 * from disk per unique file; files outside the workspace (stdlib,
 * node_modules typings) are still reported by path, just without a snippet
 * guarantee — definitions legitimately live there.
 */
async function formatLocations(workspace: string, locations: LspLocation[]): Promise<string> {
  if (locations.length === 0) return "(no results)";
  const shown = locations.slice(0, MAX_LOCATIONS);
  const fileCache = new Map<string, string[] | null>();
  const lines: string[] = [];
  for (const loc of shown) {
    let abs: string;
    try {
      abs = fileURLToPath(loc.uri);
    } catch {
      lines.push(loc.uri);
      continue;
    }
    const rel = path.relative(workspace, abs);
    const display = rel.startsWith("..") ? abs : rel;
    const line = loc.range.start.line + 1;
    const col = loc.range.start.character + 1;
    if (!fileCache.has(abs)) {
      try {
        fileCache.set(abs, (await fs.readFile(abs, "utf8")).split("\n"));
      } catch {
        fileCache.set(abs, null);
      }
    }
    const snippet = fileCache.get(abs)?.[loc.range.start.line]?.trim().slice(0, 200);
    lines.push(`${display}:${line}:${col}${snippet ? `  ${snippet}` : ""}`);
  }
  if (locations.length > shown.length) {
    lines.push(`... [${locations.length - shown.length} more]`);
  }
  return truncateResult(lines.join("\n"));
}

const SEVERITY = ["error", "warning", "info", "hint"] as const;

function formatDiagnostics(relPath: string, diags: LspDiagnostic[]): string {
  if (diags.length === 0) return `No diagnostics for ${relPath} — the file is clean.`;
  const lines = diags.map((d) => {
    const sev = SEVERITY[(d.severity ?? 1) - 1] ?? "error";
    const line = d.range.start.line + 1;
    const col = d.range.start.character + 1;
    const code = d.code !== undefined ? ` [${d.source ?? ""}${d.source ? ":" : ""}${d.code}]` : "";
    return `${relPath}:${line}:${col} ${sev}: ${d.message.replace(/\s*\n\s*/g, " ")}${code}`;
  });
  return truncateResult(lines.join("\n"));
}

export const lspDefinitionTool: ToolDef = {
  name: "lsp_definition",
  description:
    "Go to the definition of the symbol at a position, resolved semantically by a real " +
    "language server (TypeScript/JavaScript, Python, Go, Rust, C/C++) — unlike grep, this " +
    "follows imports, scopes, and re-exports. Returns 'path:line:col  <code>' locations. " +
    "The first call for a language may take a few seconds while the server indexes the project.",
  parameters: positionParams,
  requiresPermission: false,
  summarize: (args) => `Definition of ${args.path}:${args.line}:${args.column}`,
  async execute(args, ctx) {
    const abs = resolveSafe(ctx.workspace, String(args.path));
    const client = await lspManager.clientFor(ctx.workspace, abs);
    return formatLocations(ctx.workspace, await client.definition(abs, parsePosition(args)));
  },
};

export const lspReferencesTool: ToolDef = {
  name: "lsp_references",
  description:
    "Find all references to the symbol at a position, resolved semantically by a real " +
    "language server — every actual usage site across the project, without the false " +
    "positives of a text search. Returns 'path:line:col  <code>' locations, including the " +
    "declaration.",
  parameters: positionParams,
  requiresPermission: false,
  summarize: (args) => `References to ${args.path}:${args.line}:${args.column}`,
  async execute(args, ctx) {
    const abs = resolveSafe(ctx.workspace, String(args.path));
    const client = await lspManager.clientFor(ctx.workspace, abs);
    return formatLocations(ctx.workspace, await client.references(abs, parsePosition(args)));
  },
};

export const lspDiagnosticsTool: ToolDef = {
  name: "lsp_diagnostics",
  description:
    "Get language-server diagnostics (type errors, unresolved imports, warnings) for a file " +
    "without running a build. Use after editing to verify a change didn't break anything. " +
    "Reads the file from disk, so unsaved concerns don't apply.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path relative to the workspace root" },
    },
    required: ["path"],
  },
  requiresPermission: false,
  summarize: (args) => `Diagnostics for ${args.path}`,
  async execute(args, ctx) {
    const abs = resolveSafe(ctx.workspace, String(args.path));
    const client = await lspManager.clientFor(ctx.workspace, abs);
    const rel = path.relative(ctx.workspace, abs);
    return formatDiagnostics(rel, await client.diagnosticsFor(abs));
  },
};

export const lspHoverTool: ToolDef = {
  name: "lsp_hover",
  description:
    "Show what a symbol resolves to — its type, signature, and doc comment — as computed by a " +
    "real language server, without opening the file it's defined in. Answers 'what is this?' at " +
    "a position: the inferred type of a variable, a function's full signature, an imported " +
    "symbol's origin. Returns the server's markdown/plaintext, or a note if there's nothing there.",
  parameters: positionParams,
  requiresPermission: false,
  summarize: (args) => `Hover ${args.path}:${args.line}:${args.column}`,
  async execute(args, ctx) {
    const abs = resolveSafe(ctx.workspace, String(args.path));
    const client = await lspManager.clientFor(ctx.workspace, abs);
    const text = await client.hover(abs, parsePosition(args));
    return text ? truncateResult(text) : "(no hover information at this position)";
  },
};

/**
 * Apply a set of LSP TextEdits to a document's text. LSP positions are UTF-16
 * code-unit offsets, which is exactly how JS indexes strings, so line/character
 * map onto slice offsets directly. Edits are applied end-first so that earlier
 * edits don't shift the offsets of later ones.
 */
function applyTextEdits(text: string, edits: LspFileEdits["edits"]): string {
  const lineStarts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") lineStarts.push(i + 1);
  }
  const toOffset = (pos: LspPosition): number => {
    const lineStart = lineStarts[pos.line] ?? text.length;
    return Math.min(lineStart + pos.character, text.length);
  };
  const sorted = [...edits].sort((a, b) => toOffset(b.range.start) - toOffset(a.range.start));
  let result = text;
  for (const edit of sorted) {
    const start = toOffset(edit.range.start);
    const end = toOffset(edit.range.end);
    result = result.slice(0, start) + edit.newText + result.slice(end);
  }
  return result;
}

const renameParams = {
  type: "object",
  properties: {
    path: { type: "string", description: "File path relative to the workspace root" },
    line: { type: "number", description: "1-based line number of the symbol" },
    column: {
      type: "number",
      description: "1-based column of a character inside the symbol name",
    },
    new_name: { type: "string", description: "The new name for the symbol" },
  },
  required: ["path", "line", "column", "new_name"],
};

export const lspRenameTool: ToolDef = {
  name: "lsp_rename",
  description:
    "Rename a symbol everywhere it is used, across the whole project, using a real language " +
    "server. Unlike find-and-replace this is semantic: it renames only the actual occurrences " +
    "of THIS symbol — never a same-named but unrelated variable, and never text in comments or " +
    "strings — and updates every file that references it. Point it at any one occurrence " +
    "(definition or use). Writes the edited files to disk and reports what changed.",
  parameters: renameParams,
  requiresPermission: true,
  summarize: (args) => `Rename ${args.path}:${args.line}:${args.column} → ${args.new_name}`,
  async execute(args, ctx) {
    const abs = resolveSafe(ctx.workspace, String(args.path));
    const newName = String(args.new_name);
    if (newName.trim().length === 0) throw new Error("new_name must not be empty");

    const client = await lspManager.clientFor(ctx.workspace, abs);
    const fileEdits = await client.rename(abs, parsePosition(args), newName);
    if (fileEdits.length === 0) {
      return "No rename performed — the symbol at that position can't be renamed (it may be a keyword, literal, or outside a project the server has loaded).";
    }

    // Validate every target up front so a rename is all-or-nothing: resolveSafe
    // rejects anything outside the workspace or matching a secret pattern.
    const targets: { abs: string; rel: string; edits: LspFileEdits["edits"] }[] = [];
    for (const fe of fileEdits) {
      let target: string;
      try {
        target = fileURLToPath(fe.uri);
      } catch {
        throw new Error(`Rename produced an edit for a non-file URI (${fe.uri}); aborted.`);
      }
      const rel = path.relative(ctx.workspace, target);
      // resolveSafe throws for out-of-workspace / sensitive paths — abort the whole rename.
      const safeAbs = resolveSafe(ctx.workspace, rel);
      targets.push({ abs: safeAbs, rel, edits: fe.edits });
    }

    let totalEdits = 0;
    for (const t of targets) {
      const content = await fs.readFile(t.abs, "utf8");
      const updated = applyTextEdits(content, t.edits);
      if (updated === content) continue;
      ctx.undo?.snapshot(t.abs, t.rel);
      await fs.writeFile(t.abs, updated, "utf8");
      totalEdits += t.edits.length;
    }

    const fileList = targets
      .map((t) => `  ${t.rel} (${t.edits.length} edit${t.edits.length === 1 ? "" : "s"})`)
      .join("\n");
    return truncateResult(
      `Renamed to "${newName}" — ${totalEdits} edit${totalEdits === 1 ? "" : "s"} across ` +
        `${targets.length} file${targets.length === 1 ? "" : "s"}:\n${fileList}`
    );
  },
};
