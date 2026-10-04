import assert from "node:assert/strict";
import { test } from "node:test";
import { setStderrSink, writeStderr } from "../stderr.js";

/**
 * Run `fn` with process.stderr.write replaced, restoring it afterwards even if
 * `fn` throws. Returns everything written through the real stream.
 */
function captureStderr(fn: () => void): string[] {
  const written: string[] = [];
  const original = process.stderr.write;
  process.stderr.write = ((chunk: string) => {
    written.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    fn();
  } finally {
    process.stderr.write = original;
  }
  return written;
}

test("writeStderr falls back to the real stream when no UI is mounted", () => {
  setStderrSink(undefined);
  const written = captureStderr(() => writeStderr("kritya: boom\n"));
  assert.deepEqual(written, ["kritya: boom\n"]);
});

test("writeStderr routes through the registered sink instead of the stream", () => {
  const sunk: string[] = [];
  setStderrSink((text) => sunk.push(text));
  try {
    const written = captureStderr(() => writeStderr("kritya: routed\n"));
    // Ink's writer is the only thing that should see it; going to the raw
    // stream as well is exactly the frame-corrupting double write this avoids.
    assert.deepEqual(sunk, ["kritya: routed\n"]);
    assert.deepEqual(written, []);
  } finally {
    setStderrSink(undefined);
  }
});

test("a sink that throws still gets the warning out through the stream", () => {
  setStderrSink(() => {
    throw new Error("terminal is gone");
  });
  try {
    const written = captureStderr(() => writeStderr("kritya: rescued\n"));
    assert.deepEqual(written, ["kritya: rescued\n"]);
  } finally {
    setStderrSink(undefined);
  }
});

test("clearing the sink restores the raw stream", () => {
  const sunk: string[] = [];
  setStderrSink((text) => sunk.push(text));
  writeStderr("while mounted\n");
  setStderrSink(undefined);
  const written = captureStderr(() => writeStderr("after unmount\n"));
  assert.deepEqual(sunk, ["while mounted\n"]);
  assert.deepEqual(written, ["after unmount\n"]);
});
