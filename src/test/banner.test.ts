import assert from "node:assert/strict";
import { test } from "node:test";
import { bannerLines } from "../ui/Banner.js";

/**
 * bannerLines() is the only piece of Banner.tsx that's pure and
 * side-effect-free — everything else is Ink JSX that needs a renderer
 * (ink-testing-library isn't a project dependency), so this is the safe,
 * deterministic slice to cover directly, same scoping call as mcpCommand.ts.
 */

test("bannerLines renders 7 rows for a single known glyph", () => {
  const lines = bannerLines("K", "#");
  assert.equal(lines.length, 7);
  assert.equal(lines[0], "#    #");
  assert.equal(lines[3], "###   ");
});

test("bannerLines concatenates glyphs left to right with an off-pixel gap", () => {
  const lines = bannerLines("KR", "#");
  assert.equal(lines[0], "#    # ##### ");
});

test("an unrecognized character falls back to the '-' glyph", () => {
  const lines = bannerLines("Z", "#");
  assert.deepEqual(lines, bannerLines("-", "#"));
});

test("a wider pixel string scales every on-pixel and off-pixel gap", () => {
  const lines = bannerLines("T", "##");
  assert.equal(lines[0], "############");
  assert.equal(lines[1], "    ####    ");
});

test("every row has the same length for a multi-character banner", () => {
  const lines = bannerLines("KRITYA", "░");
  const width = lines[0].length;
  for (const line of lines) assert.equal(line.length, width);
});
