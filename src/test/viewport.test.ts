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
