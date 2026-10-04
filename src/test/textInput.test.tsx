import assert from "node:assert/strict";
import { test } from "node:test";
import { useState } from "react";
import { Box, Text } from "ink";
import { render } from "ink-testing-library";
import type { ReactElement } from "react";
import { TextInput, caretAt } from "../ui/TextInput.js";

/**
 * What the prompt glyph and field actually render to, with the escape codes
 * stripped — whether Ink colors its output depends on the real terminal, not
 * this test's mocked stdout.
 */
function field(frame: string | undefined): string {
  // eslint-disable-next-line no-control-regex -- stripping real ANSI escapes, not an accident
  const plain = (frame ?? "").replace(/\x1B\[[0-9;]*m/g, "");
  return plain.replace(/^\u276F /, "").trimEnd();
}

async function renderReady(el: ReactElement) {
  const instance = render(el);
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  return instance;
}

async function press(stdin: { write(data: string): void }, key: string) {
  stdin.write(key);
  await new Promise((r) => setImmediate(r));
  // Ink buffers a lone ESC byte for pendingInputFlushDelayMilliseconds (20ms) to
  // see whether more bytes follow as part of a longer escape sequence.
  await new Promise((r) => setTimeout(r, 25));
}

async function type(stdin: { write(data: string): void }, text: string) {
  for (const ch of text) await press(stdin, ch);
}

const submitted: { value?: string } = {};

function Harness({ mask, placeholder }: { mask?: string; placeholder?: string }) {
  const [value, setValue] = useState("");
  return (
    <Box>
      <Text>{"\u276F "}</Text>
      <TextInput
        value={value}
        onChange={setValue}
        onSubmit={(v) => {
          submitted.value = v;
        }}
        mask={mask}
        placeholder={placeholder}
      />
    </Box>
  );
}

function setup(props: { mask?: string; placeholder?: string } = {}) {
  submitted.value = undefined;
  return renderReady(<Harness {...props} />);
}

// --- caretAt: the pure geometry behind the cursor -------------------------

test("caretAt puts the caret at the end of text that fits on one line", () => {
  assert.deepEqual(caretAt("", 20), { row: 0, col: 0 });
  assert.deepEqual(caretAt("hello", 20), { row: 0, col: 5 });
  assert.deepEqual(caretAt("a".repeat(20), 20), { row: 0, col: 20 });
});

test("caretAt wraps onto the next row once the text overflows", () => {
  assert.deepEqual(caretAt("a".repeat(21), 20), { row: 1, col: 1 });
  assert.deepEqual(caretAt("x".repeat(45), 20), { row: 2, col: 5 });
});

test("caretAt breaks where wrap-ansi breaks, trailing space and all", () => {
  // wrapAnsi leaves the space that ends a wrapped line on that line, so the
  // caret has to measure from 17, not from 16 the way a greedy wrap would.
  assert.deepEqual(caretAt("hello world this is a longer sentence", 20), {
    row: 1,
    col: 17,
  });
});

test("caretAt counts wide characters as two columns", () => {
  assert.deepEqual(caretAt("\u4F60\u597D\u4E16\u754C\u518D\u89C1", 20), { row: 0, col: 12 });
  // 15 pairs of hanzi = 60 columns, so five rows of 14-column budget.
  assert.deepEqual(caretAt("\u4F60\u597D".repeat(15), 14), { row: 4, col: 4 });
});

test("caretAt honours hard line breaks", () => {
  assert.deepEqual(caretAt("line1\nline2\nline3", 20), { row: 2, col: 5 });
  assert.deepEqual(caretAt("abc\n", 20), { row: 1, col: 0 });
});

// --- the field itself ----------------------------------------------------

test("renders what was typed", async () => {
  const { stdin, lastFrame, unmount } = await setup();
  try {
    await type(stdin, "hello");
    assert.equal(field(lastFrame()), "hello");
  } finally {
    unmount();
  }
});

test("backspace deletes behind the caret and delete deletes ahead of it", async () => {
  const { stdin, lastFrame, unmount } = await setup();
  try {
    await type(stdin, "abc");
    await press(stdin, "\x7F"); // backspace
    assert.equal(field(lastFrame()), "ab");

    await press(stdin, "\x1B[D"); // left, caret now between "a" and "b"
    await press(stdin, "\x1B[3~"); // forward delete
    assert.equal(field(lastFrame()), "a");
  } finally {
    unmount();
  }
});

test("arrow, home and end keys move the caret, not the text", async () => {
  const { stdin, lastFrame, unmount } = await setup();
  try {
    await type(stdin, "abc");
    await press(stdin, "\x1B[D");
    await press(stdin, "\x1B[D");
    await type(stdin, "X"); // inserted at offset 1
    assert.equal(field(lastFrame()), "aXbc");

    await press(stdin, "\x1B[H"); // home
    await type(stdin, "S");
    assert.equal(field(lastFrame()), "SaXbc");

    await press(stdin, "\x1B[F"); // end
    await type(stdin, "E");
    assert.equal(field(lastFrame()), "SaXbcE");
  } finally {
    unmount();
  }
});

test("Enter submits the current value", async () => {
  const { stdin, unmount } = await setup();
  try {
    await type(stdin, "run the tests");
    await press(stdin, "\r");
    assert.equal(submitted.value, "run the tests");
  } finally {
    unmount();
  }
});

test("keys the surrounding app owns are left alone", async () => {
  const { stdin, lastFrame, unmount } = await setup();
  try {
    await type(stdin, "ab");
    // Up/down drive suggestion and history navigation, Tab completes, Escape
    // cancels — none of them may land in the buffer.
    await press(stdin, "\x1B[A");
    await press(stdin, "\x1B[B");
    await press(stdin, "\t");
    await press(stdin, "\x1B");
    assert.equal(field(lastFrame()), "ab");
    assert.equal(submitted.value, undefined);
  } finally {
    unmount();
  }
});

test("ctrl chords are swallowed instead of being typed as bare letters", async () => {
  const { stdin, lastFrame, unmount } = await setup();
  try {
    await type(stdin, "ab");
    // Ctrl+O and Ctrl+K are the app's shortcuts; ink-text-input used to echo
    // them into the prompt, which is why App.tsx carried a workaround.
    await press(stdin, "\x0F"); // Ctrl+O
    await press(stdin, "\x0B"); // Ctrl+K
    assert.equal(field(lastFrame()), "ab");
  } finally {
    unmount();
  }
});

test("mask replaces every character, keeping its length", async () => {
  const { stdin, lastFrame, unmount } = await setup({ mask: "*" });
  try {
    await type(stdin, "secret");
    assert.equal(field(lastFrame()), "******");
  } finally {
    unmount();
  }
});

test("placeholder shows only while the field is empty", async () => {
  const { stdin, lastFrame, unmount } = await setup({ placeholder: "type here" });
  try {
    assert.equal(field(lastFrame()), "type here");
    await press(stdin, "h");
    assert.equal(field(lastFrame()), "h");
  } finally {
    unmount();
  }
});

test("a bracketed paste arrives as one block with its line endings normalized", async () => {
  const { stdin, lastFrame, unmount } = await setup();
  try {
    // A terminal in bracketed paste mode wraps the whole clipboard in
    // ESC[200~ … ESC[201~. The carriage returns a Windows clipboard carries have
    // to be gone by the time the value reaches the caller, or they end up in the
    // message sent to the model. The two-space indent on the continuation rows
    // is Ink writing every line of a multi-line <Text> at the field's column,
    // not padding in the value.
    await press(stdin, "\u{1B}[200~line1\r\nline2\rline3\u{1B}[201~");
    assert.equal(field(lastFrame()), "line1\n  line2\n  line3");
  } finally {
    unmount();
  }
});
