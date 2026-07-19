import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { lspManager } from "../lsp/manager.js";
import type { LspDiagnostic, LspLocation } from "../lsp/client.js";
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
