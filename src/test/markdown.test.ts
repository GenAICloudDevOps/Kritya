import assert from "node:assert/strict";
import { test } from "node:test";
import stringWidth from "string-width";
import { inlineWidth, parseInline, tokensWidth, wrapInline } from "../ui/inline.js";
import {
  columnWidths,
  detectTable,
  dropPartialTrailingTable,
  shouldStack,
  splitRow,
} from "../ui/table.js";

/** The table from the bug report: wide "Why" cells, <br>, bold, an emoji header. */
const REAL_TABLE = [
  "| Use Case | Better Choice | Why |",
  "|----------|--------------|-----|",
  "| **Maximizing performance per dollar**<br>(complex coding, research, agentic tasks) | **Opus 5** | Anthropic states it delivers greater performance at a given cost than all other models |",
  "| **Minimizing cost for simpler tasks**<br>(basic Q&A, drafting) | **Sonnet 5** | Current price ($2/$10) is cheaper |",
];

test("bold, italic, code and links lose their markup", () => {
  assert.deepEqual(parseInline("**Opus 5**"), [{ text: "Opus 5", bold: true }]);
  assert.deepEqual(parseInline("*soon*"), [{ text: "soon", italic: true }]);
  assert.deepEqual(parseInline("run `npm test`"), [
    { text: "run " },
    { text: "npm test", code: true },
  ]);
  assert.deepEqual(parseInline("[docs](https://x.dev)"), [
    { text: "docs" },
    { text: " (https://x.dev)", dim: true },
  ]);
});

test("emphasis markers that are not emphasis stay literal", () => {
  assert.deepEqual(parseInline("2 * 3 * 4"), [{ text: "2 * 3 * 4" }]);
  assert.deepEqual(parseInline("glob **/*.ts here"), [{ text: "glob **/*.ts here" }]);
  assert.deepEqual(parseInline("`a ** b`"), [{ text: "a ** b", code: true }]);
});

test("HTML entities are decoded, except inside code spans", () => {
  // &#124; is how a model escapes a pipe it wants shown inside a table cell.
  assert.deepEqual(parseInline("a &#124; b"), [{ text: "a | b" }]);
  assert.deepEqual(parseInline("&amp; &lt;tag&gt; &quot;q&quot; &#x2713;"), [
    { text: '& <tag> "q" ✓' },
  ]);
  assert.deepEqual(parseInline("`&amp;`"), [{ text: "&amp;", code: true }]);
  // A decoded entity must not become markup: &#42; is a literal asterisk.
  assert.deepEqual(parseInline("&#42;not italic&#42;"), [{ text: "*not italic*" }]);
  // Anything unrecognised is left exactly as written.
  assert.deepEqual(parseInline("R&D and &nope; stay"), [{ text: "R&D and &nope; stay" }]);
});

test("long URLs break after a separator rather than mid-segment", () => {
  const lines = wrapInline("https://example.com/very/long/path/that/goes/on/and/on/forever", 24);
  const text = lines.map((l) => l.map((t) => t.text).join(""));
  for (const line of text) assert.ok(line.length <= 24);
  assert.equal(text.join(""), "https://example.com/very/long/path/that/goes/on/and/on/forever");
  assert.ok(
    text.slice(0, -1).every((l) => /[/\-_.?&=]$/.test(l)),
    `every break lands on a separator: ${JSON.stringify(text)}`
  );
});

test("width is measured on what is displayed, not on the source", () => {
  assert.equal(inlineWidth("**Opus 5**"), "Opus 5".length);
  assert.equal(inlineWidth("`code`"), "code".length);
  // Emoji and CJK take two cells each; using .length here would misalign columns.
  assert.equal(inlineWidth("🎯"), 2);
  assert.equal(inlineWidth("価格"), 4);
});

test("wrapping keeps every line inside the width, including long words", () => {
  for (const width of [8, 20, 33]) {
    const lines = wrapInline(
      "Anthropic states it delivers greater performance https://example.com/a/very/long/url/indeed",
      width
    );
    for (const line of lines)
      assert.ok(tokensWidth(line) <= width, `line over ${width}: ${JSON.stringify(line)}`);
  }
});

test("wrapping preserves hard line breaks and emphasis", () => {
  const lines = wrapInline("**Maximizing cost**\n(complex tasks)", 40);
  assert.equal(lines.length, 2);
  assert.deepEqual(lines[0], [{ text: "Maximizing cost", bold: true }]);
  assert.equal(lines[1].map((t) => t.text).join(""), "(complex tasks)");
});

