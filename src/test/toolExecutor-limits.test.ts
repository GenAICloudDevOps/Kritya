import assert from "node:assert/strict";
import { test } from "node:test";
import { ToolExecutor, type ToolExecutorHost } from "../agent/toolExecutor.js";
import { NOOP_TRACER } from "../telemetry/tracer.js";
import { KillSwitch } from "../agent/killSwitch.js";
import { PermissionManager } from "../permissions/permissions.js";
import { NOOP_METER } from "../telemetry/metrics.js";
import type { AgentHandlers, ToolDef } from "../types.js";

function makeHost(): ToolExecutorHost {
  return {
    ctx: { workspace: "/tmp" },
    permissions: new PermissionManager(),
    kill: new KillSwitch(),
    planMode: false,
    dryRunMode: false,
    acceptEdits: false,
    interactive: true,
    tracer: NOOP_TRACER,
    meter: NOOP_METER,
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

const readOnlyTool: ToolDef = {
  name: "test_read",
  description: "test-only read-only tool",
  parameters: {},
  requiresPermission: false,
  summarize: () => "test_read()",
  execute: async () => "ok",
};

test("a tool call with an oversized argsJson payload is rejected before parsing", async () => {
  const executor = new ToolExecutor([readOnlyTool], makeHost());
  const huge = JSON.stringify({ path: "x".repeat(2_000_000) });

  const [output] = await executor.executeToolCalls(
    [{ id: "call_1", name: "test_read", argsJson: huge }],
    makeHandlers()
  );

  assert.match(output, /too large/i);
});

test("oversized tool output is truncated before it is returned to the model", async () => {
  const hugeOutputTool: ToolDef = {
    name: "test_huge",
    description: "test-only tool that returns a huge result",
    parameters: {},
    requiresPermission: false,
    summarize: () => "test_huge()",
    execute: async () => "y".repeat(1_000_000),
  };
  const executor = new ToolExecutor([hugeOutputTool], makeHost());

  const [output] = await executor.executeToolCalls(
    [{ id: "call_1", name: "test_huge", argsJson: "{}" }],
    makeHandlers()
  );

  assert.ok(output.length < 1_000_000);
  assert.match(output, /truncated/i);
});
