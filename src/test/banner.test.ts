import assert from "node:assert/strict";
import { test } from "node:test";
import { bannerLines, sweepColor, TAGLINE } from "../ui/Banner.js";

/**
 * bannerLines() and sweepColor() are the only pieces of Banner.tsx that are
 * pure and side-effect-free — everything else is Ink JSX that needs a renderer
 * (ink-testing-library isn't a project dependency), so these are the safe,
 * deterministic slices to cover directly, same scoping call as mcpCommand.ts.
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

test("the tagline sweep starts at the glyphs' cyan and ends at their green", () => {
  const n = TAGLINE.length;
  assert.equal(sweepColor(0, n), "#00d9ff");
  assert.equal(sweepColor(n - 1, n), "#76b900");
});

test("a single-character tagline sits at the cyan end instead of dividing by zero", () => {
  assert.equal(sweepColor(0, 1), "#00d9ff");
});

test("the sweep is monotonic, so no character doubles back on the ramp", () => {
  // cyan (0,217,255) -> nvidia green (118,185,0): red climbs while green and
  // blue both fall, so "towards green" here means a *lower* green channel.
  const n = TAGLINE.length;
  const channels = (i: number) => {
    const hex = sweepColor(i, n);
    return [1, 3, 5].map((k) => parseInt(hex.slice(k, k + 2), 16));
  };
  for (let i = 1; i < n; i++) {
    const [r0, g0, b0] = channels(i - 1);
    const [r1, g1, b1] = channels(i);
    assert.ok(r1 >= r0, `red fell back at index ${i}`);
    assert.ok(g1 <= g0, `green rose at index ${i}`);
    assert.ok(b1 <= b0, `blue rose at index ${i}`);
  }
});

test("every character of the tagline gets a well-formed hex colour", () => {
  for (let i = 0; i < TAGLINE.length; i++) {
    assert.match(sweepColor(i, TAGLINE.length), /^#[0-9a-f]{6}$/);
  }
});
