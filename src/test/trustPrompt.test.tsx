import assert from "node:assert/strict";
import { test } from "node:test";
import { render } from "ink-testing-library";
import type { ReactElement } from "react";
import { TrustPrompt } from "../ui/TrustPrompt.js";

async function renderReady(el: ReactElement) {
  const instance = render(el);
  await new Promise((r) => setImmediate(r));
  return instance;
}

async function press(stdin: { write(data: string): void }, key: string) {
  stdin.write(key);
  await new Promise((r) => setImmediate(r));
}

/** Whether Ink colors its output depends on the real terminal, not this test's mocked stdout. */
function plain(frame: string | undefined): string {
  // eslint-disable-next-line no-control-regex -- stripping real ANSI escapes, not an accident
  return (frame ?? "").replace(/\x1B\[[0-9;]*m/g, "");
}

test("shows the workspace path and the untrusted-content warning", async () => {
  const { lastFrame } = await renderReady(
    <TrustPrompt workspace="/home/user/proj" preview={'allow: ["*"]'} onDecision={() => {}} />
  );
  const frame = plain(lastFrame());
  assert.match(frame, /Untrusted workspace settings/);
  assert.match(frame, /\/home\/user\/proj/);
});

test("selecting 'Trust this workspace' calls onDecision(true)", async () => {
  let trusted: boolean | undefined;
  const { stdin } = await renderReady(
    <TrustPrompt
      workspace="/ws"
      preview="hooks: {}"
      onDecision={(t) => {
        trusted = t;
      }}
    />
  );
  await press(stdin, "\r");
  assert.equal(trusted, true);
});

test("selecting the second option calls onDecision(false)", async () => {
  let trusted: boolean | undefined;
  const { stdin } = await renderReady(
    <TrustPrompt
      workspace="/ws"
      preview="hooks: {}"
      onDecision={(t) => {
        trusted = t;
      }}
    />
  );
  await press(stdin, "\x1B[B");
  await press(stdin, "\r");
  assert.equal(trusted, false);
});

test("cancelling (escape) counts as not trusting", async () => {
  let trusted: boolean | undefined;
  const { stdin } = await renderReady(
    <TrustPrompt
      workspace="/ws"
      preview="hooks: {}"
      onDecision={(t) => {
        trusted = t;
      }}
    />
  );
  await press(stdin, "\x1B");
  assert.equal(trusted, false);
});

test("a preview longer than 40 lines is truncated with a '… (N more lines)' marker", async () => {
  const preview = Array.from({ length: 55 }, (_, i) => `setting ${i}`).join("\n");
  const { lastFrame } = await renderReady(
    <TrustPrompt workspace="/ws" preview={preview} onDecision={() => {}} />
  );
  const frame = plain(lastFrame());
  assert.match(frame, /setting 39/);
  assert.doesNotMatch(frame, /setting 40\b/);
  assert.match(frame, /… \(15 more lines\)/);
});
