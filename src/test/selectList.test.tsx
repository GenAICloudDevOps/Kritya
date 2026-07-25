import assert from "node:assert/strict";
import { test } from "node:test";
import { render } from "ink-testing-library";
import type { ReactElement } from "react";
import { SelectList } from "../ui/SelectList.js";

const UP = "\x1B[A";
const DOWN = "\x1B[B";
const ENTER = "\r";
const ESCAPE = "\x1B";

const items = [
  { label: "First", value: "a" },
  { label: "Second", value: "b" },
  { label: "Third", value: "c", hint: "a hint" },
];

/**
 * useInput's `setRawMode`/listener attachment happens in a `useEffect`, which
 * hasn't run yet by the time `render()` returns synchronously — a write
 * issued immediately is silently dropped. Awaiting one tick lets effects
 * flush before the test starts sending keys.
 */
async function renderReady(el: ReactElement) {
  const instance = render(el);
  await new Promise((r) => setImmediate(r));
  return instance;
}

/**
 * SelectList passes useInput a fresh closure every render (it captures
 * `index` directly), so Ink re-subscribes its listener in a `useEffect` after
 * each state update. Firing keys back-to-back without yielding a tick in
 * between hits the stale, not-yet-resubscribed listener.
 */
async function press(stdin: { write(data: string): void }, key: string) {
  stdin.write(key);
  await new Promise((r) => setImmediate(r));
}

/** Whether Ink colors its output depends on the real terminal, not this test's mocked stdout. */
function plain(frame: string | undefined): string {
  // eslint-disable-next-line no-control-regex -- stripping real ANSI escapes, not an accident
  return (frame ?? "").replace(/\x1B\[[0-9;]*m/g, "");
}

test("the first item starts highlighted and shows its hint", async () => {
  const { lastFrame } = await renderReady(<SelectList items={items} onSelect={() => {}} />);
  const frame = plain(lastFrame());
  assert.match(frame, /❯ First/);
  assert.match(frame, /Third — a hint/);
});

test("down arrow moves the highlight forward and wraps past the end", async () => {
  let selected: string | undefined;
  const { stdin, lastFrame } = await renderReady(
    <SelectList
      items={items}
      onSelect={(v) => {
        selected = v;
      }}
    />
  );
  await press(stdin, DOWN);
  assert.match(plain(lastFrame()), /❯ Second/);
  await press(stdin, DOWN);
  assert.match(plain(lastFrame()), /❯ Third/);
  await press(stdin, DOWN);
  assert.match(plain(lastFrame()), /❯ First/);
  await press(stdin, ENTER);
  assert.equal(selected, "a");
});

test("up arrow from the first item wraps to the last", async () => {
  const { stdin, lastFrame } = await renderReady(<SelectList items={items} onSelect={() => {}} />);
  stdin.write(UP);
  assert.match(plain(lastFrame()), /❯ Third/);
});

test("enter selects the currently highlighted item's value", async () => {
  let selected: string | undefined;
  const { stdin } = await renderReady(
    <SelectList
      items={items}
      onSelect={(v) => {
        selected = v;
      }}
    />
  );
  await press(stdin, DOWN);
  await press(stdin, ENTER);
  assert.equal(selected, "b");
});

test("escape calls onCancel when provided", async () => {
  let cancelled = false;
  const { stdin } = await renderReady(
    <SelectList
      items={items}
      onSelect={() => {}}
      onCancel={() => {
        cancelled = true;
      }}
    />
  );
  stdin.write(ESCAPE);
  assert.equal(cancelled, true);
});

test("escape with no onCancel handler does nothing", async () => {
  const { stdin } = await renderReady(<SelectList items={items} onSelect={() => {}} />);
  assert.doesNotThrow(() => stdin.write(ESCAPE));
});

test("an empty list only responds to escape, never to selection keys", async () => {
  let selectCalled = false;
  let cancelled = false;
  const { stdin } = await renderReady(
    <SelectList
      items={[]}
      onSelect={() => {
        selectCalled = true;
      }}
      onCancel={() => {
        cancelled = true;
      }}
    />
  );
  await press(stdin, DOWN);
  await press(stdin, ENTER);
  assert.equal(selectCalled, false);
  await press(stdin, ESCAPE);
  assert.equal(cancelled, true);
});
