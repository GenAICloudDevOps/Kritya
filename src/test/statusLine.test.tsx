import assert from "node:assert/strict";
import { test } from "node:test";
import { render } from "ink-testing-library";
import { StatusLine, type StatusLineProps } from "../ui/StatusLine.js";

/** Whether Ink colors its output depends on the real terminal, not this test's mocked stdout. */
function plain(frame: string | undefined): string {
  // eslint-disable-next-line no-control-regex -- stripping real ANSI escapes, not an accident
  return (frame ?? "").replace(/\x1B\[[0-9;]*m/g, "");
}

function baseProps(overrides: Partial<StatusLineProps> = {}): StatusLineProps {
  return {
    killed: false,
    dryRunMode: false,
    planMode: false,
    acceptEdits: false,
    autoApprovedCount: 0,
    provider: "nvidia",
    model: "llama-3.1-70b",
    workflow: null,
    branch: null,
    tasks: [],
    ctxPct: 0,
    budgetPct: 0,
    budgetStopped: false,
    phase: "input",
    elapsed: 0,
    totalUsage: { promptTokens: 0, completionTokens: 0 },
    totalCost: 0,
    verbose: false,
    workspace: "/home/user/project",
    sandboxActive: true,
    persistenceWarningCount: 0,
    privacyMode: false,
    ...overrides,
  };
}

test("shows the active provider alongside the model", () => {
  const { lastFrame, unmount } = render(
    <StatusLine {...baseProps({ provider: "nvidia", model: "llama-3.1-70b" })} />
  );
  try {
    assert.match(plain(lastFrame()), /nvidia\/llama-3\.1-70b/);
  } finally {
    unmount();
  }
});

test("labels the permission mode explicitly as 'default' when no special mode is active", () => {
  const { lastFrame, unmount } = render(<StatusLine {...baseProps()} />);
  try {
    assert.match(plain(lastFrame()), /mode: default/);
  } finally {
    unmount();
  }
});

test("labels plan mode explicitly", () => {
  const { lastFrame, unmount } = render(<StatusLine {...baseProps({ planMode: true })} />);
  try {
    assert.match(plain(lastFrame()), /mode: plan/);
  } finally {
    unmount();
  }
});

test("labels dry-run mode explicitly", () => {
  const { lastFrame, unmount } = render(<StatusLine {...baseProps({ dryRunMode: true })} />);
  try {
    assert.match(plain(lastFrame()), /mode: dry-run/);
  } finally {
    unmount();
  }
});

test("labels accept-edits mode with the auto-approved count", () => {
  const { lastFrame, unmount } = render(
    <StatusLine {...baseProps({ acceptEdits: true, autoApprovedCount: 3 })} />
  );
  try {
    assert.match(plain(lastFrame()), /mode: accept-edits \(3 auto\)/);
  } finally {
    unmount();
  }
});
