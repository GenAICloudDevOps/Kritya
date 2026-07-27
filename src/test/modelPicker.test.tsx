import assert from "node:assert/strict";
import { test } from "node:test";
import { render } from "ink-testing-library";
import type { ReactElement } from "react";
import { ModelPicker } from "../ui/ModelPicker.js";
import { CURATED_MODELS } from "../config/models.js";

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

test("the currently selected curated model is marked '(current)'", async () => {
  const current = CURATED_MODELS[0];
  const { lastFrame } = await renderReady(
    <ModelPicker current={current.id} customModels={[]} onSelect={() => {}} onCancel={() => {}} />
  );
  assert.match(plain(lastFrame()), new RegExp(`${current.label} \\(current\\)`));
});

test("custom models from config appear alongside the curated list, marked as custom", async () => {
  const { lastFrame } = await renderReady(
    <ModelPicker
      current="nvidia/some-other-model"
      customModels={[{ id: "acme/foo", label: "Foo Model" }]}
      onSelect={() => {}}
      onCancel={() => {}}
    />
  );
  const frame = plain(lastFrame());
  assert.match(frame, /Foo Model/);
  assert.match(frame, /acme\/foo · custom/);
});

test("a custom model with no label falls back to showing its id", async () => {
  const { lastFrame } = await renderReady(
    <ModelPicker
      current=""
      customModels={[{ id: "acme/bar" }]}
      onSelect={() => {}}
      onCancel={() => {}}
    />
  );
  assert.match(plain(lastFrame()), /acme\/bar/);
});

test("selecting the first item calls onSelect with the curated model's id", async () => {
  let selected: string | undefined;
  const { stdin } = await renderReady(
    <ModelPicker
      current=""
      customModels={[]}
      onSelect={(id) => {
        selected = id;
      }}
      onCancel={() => {}}
    />
  );
  await press(stdin, "\r");
  assert.equal(selected, CURATED_MODELS[0].id);
});

test("escape cancels model selection", async () => {
  let cancelled = false;
  const { stdin } = await renderReady(
    <ModelPicker
      current=""
      customModels={[]}
      onSelect={() => {}}
      onCancel={() => {
        cancelled = true;
      }}
    />
  );
  await press(stdin, "\x1B");
  assert.equal(cancelled, true);
});
