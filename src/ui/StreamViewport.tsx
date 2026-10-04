import { type ReactNode } from "react";
import { Box } from "ink";
import { streamRows } from "./viewport.js";

/**
 * Holds a streaming answer to the rows left under the live region, scrolling
 * to its tail as it grows.
 *
 * Ink erases its live region by rewinding a line count, which can only reach
 * what is still on screen. Let the streaming text grow past the terminal's
 * height and the erase silently comes up short, stranding a partial copy in
 * the scrollback — then the finished message prints below it and the answer
 * appears twice. Capping the live region keeps the erase exact; the whole
 * answer is printed once when the turn ends.
 *
 * This used to be done by hand: word-wrap every line to estimate the rows it
 * would render at, then slice off the tail that didn't fit. Ink 8 renders
 * `maxHeight` and `overflow="hidden"` natively, so the box does the capping.
 *
 * `justifyContent="flex-end"` is what pins the view to the tail: a column
 * whose content overflows a capped height lines up against its end, keeping
 * the newest text visible. It costs nothing while the answer still fits — the
 * box is then only as tall as its content and the text grows downward as you
 * would expect. `flexShrink={0}` on the content is what makes that work: Yoga
 * would otherwise shrink the child back down to the cap, leaving the top on
 * screen and the tail cut off.
 */
export function StreamViewport({ rows, children }: { rows: number; children: ReactNode }) {
  return (
    <Box
      flexDirection="column"
      maxHeight={streamRows(rows)}
      overflow="hidden"
      justifyContent="flex-end"
      marginBottom={1}
    >
      <Box flexDirection="column" flexShrink={0}>
        {children}
      </Box>
    </Box>
  );
}
