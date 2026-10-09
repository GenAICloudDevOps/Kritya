import { useState } from "react";
import { Box, Text, useInput, useWindowSize } from "ink";
import { terminalColumns, terminalRows } from "./viewport.js";
import { fitRow, listRows, ROW_GUTTER, ROW_SEPARATOR, windowList } from "./windowList.js";

export interface SelectItem {
  label: string;
  value: string;
  hint?: string;
}

/**
 * The list every picker in the app renders through — the Ctrl+P palette, the
 * model picker, the permission and trust prompts, the elicitation prompt, and
 * session resume.
 *
 * It measures the terminal itself and windows to fit, so all of those inherit
 * scrolling and row truncation without passing anything: a list longer than
 * the screen scrolls with the cursor kept in view, and a long row is cut
 * instead of wrapping onto a second line. `width`/`maxRows` are there for a
 * caller that knows its own layout better than the terminal size suggests.
 */
export function SelectList({
  items,
  onSelect,
  onCancel,
  width,
  maxRows,
  reservedRows,
}: {
  items: SelectItem[];
  onSelect(value: string): void;
  onCancel?(): void;
  /** Columns a row may occupy. Defaults to the terminal, less this list's chrome. */
  width?: number;
  /** Rows shown before scrolling. Defaults to the terminal, less `reservedRows`. */
  maxRows?: number;
  /** Chrome above and below the list. Defaults to windowList's own reserve. */
  reservedRows?: number;
}) {
  const [rawIndex, setIndex] = useState(0);
  const windowSize = useWindowSize();
  const rows =
    maxRows ??
    (reservedRows === undefined
      ? listRows(terminalRows(windowSize))
      : listRows(terminalRows(windowSize), reservedRows));
  // A row also spends ROW_GUTTER columns on its selection marker, and the
  // border/padding the caller wrapped us in is not ours to know — so leave a
  // couple of columns of slack rather than assume the terminal's full width.
  const rowWidth = (width ?? terminalColumns(windowSize) - 4) - ROW_GUTTER;

  // Items can shrink under us (e.g. a live filter above the list).
  const index = items.length ? Math.min(rawIndex, items.length - 1) : 0;
  const list = windowList(items, index, rows);

  useInput((_input, key) => {
    if (!items.length) {
      if (key.escape && onCancel) onCancel();
      return;
    }
    if (key.upArrow) setIndex((index - 1 + items.length) % items.length);
    else if (key.downArrow) setIndex((index + 1) % items.length);
    else if (key.return) onSelect(items[index].value);
    else if (key.escape && onCancel) onCancel();
  });

  return (
    <Box flexDirection="column">
      {list.visible.map((item, i) => {
        const row = fitRow(item.label, item.hint, rowWidth);
        return (
          // truncate is a backstop: the row must never grow a second line,
          // whatever the width arithmetic does with odd glyphs.
          <Text key={item.value} color={i === list.cursor ? "green" : undefined} wrap="truncate">
            {i === list.cursor ? "❯ " : "  "}
            {row.label}
            {row.hint ? (
              <Text dimColor>
                {ROW_SEPARATOR}
                {row.hint}
              </Text>
            ) : null}
          </Text>
        );
      })}
      {list.clipped ? (
        <Text dimColor>
          {"  "}
          {list.from}–{list.to} of {list.total} · ↑↓ to scroll
        </Text>
      ) : null}
    </Box>
  );
}
