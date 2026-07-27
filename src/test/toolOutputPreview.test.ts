import assert from "node:assert/strict";
import { test } from "node:test";
import { toolOutputPreview } from "../ui/toolOutputPreview.js";

test("short, non-error output is shown in full, up to 3 lines", () => {
  const out = toolOutputPreview("line one\nline two", false, 80);
  assert.equal(out, "line one\nline two");
});

test("non-error output beyond 3 lines is truncated with a '+N lines' marker", () => {
  const lines = Array.from({ length: 10 }, (_, i) => `line ${i}`);
  const out = toolOutputPreview(lines.join("\n"), false, 80);
  assert.equal(out, "line 0\nline 1\nline 2\n… (+7 lines · Ctrl+O)");
});

test("error output keeps up to 8 lines instead of 3", () => {
  const lines = Array.from({ length: 10 }, (_, i) => `line ${i}`);
  const out = toolOutputPreview(lines.join("\n"), false, 80, true);
  assert.equal(out, [...lines.slice(0, 8), "… (+2 lines · Ctrl+O)"].join("\n"));
});

test("verbose mode returns every line with no truncation marker", () => {
  const lines = Array.from({ length: 10 }, (_, i) => `line ${i}`);
  const out = toolOutputPreview(lines.join("\n"), true, 80);
  assert.equal(out, lines.join("\n"));
});

test("leading blank lines are dropped", () => {
  const out = toolOutputPreview("\n\n  \nreal content", false, 80);
  assert.equal(out, "real content");
});

test("trailing whitespace on the whole block is stripped", () => {
  const out = toolOutputPreview("content\n\n  ", false, 80);
  assert.equal(out, "content");
});

test("shared leading indentation is stripped from every line", () => {
  const out = toolOutputPreview("    one\n    two\n    three", false, 80);
  assert.equal(out, "one\ntwo\nthree");
});

test("indentation is only stripped up to what every line shares", () => {
  const out = toolOutputPreview("  one\n    two", false, 80);
  assert.equal(out, "one\n  two");
});

test("tabs after a line-number prefix become a single space; other tabs expand to two", () => {
  const out = toolOutputPreview("12\tconst x = 1;\nplain\ttext", false, 80);
  assert.equal(out, "12 const x = 1;\nplain  text");
});

test("the untrusted-content fence markers are filtered out entirely", () => {
  const out = toolOutputPreview(
    "<<<external_untrusted_content\nreal line\n<<<end_external_untrusted_content",
    false,
    80
  );
  assert.equal(out, "real line");
});

test("lines wider than the given width are truncated with an ellipsis", () => {
  const out = toolOutputPreview("a".repeat(50), false, 10);
  assert.equal(out.length, 10);
  assert.match(out, /…$/);
});

test("empty output produces an empty preview", () => {
  assert.equal(toolOutputPreview("", false, 80), "");
});
