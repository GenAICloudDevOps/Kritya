import React from "react";
import { Box, Text } from "ink";

// Dot-matrix glyphs (7 rows). "#" is an on pixel, "." is off.
const GLYPHS: Record<string, string[]> = {
  C: [".####.", "#....#", "#.....", "#.....", "#.....", "#....#", ".####."],
  O: [".####.", "#....#", "#....#", "#....#", "#....#", "#....#", ".####."],
  D: ["#####.", "#....#", "#....#", "#....#", "#....#", "#....#", "#####."],
  E: ["######", "#.....", "#.....", "#####.", "#.....", "#.....", "######"],
  L: ["#.....", "#.....", "#.....", "#.....", "#.....", "#.....", "######"],
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

// Vertical gradient: cyan at the top fading into NVIDIA green.
const TOP_RGB = [0x00, 0xd9, 0xff];
const BOTTOM_RGB = [0x76, 0xb9, 0x00];

function rowColor(row: number): string {
  const t = row / (ROWS - 1);
  const [r, g, b] = TOP_RGB.map((c, i) => Math.round(c + (BOTTOM_RGB[i] - c) * t));
  return `#${[r, g, b].map((c) => c.toString(16).padStart(2, "0")).join("")}`;
}

export function Banner({ subtitle }: { subtitle?: string }) {
  const columns = process.stdout.columns ?? 80;
  const wide = bannerLines("CODE-CLI", "░░");
  const narrow = bannerLines("CODE-CLI", "░");
  const lines = wide[0].length <= columns ? wide : narrow[0].length <= columns ? narrow : null;

  const center = (text: string) =>
    " ".repeat(Math.max(0, Math.floor((columns - text.length) / 2))) + text;

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
          {center("CODE-CLI")}
        </Text>
      )}
      <Box marginTop={2}>
        {subtitle ? <Text dimColor>{center(subtitle)}</Text> : null}
      </Box>
    </Box>
  );
}
