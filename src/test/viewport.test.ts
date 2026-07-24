import assert from "node:assert/strict";
import { test } from "node:test";
import { tailForViewport } from "../ui/viewport.js";

test("short text is left alone", () => {
  const text = "one\ntwo\nthree";
  assert.equal(tailForViewport(text, 80, 40), text);
});

test("a long answer is cut to the tail that fits the viewport", () => {
  const lines = Array.from({ length: 200 }, (_, i) => `line ${i}`);
  const out = tailForViewport(lines.join("\n"), 80, 24).split("\n");

  assert.ok(out.length <= 24 - 8, `kept ${out.length} lines for 16 rows`);
  assert.equal(out[out.length - 1], "line 199", "the newest text is what's shown");
});

test("wrapped lines are counted as the rows they really occupy", () => {
  const wide = Array.from({ length: 50 }, () => "x".repeat(240));
  const out = tailForViewport(wide.join("\n"), 80, 24).split("\n");
  // Each line is three rows at 80 columns, so only a handful fit in 16.
  assert.ok(out.length <= 6, `kept ${out.length} triple-height lines`);
});

test("a cut inside a code fence reopens it", () => {
  // The opening fence is far enough up that the cut lands below it.
  const lines = ["```ts", ...Array.from({ length: 100 }, (_, i) => `const a${i} = ${i};`)];
  const out = tailForViewport(lines.join("\n"), 80, 24);
  assert.ok(out.startsWith("```"), "the tail opens a fence it was cut inside of");
  assert.ok(out.includes("const a99 = 99;"), "and still ends with the newest line");
});

test("a cut below a closed fence does not reopen one", () => {
  const lines = [
    "```ts",
    "const a = 1;",
    "```",
    ...Array.from({ length: 100 }, (_, i) => `prose ${i}`),
  ];
  const out = tailForViewport(lines.join("\n"), 80, 24);
  assert.equal(out.startsWith("```"), false);
});

test("a very short terminal still shows something", () => {
  const lines = Array.from({ length: 50 }, (_, i) => `line ${i}`);
  const out = tailForViewport(lines.join("\n"), 80, 4).split("\n");
  assert.ok(out.length >= 4);
});

test("row counting matches how the text actually wraps, not width/columns", () => {
  // Twelve 9-column words: character math says 108/40 = 3 rows, but word
  // wrapping needs 4. Counting low is what left a stray line on screen.
  const line = Array.from({ length: 12 }, () => "wordwords").join(" ");
  const kept = tailForViewport([line, line, line, line, line].join("\n"), 40, 24).split("\n");
  const rows = kept.reduce((n, l) => n + Math.ceil(l.length / 40), 0);
  assert.ok(rows <= 24, `estimated ${rows} rows for a 24-row terminal`);
});

test("table rows are budgeted for their wrapped height", () => {
  const table = Array.from({ length: 20 }, (_, i) => `| cell ${i} | second column | third |`);
  const kept = tailForViewport(table.join("\n"), 80, 24).split("\n");
  assert.ok(kept.length <= 5, `kept ${kept.length} table rows, each up to 3 tall`);
});
