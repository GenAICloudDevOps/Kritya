import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_SUBAGENT_CONCURRENCY,
  MAX_SUBAGENT_CONCURRENCY,
  abortOutcome,
  clampConcurrency,
  createSubagentHandlers,
  headline,
  mergeErrors,
  subagentStatusNote,
} from "../agent/subagents.js";
import type { SubagentResult } from "../types.js";

/** Minimal result; every test overrides only the field it is about. */
function result(over: Partial<SubagentResult> = {}): SubagentResult {
  return { task: "a task", write: false, summary: "a summary", ...over };
}

test("clampConcurrency falls back to the default for a missing or non-finite value", () => {
  assert.equal(clampConcurrency(undefined), DEFAULT_SUBAGENT_CONCURRENCY);
  assert.equal(clampConcurrency(Number.NaN), DEFAULT_SUBAGENT_CONCURRENCY);
  assert.equal(clampConcurrency(Number.POSITIVE_INFINITY), DEFAULT_SUBAGENT_CONCURRENCY);
  assert.equal(clampConcurrency(Number.NEGATIVE_INFINITY), DEFAULT_SUBAGENT_CONCURRENCY);
});

test("clampConcurrency floors, and holds the result inside 1..MAX", () => {
  assert.equal(clampConcurrency(4.9), 4);
  // Below the floor and above the ceiling both clamp rather than pass through:
  // 0 would stall the worker pool, and >MAX can never be filled by a batch.
  assert.equal(clampConcurrency(0), 1);
  assert.equal(clampConcurrency(-3), 1);
  assert.equal(clampConcurrency(MAX_SUBAGENT_CONCURRENCY + 10), MAX_SUBAGENT_CONCURRENCY);
  assert.equal(clampConcurrency(MAX_SUBAGENT_CONCURRENCY), MAX_SUBAGENT_CONCURRENCY);
});

test("abortOutcome is undefined for a run that was not aborted", () => {
  assert.equal(abortOutcome({ timedOut: false, cancelled: false }), undefined);
});

test("abortOutcome distinguishes a timeout from a user cancel", () => {
  // The raw abort message is identical for both, which is the whole reason
  // this function exists — so the two must not collapse to the same string.
  assert.deepEqual(abortOutcome({ timedOut: true, cancelled: false }), {
    error: "timed out before finishing",
    stoppedEarly: "timeout",
  });
  assert.deepEqual(abortOutcome({ timedOut: false, cancelled: true }), {
    error: "cancelled",
    stoppedEarly: "cancelled",
  });
});

test("abortOutcome blames the timeout when both are true", () => {
  // A timeout aborts the controller, which can look like a cancel; the clock
  // is the more specific explanation and is reported first.
  assert.equal(abortOutcome({ timedOut: true, cancelled: true })?.stoppedEarly, "timeout");
});

test("mergeErrors joins the real reasons and drops blanks", () => {
  assert.equal(mergeErrors(), undefined);
  assert.equal(mergeErrors(undefined, "   ", ""), undefined);
  assert.equal(mergeErrors(undefined, "first", "second"), "first second");
});

test("headline collapses whitespace and falls back for an empty result", () => {
  assert.equal(headline(result({ summary: "  lots\n\nof\tspace " })), "lots of space");
  assert.equal(headline(result({ summary: "   " })), "no findings");
});

test("headline prefers the error, since that is what went wrong", () => {
  assert.equal(headline(result({ summary: "everything is fine", error: "boom" })), "boom");
});

test("headline truncates a long line to a single bounded line", () => {
  const long = headline(result({ summary: "x".repeat(200) }));
  assert.equal(long.length, 72);
  assert.ok(long.endsWith("…"));

  // Exactly at the cap is left alone — only a longer line is worth cutting.
  const exact = "y".repeat(72);
  assert.equal(headline(result({ summary: exact })), exact);
});

test("subagentStatusNote is undefined for a clean run", () => {
  assert.equal(subagentStatusNote(result()), undefined);
});

test("subagentStatusNote reports an error", () => {
  assert.equal(
    subagentStatusNote(result({ error: "commit hook rejected it" })),
    "[error: commit hook rejected it]"
  );
});

test("subagentStatusNote explains the step cap in actionable terms", () => {
  const note = subagentStatusNote(result({ stoppedEarly: "max-steps" }));
  assert.match(note!, /stopped early/);
  assert.match(note!, /hit its step limit/);
  assert.match(note!, /subagentMaxSteps/);
});

