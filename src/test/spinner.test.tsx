import assert from "node:assert/strict";
import { test } from "node:test";
import { render } from "ink-testing-library";
import { Spinner } from "../ui/Spinner.js";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** Whether Ink colors its output depends on the real terminal, not this test's mocked stdout. */
function plain(frame: string | undefined): string {
  // eslint-disable-next-line no-control-regex -- stripping real ANSI escapes, not an accident
  return (frame ?? "").replace(/\x1B\[[0-9;]*m/g, "");
}

test("renders the first frame and the label immediately", () => {
  const { lastFrame, unmount } = render(<Spinner label="Thinking…" />);
  try {
    const frame = plain(lastFrame());
    assert.match(frame, new RegExp(FRAMES[0]));
    assert.match(frame, /Thinking…/);
  } finally {
    unmount();
  }
});

test("advances to the next frame every 80ms and stops once unmounted", async () => {
  const { lastFrame, unmount } = render(<Spinner label="Working" />);
  try {
    await new Promise((r) => setTimeout(r, 95));
    assert.match(plain(lastFrame()), new RegExp(FRAMES[1]));
  } finally {
    unmount();
  }
});
