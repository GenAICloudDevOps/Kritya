import stringWidth from "string-width";

/** Rows below the streaming region: prompt, status line, spinner, breathing room. */
const RESERVED_ROWS = 8;
/** Never collapse the live view to nothing, however short the terminal. */
const MIN_ROWS = 4;

/** Terminal rows a line will occupy once wrapped to `columns`. */
function rowsFor(line: string, columns: number): number {
  return Math.max(1, Math.ceil(stringWidth(line) / Math.max(1, columns)));
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
  const budget = Math.max(MIN_ROWS, rows - RESERVED_ROWS);
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
