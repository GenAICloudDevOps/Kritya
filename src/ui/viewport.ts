import { wrapInline } from "./inline.js";

/** Rows below the streaming region: prompt, status line, spinner, breathing room. */
const RESERVED_ROWS = 8;
/** Never collapse the live view to nothing, however short the terminal. */
const MIN_ROWS = 4;
/**
 * Rows held back against an estimate that comes in low. Underestimating by
 * even one row brings back the bug this file exists to prevent, and the only
 * cost of overestimating is showing slightly less of the live text.
 */
const SAFETY_ROWS = 4;
/** Columns the renderer itself works in: the terminal, less its padding. */
const RENDER_INSET = 2;
/** A table row wraps its cells; assume the worst rather than guess low. */
const TABLE_ROW_HEIGHT = 3;

/**
 * Terminal rows a line will occupy once rendered. Measured with the same
 * word-wrapping the renderer uses — dividing width by columns assumes words
 * can be split mid-word, which under-counts every wrapped paragraph.
 */
function rowsFor(line: string, columns: number): number {
  const width = Math.max(1, columns - RENDER_INSET);
  const wrapped = wrapInline(line, width).length;
  return line.includes("|") ? Math.max(wrapped, TABLE_ROW_HEIGHT) : Math.max(1, wrapped);
}

/**
 * The tail of a streaming answer that fits the viewport.
 *
 * Ink erases its live region by rewinding a line count, which can only reach
 * what is still on screen. Let the streaming text grow past the terminal's
 * height and the erase silently comes up short, stranding a partial copy in
 * the scrollback — then the finished message prints below it and the answer
 * appears twice. Showing only what fits keeps the erase exact; the whole
 * answer is printed once when the turn ends.
 */
export function tailForViewport(text: string, columns: number, rows: number): string {
  const budget = Math.max(MIN_ROWS, rows - RESERVED_ROWS - SAFETY_ROWS);
  const lines = text.split("\n");

  let used = 0;
  let start = lines.length;
  while (start > 0) {
    const next = used + rowsFor(lines[start - 1], columns);
    if (next > budget) break;
    used = next;
    start--;
  }
  if (start === 0) return text;

  const tail = lines.slice(start);
  // Reopen a fence the cut landed inside, so the tail doesn't render as prose.
  const fencesDropped = lines.slice(0, start).filter((l) => l.trimStart().startsWith("```")).length;
  return fencesDropped % 2 === 1 ? `\`\`\`\n${tail.join("\n")}` : tail.join("\n");
}
