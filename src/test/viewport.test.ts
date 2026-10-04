import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToString, Text } from "ink";
import { StreamViewport } from "../ui/StreamViewport.js";
import { streamRows, terminalColumns, terminalRows } from "../ui/viewport.js";

test("terminal size falls back to 80x24 when the tty reports nothing", () => {
  assert.equal(terminalColumns(undefined), 80);
  assert.equal(terminalColumns({ columns: 0 }), 80);
  assert.equal(terminalColumns({ columns: 120 }), 120);
  assert.equal(terminalRows(undefined), 24);
  assert.equal(terminalRows({ rows: 0 }), 24);
  assert.equal(terminalRows({ rows: 50 }), 50);
});

test("the streaming region leaves the live UI its rows", () => {
  assert.equal(streamRows(24), 16);
  assert.equal(streamRows(50), 42);
});

test("a very short terminal still gets a usable viewport", () => {
  assert.equal(streamRows(10), 4);
  assert.equal(streamRows(0), 4);
});

const render = (lines: string[], rows: number): string[] => {
  const rendered = renderToString(
    createElement(StreamViewport, {
      rows,
      children: createElement(Text, null, lines.join("\n")),
    }),
    { columns: 80 }
  ).split("\n");
  // The viewport's marginBottom leaves one blank row under it.
  while (rendered.length > 0 && rendered[rendered.length - 1] === "") rendered.pop();
  return rendered;
};

test("a long answer is capped to the viewport, showing its tail", () => {
  // Ink erases its live region by rewinding a line count, so a frame taller
  // than the viewport strands a partial copy in the scrollback and the answer
  // prints twice. Capping it is what keeps the erase exact — and the newest
  // text is what has to stay on screen while it streams.
  const total = 200;
  const lines = Array.from({ length: total }, (_, i) => `line ${i}`);
  const viewport = streamRows(24);
  const rendered = render(lines, 24);

  assert.equal(rendered.length, viewport, `rendered ${rendered.length} rows`);
  assert.equal(rendered[0], `line ${total - viewport}`, "the view scrolled to the tail");
  assert.equal(rendered[viewport - 1], `line ${total - 1}`, "the newest line is on screen");
});

test("an answer that only just overflows still ends on its newest line", () => {
  const viewport = streamRows(24);
  const lines = Array.from({ length: viewport + 3 }, (_, i) => `line ${i}`);
  const rendered = render(lines, 24);

  assert.equal(rendered.length, viewport);
  assert.equal(rendered[rendered.length - 1], `line ${viewport + 2}`);
});

test("a short answer is left whole, from the top", () => {
  // It must not be pushed to the bottom of the viewport — the box is only as
  // tall as its content while the answer still fits.
  const rendered = render(["one", "two", "three"], 24);

  assert.equal(rendered[0], "one");
  assert.equal(rendered[1], "two");
  assert.equal(rendered[2], "three");
});
