import { Box, Text } from "ink";
import { terminalColumns } from "./viewport.js";

// Dot-matrix glyphs (7 rows). "#" is an on pixel, "." is off.
const GLYPHS: Record<string, string[]> = {
  K: ["#....#", "#...#.", "#..#..", "###...", "#..#..", "#...#.", "#....#"],
  R: ["#####.", "#....#", "#....#", "#####.", "#..#..", "#...#.", "#....#"],
  T: ["######", "..##..", "..##..", "..##..", "..##..", "..##..", "..##.."],
  Y: ["#....#", "#....#", ".#..#.", "..##..", "..##..", "..##..", "..##.."],
  A: [".####.", "#....#", "#....#", "######", "#....#", "#....#", "#....#"],
  I: ["####", ".##.", ".##.", ".##.", ".##.", ".##.", "####"],
  "-": ["....", "....", "....", "####", "....", "....", "...."],
};

const ROWS = 7;

export function bannerLines(text: string, pixel: string): string[] {
  const off = " ".repeat(pixel.length);
  const lines: string[] = [];
  for (let row = 0; row < ROWS; row++) {
    lines.push(
      [...text]
        .map((ch) =>
          (GLYPHS[ch] ?? GLYPHS["-"])[row]
            .split("")
            .map((p) => (p === "#" ? pixel : off))
            .join("")
        )
        .join(off)
    );
  }
  return lines;
}

/** Column (within a bannerLines() row) where each character of `text` starts. */
function letterOffsets(text: string, pixelLen: number): number[] {
  const offsets: number[] = [];
  let col = 0;
  [...text].forEach((ch, i) => {
    if (i > 0) col += pixelLen;
    offsets.push(col);
    col += (GLYPHS[ch] ?? GLYPHS["-"])[0].length * pixelLen;
  });
  return offsets;
}

/** Width (in bannerLines() columns) of one glyph. */
function letterWidth(ch: string, pixelLen: number): number {
  return (GLYPHS[ch] ?? GLYPHS["-"])[0].length * pixelLen;
}

// Vertical gradient: cyan at the top fading into NVIDIA green.
const TOP_RGB = [0x00, 0xd9, 0xff];
const BOTTOM_RGB = [0x76, 0xb9, 0x00];

function rowColor(row: number): string {
  const t = row / (ROWS - 1);
  const [r, g, b] = TOP_RGB.map((c, i) => Math.round(c + (BOTTOM_RGB[i] - c) * t));
  return `#${[r, g, b].map((c) => c.toString(16).padStart(2, "0")).join("")}`;
}

const BETA_LABEL = "beta";

export function Banner({ subtitle }: { subtitle?: string }) {
  const columns = terminalColumns(process.stdout);
  const wide = bannerLines("KRITYA", "░░");
  const narrow = bannerLines("KRITYA", "░");
  const pixelLen = wide[0].length <= columns ? 2 : narrow[0].length <= columns ? 1 : 0;
  const lines = pixelLen === 2 ? wide : pixelLen === 1 ? narrow : null;

  const center = (text: string) =>
    " ".repeat(Math.max(0, Math.floor((columns - text.length) / 2))) + text;

  // Right-align "beta" under the final "A" of KRITYA, one line below the glyph.
  const betaLine = (() => {
    if (!lines) return null;
    const leftPad = Math.max(0, Math.floor((columns - lines[0].length) / 2));
    const aStart = letterOffsets("KRITYA", pixelLen)[5];
    const aWidth = letterWidth("A", pixelLen);
    const indent = leftPad + aStart + Math.max(0, aWidth - BETA_LABEL.length);
    return " ".repeat(indent) + BETA_LABEL;
  })();

  return (
    <Box flexDirection="column" marginTop={2} marginBottom={1}>
      {lines ? (
        lines.map((line, i) => (
          <Text key={i} color={rowColor(i)}>
            {center(line)}
          </Text>
        ))
      ) : (
        <Text bold color="cyan">
          {center("KRITYA")}
        </Text>
      )}
      {betaLine ? <Text dimColor>{betaLine}</Text> : null}
      <Box marginTop={2}>{subtitle ? <Text dimColor>{center(subtitle)}</Text> : null}</Box>
      <Text dimColor>{center("AI can make mistakes. Verify important output.")}</Text>
    </Box>
  );
}