test("subagentStatusNote names the other stop reasons plainly", () => {
  assert.match(
    subagentStatusNote(result({ stoppedEarly: "timeout" }))!,
    /\[stopped early: timeout\]/
  );
  assert.match(
    subagentStatusNote(result({ stoppedEarly: "cancelled" }))!,
    /\[stopped early: cancelled\]/
  );
});

test("subagentStatusNote keeps the error above the stop reason", () => {
  const note = subagentStatusNote(result({ error: "boom", stoppedEarly: "max-steps" }));
  assert.ok(note!.startsWith("[error: boom]\n"));
});

test("createSubagentHandlers accumulates assistant text instead of replacing it", () => {
  // The bug this guards: the old wiring was `(t) => (finalText = t)`, so a
  // subagent that reported findings and then kept working lost the findings.
  const seen: string[] = [];
  const handlers = createSubagentHandlers({
    onFinalText: (t) => seen.push(t),
    requestPermission: async () => "no",
  });

  handlers.onAssistantText("first finding");
  handlers.onAssistantText("second finding");

  assert.deepEqual(seen, ["first finding", "first finding\n\nsecond finding"]);
});

test("createSubagentHandlers ignores blank assistant text", () => {
  const seen: string[] = [];
  const handlers = createSubagentHandlers({
    onFinalText: (t) => seen.push(t),
    requestPermission: async () => "no",
  });

  handlers.onAssistantText("   \n  ");
  assert.deepEqual(seen, []);
});

test("createSubagentHandlers trims each part it keeps", () => {
  const seen: string[] = [];
  const handlers = createSubagentHandlers({
    onFinalText: (t) => seen.push(t),
    requestPermission: async () => "no",
  });

  handlers.onAssistantText("  padded  ");
  assert.deepEqual(seen, ["padded"]);
});

test("createSubagentHandlers reports step progress as 'step n/max · tool'", () => {
  const steps: string[] = [];
  const handlers = createSubagentHandlers({
    onFinalText: () => {},
    requestPermission: async () => "no",
    onStep: (t) => steps.push(t),
    stepInfo: () => ({ step: 4, max: 15 }),
  });

  handlers.onToolStart("id-1", "grep", "src/auth");
  assert.deepEqual(steps, ["step 4/15 · src/auth"]);
});

test("createSubagentHandlers drops the fraction when there is no usable cap", () => {
  const withNoStepInfo: string[] = [];
  createSubagentHandlers({
    onFinalText: () => {},
    requestPermission: async () => "no",
    onStep: (t) => withNoStepInfo.push(t),
  }).onToolStart("id-1", "grep", "src/auth");

  const withZeroMax: string[] = [];
  createSubagentHandlers({
    onFinalText: () => {},
    requestPermission: async () => "no",
    onStep: (t) => withZeroMax.push(t),
    // A caller that doesn't know its cap reports 0 rather than inventing one.
    stepInfo: () => ({ step: 0, max: 0 }),
  }).onToolStart("id-1", "grep", "src/auth");

  assert.deepEqual(withNoStepInfo, ["src/auth"]);
  assert.deepEqual(withZeroMax, ["src/auth"]);
});

test("createSubagentHandlers falls back to the tool name when the summary is blank", () => {
  const steps: string[] = [];
  createSubagentHandlers({
    onFinalText: () => {},
    requestPermission: async () => "no",
    onStep: (t) => steps.push(t),
  }).onToolStart("id-1", "read_file", "   ");

  assert.deepEqual(steps, ["read_file"]);
});

test("createSubagentHandlers is silent when no onStep sink was supplied", () => {
  // Headless wiring has no status line to draw into; that must be a no-op
  // rather than a crash on the first tool call.
  const handlers = createSubagentHandlers({
    onFinalText: () => {},
    requestPermission: async () => "no",
  });

  assert.doesNotThrow(() => handlers.onToolStart("id-1", "grep", "src/auth"));
  assert.doesNotThrow(() => handlers.onToolEnd("id-1", "grep", "src/auth", "", false));
  assert.doesNotThrow(() => handlers.onTextDelta("token"));
  assert.doesNotThrow(() => handlers.onReasoningDelta("token"));
  assert.doesNotThrow(() => handlers.onUsage({} as never));
});

test("createSubagentHandlers forwards requestPermission straight through", async () => {
  const handlers = createSubagentHandlers({
    onFinalText: () => {},
    requestPermission: async (_name, _summary, _diff, warning) => (warning ? "no" : "yes"),
  });

  assert.equal(await handlers.requestPermission("write_file", "a.txt"), "yes");
  assert.equal(
    await handlers.requestPermission("write_file", "a.txt", undefined, "destructive"),
    "no"
  );
});
