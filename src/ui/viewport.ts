/**
 * Rows the live region below the streaming answer needs: the prompt box, the
 * spinner and steer input, the status line, and a little breathing room. The
 * live answer is clipped to what is left, so the prompt stays on screen while
 * it streams.
 */
const RESERVED_ROWS = 8;
/** Never collapse the live view to nothing, however short the terminal. */
const MIN_ROWS = 4;

/**
 * The terminal's size, falling back to 80x24 when it isn't known.
 *
 * `columns` is 0 — not undefined — whenever Node can't get a window size from
 * the tty (a pty opened without one, some CI runners, a few terminal
 * emulators mid-resize). `?? 80` sails straight past that and hands the
 * callers a 0, which after subtracting a margin clamps to the 20-column floor:
 * Ink still draws its frames 80 wide (it uses `|| 80`), so the prose inside
 * them wrapped into a narrow ribbon. Matching Ink's own fallback keeps the two
 * in agreement.
 */
export function terminalColumns(stdout?: { columns?: number }): number {
  return stdout?.columns || 80;
}

export function terminalRows(stdout?: { rows?: number }): number {
  return stdout?.rows || 24;
}

/**
 * Rows the streaming answer may occupy: the terminal, less the live region
 * that has to stay visible below it.
 *
 * This used to be the budget for slicing the answer by hand — wrapping every
 * line to estimate the rows it would render at, then keeping the tail that
 * fit. Ink 8 clips a `<Box>` natively (see StreamViewport.tsx), so the only
 * thing left to decide is how much room the live region gets.
 */
export function streamRows(rows: number): number {
  return Math.max(MIN_ROWS, rows - RESERVED_ROWS);
}
