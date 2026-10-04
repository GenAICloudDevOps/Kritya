import { useLayoutEffect, useRef, useState } from "react";
import { Box, Text, measureElement, useCursor, useInput, usePaste, type DOMElement } from "ink";
import stringWidth from "string-width";
import wrapAnsi from "wrap-ansi";

export interface TextInputProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit?: (value: string) => void;
  /** Shown, dimmed, while the field is empty. */
  placeholder?: string;
  /** Rendered in place of each character — for secrets. */
  mask?: string;
  /** Whether this field owns the keyboard and the terminal cursor. */
  isActive?: boolean;
}

/**
 * Where the caret lands in already-rendered text: the row and column the
 * terminal cursor has to sit on once the text wraps.
 *
 * Wrapped with the very same call ink makes when it lays the text out
 * (`wrapText` → `wrapAnsi(text, width, { trim: false, hard: true })`), so the
 * two can't disagree about where a line breaks. Re-deriving the break point by
 * dividing the column count would: `wrapAnsi` leaves the space that ends a
 * wrapped line on that line, so a greedy wrapper lands the next line one column
 * to the left and the caret drifts a cell per wrap.
 *
 * One deliberate approximation: a line that fills the width exactly reports
 * `col === width`, i.e. the column just past its last character. That is where
 * the terminal's own pending-wrap cursor sits, and the alternative — jumping to
 * column 0 of the following row — is just as defensible and just as wrong the
 * other half of the time.
 */
export function caretAt(before: string, width: number): { row: number; col: number } {
  const lines = wrapAnsi(before, Math.max(1, width), { trim: false, hard: true }).split("\n");
  const last = lines[lines.length - 1] ?? "";
  return { row: lines.length - 1, col: stringWidth(last) };
}

/**
 * The prompt's text field.
 *
 * Hand-rolled rather than borrowed from ink-text-input, for two reasons that
 * both come down to ink 8 finally exposing the terminal cursor. `useCursor`
 * puts the *real* cursor at the caret, which is what an IME needs to place its
 * composition popup — ink-text-input fakes the cursor with a reverse-video
 * character, so typing Chinese, Japanese or Korean puts the popup in the wrong
 * place. And `usePaste` turns on bracketed paste, so a pasted block arrives as
 * one marked string we can normalize, instead of a run of raw keystrokes whose
 * carriage returns survive into the prompt and into the message sent to the
 * model.
 */
export function TextInput({
  value,
  onChange,
  onSubmit,
  placeholder,
  mask,
  isActive = true,
}: TextInputProps) {
  const [cursor, setCursorOffset] = useState(value.length);
  const [origin, setOrigin] = useState<{ x: number; y: number; width: number } | null>(null);
  const boxRef = useRef<DOMElement | null>(null);
  const { setCursorPosition } = useCursor();

  // The caller owns the value, so it can move under us — cleared on submit,
  // replaced by history recall. Clamping during render rather than in an effect
  // keeps the caret correct in the same pass.
  const offset = Math.min(cursor, value.length);
  const display = mask ? mask.repeat(value.length) : value;
  const beforeCaret = mask ? mask.repeat(offset) : display.slice(0, offset);

  // Re-measure after every commit; setOrigin bails out when nothing moved, so
  // a steady prompt re-renders zero extra times. Ink computes layout in
  // resetAfterCommit, which runs *before* layout effects, so the first pass
  // already sees a real layout. The zero check is belt and braces: a Box that
  // genuinely has no room yet should leave the cursor hidden rather than pin it
  // to the terminal origin.
  useLayoutEffect(() => {
    const node = boxRef.current;
    if (!node) return;
    const { x, y, clientWidth } = measureElement(node);
    if (clientWidth === 0) return;
    setOrigin((prev) =>
      prev && prev.x === x && prev.y === y && prev.width === clientWidth
        ? prev
        : { x, y, width: clientWidth }
    );
  });

  // Publishing the caret has to happen during render. useCursor() forwards it
  // from an insertion effect, which runs *before* layout effects, so a position
  // set from an effect would always reach the terminal one render late — and a
  // cursor that trails the caret by a keystroke is worse than none for an IME.
  if (isActive && origin) {
    const { row, col } = caretAt(beforeCaret, Math.max(1, origin.width));
    setCursorPosition({ x: origin.x + col, y: origin.y + row });
  } else {
    setCursorPosition(undefined);
  }

  useInput(
    (input, key) => {
      // Ctrl/meta chords are the app's shortcuts (Ctrl+K kill switch, Ctrl+O
      // verbose), never text. Swallowing them here is what stops them being
      // typed into the box as a bare letter.
      if (key.ctrl || key.meta) return;
      // Keys the surrounding app owns: up/down drive suggestions and history,
      // Tab completes, Escape cancels.
      if (key.upArrow || key.downArrow || key.tab || key.escape) return;

      if (key.return) {
        onSubmit?.(value);
        return;
      }
      if (key.leftArrow) {
        setCursorOffset(Math.max(0, offset - 1));
        return;
      }
      if (key.rightArrow) {
        setCursorOffset(Math.min(value.length, offset + 1));
        return;
      }
      if (key.home) {
        setCursorOffset(0);
        return;
      }
      if (key.end) {
        setCursorOffset(value.length);
        return;
      }
      // Ink reports these separately — backspace is DEL, forward-delete is
      // CSI 3~ — so they delete on opposite sides of the caret.
      if (key.backspace) {
        if (offset === 0) return;
        onChange(value.slice(0, offset - 1) + value.slice(offset));
        setCursorOffset(offset - 1);
        return;
      }
      if (key.delete) {
        if (offset >= value.length) return;
        onChange(value.slice(0, offset) + value.slice(offset + 1));
        return;
      }
      if (!input) return;

      // Bracketed paste normally routes to usePaste below. A terminal without
      // it still delivers the block here, so normalize on both paths.
      const inserted = input.replace(/\r\n?/g, "\n");
      onChange(value.slice(0, offset) + inserted + value.slice(offset));
      setCursorOffset(offset + inserted.length);
    },
    { isActive }
  );

  usePaste(
    (text) => {
      const inserted = text.replace(/\r\n?/g, "\n");
      onChange(value.slice(0, offset) + inserted + value.slice(offset));
      setCursorOffset(offset + inserted.length);
    },
    { isActive }
  );

  return (
    // flexGrow is load-bearing, not cosmetic. A box that hugs its content
    // reports the *text's* width as its own, so the measured width would track
    // what has been typed instead of the space available to type into — and
    // `caretAt` would wrap against the wrong column. Growing to fill the row
    // makes clientWidth the real budget, whether the field is empty, half full,
    // or already overflowing.
    <Box ref={boxRef} flexGrow={1}>
      {value.length === 0 && placeholder ? (
        <Text dimColor>{placeholder}</Text>
      ) : (
        <Text>{display}</Text>
      )}
    </Box>
  );
}