test("cells split on pipes, unescape \\| and turn <br> into a line break", () => {
  assert.deepEqual(splitRow("| a | b | c |"), ["a", "b", "c"]);
  assert.deepEqual(splitRow("a | b"), ["a", "b"]);
  assert.deepEqual(splitRow("| a \\| b | c |"), ["a | b", "c"]);
  assert.deepEqual(splitRow("| one<br>two | <br/>three |"), ["one\ntwo", "three"]);
});

test("a table needs a delimiter row — prose with a pipe is not a table", () => {
  assert.equal(detectTable(["| just | text |", "more prose"], 0), null);
  assert.equal(detectTable(["run a | b to pipe", "and then this"], 0), null);
  assert.equal(detectTable(["| a | b |"], 0), null);
});

test("a real table is detected with its alignment and row count", () => {
  const found = detectTable(REAL_TABLE, 0);
  assert.ok(found);
  assert.deepEqual(found.table.header, ["Use Case", "Better Choice", "Why"]);
  assert.equal(found.table.rows.length, 2);
  assert.deepEqual(found.table.align, ["left", "left", "left"]);
  assert.equal(found.next, REAL_TABLE.length);
});

test("alignment comes from the delimiter row", () => {
  const found = detectTable(["| a | b | c |", "|:---|---:|:--:|"], 0);
  assert.deepEqual(found?.table.align, ["left", "right", "center"]);
});

test("ragged rows are padded, never dropped", () => {
  const found = detectTable(["| a | b |", "|---|---|", "| only |", "| x | y | z |"], 0);
  assert.deepEqual(found?.table.rows, [
    ["only", ""],
    ["x", "y | z"],
  ]);
});

test("columns fit the terminal width at every size", () => {
  const { table } = detectTable(REAL_TABLE, 0)!;
  for (const width of [60, 80, 120, 200]) {
    const widths = columnWidths(table, width);
    const total = widths.reduce((a, b) => a + b, 0) + 2 * (widths.length - 1);
    assert.ok(total <= width, `total ${total} over ${width}`);
    assert.ok(
      widths.every((w) => w >= 1),
      "every column keeps at least one cell"
    );
  }
});

test("a table that already fits is not squeezed", () => {
  const { table } = detectTable(["| a | b |", "|---|---|", "| xx | yyy |"], 0)!;
  assert.deepEqual(columnWidths(table, 80), [2, 3]);
});

test("cells wrap inside their column, so a row never wraps", () => {
  const { table } = detectTable(REAL_TABLE, 0)!;
  const width = 80;
  const widths = columnWidths(table, width);
  for (const row of [table.header, ...table.rows]) {
    row.forEach((cell, c) => {
      for (const line of wrapInline(cell, widths[c])) {
        assert.ok(tokensWidth(line) <= widths[c], `cell ${c} overflows its column`);
      }
    });
  }
});

test("emoji cells still fit their column", () => {
  const { table } = detectTable(["| 🎯 Goal | 価格 |", "|---|---|", "| 🚀🚀 ship | 高い |"], 0)!;
  const widths = columnWidths(table, 80);
  assert.deepEqual(widths, [stringWidth("🚀🚀 ship"), 4]);
});

test("a grid is abandoned only when this table can't fit at this width", () => {
  const { table } = detectTable(REAL_TABLE, 0)!;
  assert.equal(shouldStack(table, 40), true, "three wide columns can't fit 40");
  assert.equal(shouldStack(table, 80), false);

  // Short cells read fine in a narrow terminal — don't stack them.
  const small = detectTable(["| Left | Right |", "|---|---|", "| 42 | ok |"], 0)!.table;
  assert.equal(shouldStack(small, 40), false);

  const wide = detectTable(["| a | b | c | d | e | f |", "|---|---|---|---|---|---|"], 0)!.table;
  assert.equal(shouldStack(wide, 200), true, "six columns never read as a grid");
});

test("a half-arrived table is held back while streaming, then rendered", () => {
  const partial = ["Here is the comparison:", "| Use Case | Why |"];
  assert.deepEqual(dropPartialTrailingTable(partial), ["Here is the comparison:"]);

  const withDelimiter = [...partial, "|---|---|"];
  assert.deepEqual(dropPartialTrailingTable(withDelimiter), withDelimiter);

  const noTable = ["just prose", "more prose"];
  assert.deepEqual(dropPartialTrailingTable(noTable), noTable);
});
