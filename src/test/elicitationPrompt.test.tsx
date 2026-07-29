import assert from "node:assert/strict";
import { test } from "node:test";
import { render } from "ink-testing-library";
import type { ReactElement } from "react";
import { ElicitationPrompt } from "../ui/ElicitationPrompt.js";
import type { ElicitationResult } from "../types.js";

async function renderReady(el: ReactElement) {
  const instance = render(el);
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  return instance;
}

async function press(stdin: { write(data: string): void }, key: string) {
  stdin.write(key);
  await new Promise((r) => setImmediate(r));
  // Ink buffers a lone ESC byte for pendingInputFlushDelayMilliseconds (20ms) to see
  // whether more bytes follow as part of a longer escape sequence.
  await new Promise((r) => setTimeout(r, 25));
}

/** Whether Ink colors its output depends on the real terminal, not this test's mocked stdout. */
function plain(frame: string | undefined): string {
  // eslint-disable-next-line no-control-regex -- stripping real ANSI escapes, not an accident
  return (frame ?? "").replace(/\x1B\[[0-9;]*m/g, "");
}

test("shows the message and resolves accept with the filled boolean field on submit", async () => {
  let result: ElicitationResult | undefined;
  const { stdin, lastFrame } = await renderReady(
    <ElicitationPrompt
      message="Enable verbose logging?"
      fields={[{ name: "verbose", kind: "boolean", label: "Verbose" }]}
      onDecision={(r) => {
        result = r;
      }}
    />
  );
  assert.match(plain(lastFrame()), /Enable verbose logging\?/);
  await press(stdin, "\r"); // "Yes" is the first/highlighted option
  assert.deepEqual(result, { action: "accept", content: { verbose: true } });
});

test("resolves cancel on escape", async () => {
  let result: ElicitationResult | undefined;
  const { stdin } = await renderReady(
    <ElicitationPrompt
      message="q"
      fields={[]}
      onDecision={(r) => {
        result = r;
      }}
    />
  );
  await press(stdin, "\x1B");
  assert.deepEqual(result, { action: "cancel" });
});
