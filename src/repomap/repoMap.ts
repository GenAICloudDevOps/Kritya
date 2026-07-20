/**
 * Repo map: a cheap, whole-repository structural skeleton fed to the model so
 * it can orient itself in an unfamiliar or large codebase without reading every
 * file. It lists source files ranked by importance, each with its definition
 * signatures (from symbols.ts) but no bodies. This is the low-cost half of
 * semantic codebase navigation — no embeddings, no index to keep in sync, no
 * data leaving the machine — and covers the large majority of "where does X
 * live" questions on its own. The model calls read_file for the actual bodies.
 */

import fs from "node:fs/promises";
import path from "node:path";
import fg from "fast-glob";
import { isPathSafe, resolveSafe } from "../tools/common.js";
import { loadIgnorePatterns } from "../tools/ignore.js";
import { CODE_EXTENSIONS, extractSymbols, type CodeSymbol } from "./symbols.js";

export interface RepoMapOptions {
  /** Hard cap on files read (ranked by path first, so the important ones survive the cap). */
  maxFiles?: number;
  /** Hard cap on the rendered output length, in characters. */
  maxOutputChars?: number;
  /** Cap on signatures shown per file. */
  maxSymbolsPerFile?: number;
}

const DEFAULTS = { maxFiles: 2000, maxOutputChars: 20_000, maxSymbolsPerFile: 40 };
/** Skip files larger than this — generated bundles, vendored blobs, etc. */
const MAX_FILE_BYTES = 512 * 1024;

/** Directory segments that mark low-signal files: ranked down, never up. */
const DEMOTE_SEGMENTS = new Set([
  "test",
  "tests",
  "__tests__",
  "spec",
  "specs",
  "fixtures",
  "fixture",
  "mocks",
  "__mocks__",
  "vendor",
  "third_party",
  "generated",
  "gen",
  "dist",
  "build",
  "out",
  "examples",
  "example",
]);

/** Directory segments that mark primary source: ranked up. */
const PROMOTE_SEGMENTS = new Set(["src", "lib", "app", "pkg", "cmd", "internal", "core"]);

/** Filenames (sans extension) that tend to be entry points: ranked up. */
const ENTRYPOINT_NAMES = new Set(["index", "main", "mod", "lib", "app", "server", "cli", "init"]);

function extname(rel: string): string {
  const dot = rel.lastIndexOf(".");
  return dot === -1 ? "" : rel.slice(dot + 1).toLowerCase();
}

/**
 * A path-only importance score, computed before reading any file so the
 * `maxFiles` cap keeps the most relevant files on a huge repo. Higher is more
 * important.
 */
function pathScore(rel: string): number {
  const segments = rel.split(/[\\/]/);
  const name = segments[segments.length - 1];
  const stem = name.slice(0, name.length - extname(name).length - 1);
  let score = 0;
  for (const seg of segments.slice(0, -1)) {
    const lower = seg.toLowerCase();
    if (DEMOTE_SEGMENTS.has(lower)) score -= 4;
    if (PROMOTE_SEGMENTS.has(lower)) score += 3;
  }
  if (ENTRYPOINT_NAMES.has(stem.toLowerCase())) score += 2;
  if (/\.(min|bundle|generated|gen)\./i.test(name) || name.endsWith(".d.ts")) score -= 4;
  // Shallower files are usually more central; a gentle nudge, not a dominant term.
  score -= (segments.length - 1) * 0.2;
  return score;
}

interface MappedFile {
  rel: string;
  symbols: CodeSymbol[];
  score: number;
}

/** Render one file's block: its path, then its indented signatures. */
function renderFile(file: MappedFile): string {
  const minIndent = Math.min(...file.symbols.map((s) => s.indent));
  const lines = file.symbols.map((s) => {
    const level = Math.min(Math.round((s.indent - minIndent) / 2), 4);
    return `${"  ".repeat(level + 1)}${s.text}`;
  });
  return `${file.rel.replaceAll("\\", "/")}\n${lines.join("\n")}`;
}

/**
 * Build the repo map for `workspace` (optionally scoped to `subdir`). Returns a
 * ready-to-show string; always bounded in size (never throws on a large repo —
 * it caps files and output and reports what it omitted).
 */
export async function buildRepoMap(
  workspace: string,
  subdir = ".",
  options: RepoMapOptions = {}
): Promise<string> {
  const opts = { ...DEFAULTS, ...options };
  const root = resolveSafe(workspace, subdir || ".");
  const scopeLabel = path.relative(workspace, root) || "(workspace root)";

  const found = await fg("**/*", {
    cwd: root,
    dot: false,
    onlyFiles: true,
    followSymbolicLinks: false,
    ignore: ["**/node_modules/**", "**/.git/**", ...loadIgnorePatterns(workspace)],
    suppressErrors: true,
  });

  // Keep only source files, then rank by path so the maxFiles cap (which bounds
  // how many files we actually read) retains the most important ones.
  const candidates = found
    .filter((f) => CODE_EXTENSIONS.has(extname(f)))
    .map((f) => ({ rel: path.join(path.relative(workspace, root), f), local: f }))
    .filter((c) => isPathSafe(workspace, path.join(root, c.local)))
    .map((c) => ({ ...c, ps: pathScore(c.rel) }))
    .sort((a, b) => b.ps - a.ps);

  const totalSource = candidates.length;
  const scanned = candidates.slice(0, opts.maxFiles);

  const mapped: MappedFile[] = [];
  for (const c of scanned) {
    const abs = path.join(root, c.local);
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
    const symbols = extractSymbols(content, extname(c.local), opts.maxSymbolsPerFile);
    if (!symbols.length) continue;
    // Final score blends the path score with a modest bonus for structural
    // density, so a central file full of definitions sorts above a stub.
    const score = c.ps + Math.min(symbols.length, 20) * 0.25;
    mapped.push({ rel: c.rel, symbols, score });
  }

  if (!mapped.length) {
    const reason =
      totalSource === 0
        ? "no source files found"
        : "no definitions were extracted (unsupported languages, or files without top-level definitions)";
    return `Repo map for ${scopeLabel}: ${reason}. Use glob/grep to explore instead.`;
  }

  mapped.sort((a, b) => b.score - a.score);

  const header =
    `Repo map for ${scopeLabel} — structural skeleton (definition signatures only, no bodies). ` +
    `Ranked by importance; call read_file for full code.`;

  const blocks: string[] = [];
  let used = header.length;
  let shown = 0;
  for (const file of mapped) {
    const block = renderFile(file);
    if (shown > 0 && used + block.length + 2 > opts.maxOutputChars) break;
    blocks.push(block);
    used += block.length + 2;
    shown++;
  }

  const omitted = mapped.length - shown;
  const cappedNote =
    totalSource > scanned.length
      ? ` ${totalSource - scanned.length} lower-ranked file(s) were not scanned.`
      : "";
  const footer =
    omitted > 0
      ? `\n\n… ${omitted} more mapped file(s) not shown (output limit). Re-run repo_map with a path to focus, or use grep/read_file.${cappedNote}`
      : cappedNote
        ? `\n${cappedNote.trim()}`
        : "";

  return `${header} Showing ${shown} of ${mapped.length} file(s).\n\n${blocks.join("\n\n")}${footer}`;
}
