import stringWidth from "string-width";
import { truncateToWidth } from "./inline.js";

/**
 * Windowing and width-fitting for every list in the UI: the Ctrl+P palette,
 * the inline `/` suggestions, the history search, the model picker, and the
 * permission/trust prompts. They were each written separately and each one
 * grew its own way of not fitting on screen — some wrapped a long row onto a
 * second line, and the long ones (a bare `/` is 33 commands plus group
 * headings) simply ran off the bottom of the terminal with no way to scroll.
 *
 * Kept pure and React-free so the arithmetic is testable on its own, and so
 * the renderers only have to decide what a row looks like, never how much of
 * it fits.
 */

/** Columns the selection marker (`"❯ "` / `"  "`) occupies at the start of a row. */
export const ROW_GUTTER = 2;

/** What sits between a row's label and its hint. */
export const ROW_SEPARATOR = " — ";

/**
 * The label keeps at least this many columns before a hint is allowed any
 * space — below it the label alone is more use than a two-letter stub plus a
 * truncated hint.
 */
const MIN_LABEL = 8;

/** Under this a hint is dropped outright rather than squeezed to a stub. */
const MIN_HINT = 8;

/** Chrome a list should leave alone by default: prompt box, hints, status line. */
const DEFAULT_RESERVED_ROWS = 10;

export interface WindowedList<T> {
  /** The rows to render, in order. */
  visible: T[];
  /** Index into `visible` of the highlighted row. */
  cursor: number;
  /** 1-based index of the first visible row, or 0 for an empty list. */
  from: number;
  /** 1-based index of the last visible row, or 0 for an empty list. */
  to: number;
  /** Rows in the whole list, before windowing. */
  total: number;
  /** True when the list is longer than the window, i.e. it scrolls. */
  clipped: boolean;
}

/**
 * Rows a list may occupy: the terminal, less the chrome around it.
 *
 * The floor is deliberately low rather than generous — a very short terminal
 * should still show a usable list instead of collapsing to nothing, and the
 * caller can always pass an explicit `maxRows` when it knows its own layout.
 */
export function listRows(terminalRows: number, reserved = DEFAULT_RESERVED_ROWS): number {
  return Math.max(3, Math.floor(terminalRows) - Math.max(0, Math.floor(reserved)));
}

/**
 * The slice of `items` to render, plus where the cursor sits inside it.
 *
 * The window is centred on the cursor and then clamped to the ends, which
 * makes it a pure function of the cursor — there is no scroll offset to carry
 * between renders, so a list can never get stuck scrolled away from the row
 * it is highlighting. Centring also means moving within the first page does
 * not shift the list at all, and the last row is reachable without the window
 * running off the bottom.
 */
export function windowList<T>(items: T[], cursor: number, maxRows: number): WindowedList<T> {
  const total = items.length;
  const rows = Math.max(1, Math.floor(maxRows));
  if (total === 0) {
    return { visible: [], cursor: 0, from: 0, to: 0, total: 0, clipped: false };
  }
  // `cursor` can be stale — items shrink under a live filter — so clamp it
  // rather than trust it, exactly like the renderers used to do by hand.
  const at = Math.min(Math.max(Math.floor(cursor), 0), total - 1);
  const offset = Math.min(Math.max(at - Math.floor(rows / 2), 0), Math.max(0, total - rows));
  const visible = items.slice(offset, offset + rows);
  return {
    visible,
    cursor: at - offset,
    from: offset + 1,
    to: offset + visible.length,
    total,
    clipped: visible.length < total,
  };
}

/** A row's label and hint, each cut to fit the space available for them. */
export interface FittedRow {
  label: string;
  hint?: string;
}

/**
 * Fit one row into `width` display columns, cutting the *hint* before the
 * label: the label is what identifies the row, so a long description must
 * never be the reason a command's name is unreadable. When there is no room
 * for both, the hint goes entirely.
 *
 * `width` is what is left after the gutter, and may be unknown (-1, or 0 from
 * a terminal that has not reported a size yet) — in which case the row is
 * returned untouched and the renderer's `wrap="truncate"` backstop takes over.
 */
export function fitRow(label: string, hint: string | undefined, width: number): FittedRow {
  if (width <= 0) return { label, hint };
  if (!hint) return { label: truncateToWidth(label, width), hint: undefined };

  const sepWidth = stringWidth(ROW_SEPARATOR);
  const labelWidth = stringWidth(label);

  if (width < MIN_LABEL + sepWidth + MIN_HINT) {
    return { label: truncateToWidth(label, width), hint: undefined };
  }
  if (labelWidth + sepWidth + MIN_HINT <= width) {
    return { label, hint: truncateToWidth(hint, width - labelWidth - sepWidth) };
  }

  // The label itself has to give ground, but never below MIN_LABEL's worth of
  // room for the hint to be worth showing at all.
  const fittedLabel = truncateToWidth(label, width - sepWidth - MIN_HINT);
  const rest = width - stringWidth(fittedLabel) - sepWidth;
  return {
    label: fittedLabel,
    hint: rest >= MIN_HINT ? truncateToWidth(hint, rest) : undefined,
  };
}
