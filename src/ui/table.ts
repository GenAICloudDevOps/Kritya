// Render and format GitHub-flavored markdown tables in the terminal.
import { inlineWidth } from "./inline.js";

export type Align = "left" | "right" | "center";

export interface Table {
  header: string[];
  rows: string[][];
  align: Align[];
}

/** Gap between columns, in spaces. */
export const COLUMN_GAP = 2;
/** A column squeezed below this is unreadable — stack the table instead. */
export const MIN_READABLE_COLUMN = 14;
/** More columns than this and a grid is unreadable at any sane terminal width. */
export const MAX_GRID_COLUMNS = 5;

const DELIMITER_CELL = /^:?-+:?$/;

/** Cells may carry their own line breaks: models emit <br> inside them constantly. */
function normalizeCell(cell: string): string {
  return cell
    .replace(/<br\s*\/?>/gi, "\n")
    .split("\n")
    .map((s) => s.trim())
    .join("\n")
    .trim();
}

export function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);

  const cells: string[] = [];
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\\" && s[i + 1] === "|") {
      cur += "|";
      i++;
      continue;
    }
    if (s[i] === "|") {
      cells.push(cur);
      cur = "";
      continue;
    }
    cur += s[i];
  }
  cells.push(cur);
  return cells.map(normalizeCell);
}

export function isTableRow(line: string): boolean {
  return line.includes("|") && splitRow(line).length >= 2;
}

function isDelimiterRow(line: string): boolean {
  if (!line.includes("|")) return false;
  const cells = splitRow(line);
  return cells.length >= 2 && cells.every((c) => DELIMITER_CELL.test(c));
}

function alignOf(cell: string): Align {
  const left = cell.startsWith(":");
  const right = cell.endsWith(":");
  if (left && right) return "center";
  if (right) return "right";
  return "left";
}

/**
 * Recognise a GFM table starting at `lines[start]`. A delimiter row is
 * required, so ordinary prose containing a pipe is never mistaken for one.
 * Returns the index to resume parsing from.
 */
export function detectTable(lines: string[], start: number): { table: Table; next: number } | null {
  if (start + 1 >= lines.length) return null;
  if (!isTableRow(lines[start]) || !isDelimiterRow(lines[start + 1])) return null;

  const header = splitRow(lines[start]);
  const delimiter = splitRow(lines[start + 1]);
  if (delimiter.length !== header.length) return null;

  // Once the header and delimiter have committed, any following line with a
  // pipe belongs to the table — including ragged ones with too few cells.
  const rows: string[][] = [];
  let i = start + 2;
  while (i < lines.length && lines[i].includes("|")) {
    rows.push(fit(splitRow(lines[i]), header.length));
    i++;
  }

  return { table: { header, rows, align: delimiter.map(alignOf) }, next: i };
}

function fit(cells: string[], n: number): string[] {
  if (cells.length === n) return cells;
  if (cells.length > n) {
    // Keep overflow visible rather than dropping it on the floor.
    return [...cells.slice(0, n - 1), cells.slice(n - 1).join(" | ")];
  }
  return [...cells, ...Array(n - cells.length).fill("")];
}

/** What each column would take if nothing had to give. */
function naturalWidths(table: Table): number[] {
  return table.header.map((cell, c) =>
    Math.max(inlineWidth(cell), ...table.rows.map((r) => inlineWidth(r[c] ?? "")), 1)
  );
}

/**
 * Column widths that fit `maxWidth` display columns. Over budget, the widest
 * columns give ground first; their cells then wrap internally, which is what
 * keeps the row itself from wrapping and destroying the alignment.
 */
export function columnWidths(table: Table, maxWidth: number): number[] {
  const n = table.header.length;
  const widths = naturalWidths(table);

  const gaps = COLUMN_GAP * (n - 1);
  const budget = Math.max(n, maxWidth - gaps);
  const shrinkTo = (floor: number) => {
    let total = widths.reduce((a, b) => a + b, 0);
    while (total > budget) {
      let idx = 0;
      for (let i = 1; i < n; i++) if (widths[i] > widths[idx]) idx = i;
      if (widths[idx] <= floor) return;
      widths[idx]--;
      total--;
    }
  };

  shrinkTo(8);
  shrinkTo(1);
  return widths;
}

/**
 * Whether a grid is hopeless at this width. Judged against what the table
 * actually needs, not a fixed terminal width — a two-column table of short
 * cells reads fine in a narrow terminal, and a six-column one never does.
 */
export function shouldStack(table: Table, maxWidth: number): boolean {
  if (table.header.length > MAX_GRID_COLUMNS) return true;
  const needed = naturalWidths(table).reduce(
    (total, w) => total + Math.min(w, MIN_READABLE_COLUMN),
    COLUMN_GAP * (table.header.length - 1)
  );
  return needed > maxWidth;
}

/**
 * While a response is still streaming, hold back a trailing run of table-ish
 * lines that has not yet produced a delimiter row — otherwise it renders as
 * raw pipes for a moment and then snaps into a grid.
 */
export function dropPartialTrailingTable(lines: string[]): string[] {
  let start = lines.length;
  while (start > 0 && isTableRow(lines[start - 1])) start--;
  if (start === lines.length) return lines;
  return detectTable(lines, start) ? lines : lines.slice(0, start);
}
