import assert from "node:assert/strict";
import { test } from "node:test";
import { ToolExecutor, type ToolExecutorHost } from "../agent/toolExecutor.js";
import { NOOP_TRACER } from "../telemetry/tracer.js";
import { KillSwitch } from "../agent/killSwitch.js";
import { PermissionManager } from "../permissions/permissions.js";
import type { Meter } from "../telemetry/metrics.js";
import type { AgentHandlers, ToolDef } from "../types.js";

interface RecordedPoint {
  name: string;
  value: number;
  attributes: Record<string, unknown> | undefined;
}

/** A `Meter` double that captures every recorded point instead of exporting it. */
function makeRecordingMeter(): {
  meter: Meter;
  histograms: RecordedPoint[];
  counters: RecordedPoint[];
} {
  const histograms: RecordedPoint[] = [];
  const counters: RecordedPoint[] = [];
  const meter: Meter = {
    counter: (name) => ({
      add: (value, attributes) => counters.push({ name, value, attributes }),
    }),
    histogram: (name) => ({
      record: (value, attributes) => histograms.push({ name, value, attributes }),
    }),
    flush() {},
    async flushAndWait() {},
    stop() {},
  };
  return { meter, histograms, counters };
}

const readOnlyTool: ToolDef = {
  name: "test_read",
  description: "test-only read-only tool",
  parameters: {},
  requiresPermission: false,
  summarize: () => "test_read()",
  execute: async () => "ok",
};

function makeHost(meter: Meter): ToolExecutorHost {
  return {
    ctx: { workspace: "/tmp" },
    permissions: new PermissionManager(),
    kill: new KillSwitch(),
    planMode: false,
    dryRunMode: false,
    acceptEdits: false,
    tracer: NOOP_TRACER,
    meter,
    turnSpan: undefined,
    toolTimeoutMs: 0,
  };
}

function makeHandlers(): AgentHandlers {
  return {
    onTextDelta() {},
    onReasoningDelta() {},
    onAssistantText() {},
    onToolStart() {},
    onToolEnd() {},
    requestPermission: async () => "yes",
    onUsage() {},
  };
}

test("a successful tool call records a duration histogram and a calls counter", async () => {
  const { meter, histograms, counters } = makeRecordingMeter();
  const executor = new ToolExecutor([readOnlyTool], makeHost(meter));

  const [output] = await executor.executeToolCalls(
    [{ id: "call_1", name: "test_read", argsJson: "{}" }],
    makeHandlers()
  );

  assert.equal(output, "ok");

  assert.equal(histograms.length, 1);
  assert.equal(histograms[0].name, "kritya.tool.duration_ms");
  assert.equal(histograms[0].attributes?.["kritya.tool"], "test_read");
  assert.ok(histograms[0].value >= 0);

  assert.equal(counters.length, 1);
  assert.equal(counters[0].name, "kritya.tool.calls");
  assert.equal(counters[0].value, 1);
  assert.equal(counters[0].attributes?.["kritya.tool"], "test_read");
  assert.equal(counters[0].attributes?.["kritya.outcome"], "ok");
});

test("a blocked tool call (kill switch active) still records metrics with the blocked outcome", async () => {
  const { meter, histograms, counters } = makeRecordingMeter();
  const host = makeHost(meter);
  host.kill.engage("test");
  const executor = new ToolExecutor([readOnlyTool], host);

  const [output] = await executor.executeToolCalls(
    [{ id: "call_1", name: "test_read", argsJson: "{}" }],
    makeHandlers()
  );

  assert.match(output, /kill switch/i);
  assert.equal(histograms.length, 1);
  assert.equal(counters.length, 1);
  assert.equal(counters[0].attributes?.["kritya.outcome"], "blocked");
});
