import assert from "node:assert/strict";
import { test } from "node:test";
import stringWidth from "string-width";
import { fitRow, listRows, ROW_GUTTER, ROW_SEPARATOR, windowList } from "../ui/windowList.js";

const letters = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"];

test("windowList: an empty list reports zeros rather than a cursor at -1", () => {
  assert.deepEqual(windowList([], 0, 4), {
    visible: [],
    cursor: 0,
    from: 0,
    to: 0,
    total: 0,
    clipped: false,
  });
});

test("windowList: a list that fits is returned whole and is not clipped", () => {
  const w = windowList(["a", "b"], 1, 4);
  assert.deepEqual(w.visible, ["a", "b"]);
  assert.equal(w.cursor, 1);
  assert.equal(w.from, 1);
  assert.equal(w.to, 2);
  assert.equal(w.total, 2);
  assert.equal(w.clipped, false);
});

test("windowList: the cursor is centred, so moving within the first page does not scroll", () => {
  // rows=4 -> half is 2, so rows 0..2 all leave the window at offset 0.
  for (const cursor of [0, 1, 2]) {
    const w = windowList(letters, cursor, 4);
    assert.deepEqual(w.visible, ["a", "b", "c", "d"], `cursor ${cursor}`);
    assert.equal(w.from, 1);
    assert.equal(w.cursor, cursor);
  }
  // One past that and the window starts moving, keeping the cursor mid-list.
  const w = windowList(letters, 3, 4);
  assert.deepEqual(w.visible, ["b", "c", "d", "e"]);
  assert.equal(w.cursor, 2);
  assert.equal(w.from, 2);
  assert.equal(w.to, 5);
});

test("windowList: the last row is reachable without the window running off the end", () => {
  const w = windowList(letters, letters.length - 1, 4);
  assert.deepEqual(w.visible, ["g", "h", "i", "j"]);
  assert.equal(w.cursor, 3);
  assert.equal(w.to, w.total);
  assert.equal(w.clipped, true);
});

test("windowList: a stale or negative cursor is clamped, never used to index", () => {
  // Items shrink under a live filter, so `cursor` can point past the end.
  const past = windowList(letters, 99, 4);
  assert.equal(past.cursor, 3);
  assert.equal(past.to, past.total);

  const negative = windowList(letters, -5, 4);
  assert.equal(negative.cursor, 0);
  assert.equal(negative.from, 1);
});

test("windowList: visible[cursor] is always the item the cursor names", () => {
  for (let cursor = -3; cursor < letters.length + 3; cursor++) {
    for (const rows of [1, 2, 4, 7, 10, 25]) {
      const w = windowList(letters, cursor, rows);
      const at = Math.min(Math.max(cursor, 0), letters.length - 1);
      assert.equal(w.visible[w.cursor], letters[at], `cursor ${cursor}, rows ${rows}`);
      assert.ok(w.visible.length <= Math.max(1, rows), `rows ${rows} overflows`);
    }
  }
});

test("windowList: a degenerate row count still shows one row rather than none", () => {
  const w = windowList(letters, 5, 0);
  assert.deepEqual(w.visible, ["f"]);
  assert.equal(w.cursor, 0);
  assert.equal(w.clipped, true);
});

test("listRows: subtracts the reserved chrome, with a floor so it never collapses", () => {
  assert.equal(listRows(24, 10), 14);
  assert.equal(listRows(40, 8), 32);
  // A tiny terminal still gets a usable list.
  assert.equal(listRows(6, 10), 3);
  assert.equal(listRows(0, 10), 3);
});

test("fitRow: a row that already fits is left alone", () => {
  assert.deepEqual(fitRow("/flow-spec", "write the spec", 76), {
    label: "/flow-spec",
    hint: "write the spec",
  });
});

test("fitRow: no hint means the label gets the whole width", () => {
  assert.deepEqual(fitRow("/export", undefined, 40), { label: "/export", hint: undefined });
  assert.equal(fitRow("/export", undefined, 5).label, "/exp…");
});

test("fitRow: a long hint is cut and the label is untouched", () => {
  const row = fitRow("/flow-spec", "x".repeat(200), 40);
  assert.equal(row.label, "/flow-spec");
  assert.equal(stringWidth(row.hint!), 40 - 10 - 3);
  assert.ok(row.hint!.endsWith("…"));
});

test("fitRow: a long label gives ground but still keeps the hint", () => {
  const label = `/${"n".repeat(60)}`;
  const row = fitRow(label, "hint", 40);
  assert.ok(stringWidth(row.label) <= 40 - 3 - 8);
  assert.ok(row.label.endsWith("…"));
  assert.equal(row.hint, "hint");
  // The space left for the hint is what is left after the label, so a hint
  // that does not fit there is cut rather than allowed to push the row over.
  const long = fitRow(label, "a short hint that will not fit", 40);
  assert.ok(stringWidth(long.hint!) <= 40 - stringWidth(long.label) - 3);
});

test("fitRow: too narrow for both, the hint goes rather than being stubbed", () => {
  // 13 < MIN_LABEL + separator + MIN_HINT, so there is no honest way to show both.
  const row = fitRow("/flow-brainstorm", "start a new-project workflow", 13);
  assert.equal(row.hint, undefined);
  assert.equal(row.label, "/flow-brains…");
});

test("fitRow: an unknown width leaves the row for the renderer's backstop", () => {
  // A terminal that has not reported a size yet hands us 0; cutting to it
  // would blank the row instead of letting Ink truncate it.
  assert.deepEqual(fitRow("/export", "export the transcript", 0), {
    label: "/export",
    hint: "export the transcript",
  });
  assert.deepEqual(fitRow("/export", "export the transcript", -1), {
    label: "/export",
    hint: "export the transcript",
  });
});

test("fitRow: widths are display columns, not code points", () => {
  // Three CJK glyphs are six columns wide, so the hint gets 11 and not 14.
  const row = fitRow("日本語", "x".repeat(50), 20);
  assert.equal(row.label, "日本語");
  assert.equal(stringWidth(row.hint!), 20 - 6 - 3);
});

test("fitRow: the row never exceeds the width it was given", () => {
  const labels = ["/export", "/flow-brainstorm", `/${"n".repeat(60)}`, "日本語のコマンド"];
  const hints = [
    undefined,
    "short",
    "a much longer description that will not fit at all",
    "日本語の説明",
  ];
  for (const label of labels) {
    for (const hint of hints) {
      for (let width = 19; width <= 80; width++) {
        const row = fitRow(label, hint, width);
        const total =
          stringWidth(row.label) +
          (row.hint === undefined ? 0 : stringWidth(ROW_SEPARATOR) + stringWidth(row.hint));
        assert.ok(total <= width, `"${label}" / "${hint}" at ${width} gave ${total}`);
        assert.ok(ROW_GUTTER + total <= width + ROW_GUTTER);
      }
    }
  }
});
