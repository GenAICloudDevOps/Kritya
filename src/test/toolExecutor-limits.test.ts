import assert from "node:assert/strict";
import { test } from "node:test";
import { ToolExecutor, type ToolExecutorHost } from "../agent/toolExecutor.js";
import type { PermissionRules } from "../permissions/rules.js";
import { NOOP_TRACER } from "../telemetry/tracer.js";
import { KillSwitch } from "../agent/killSwitch.js";
import { PermissionManager } from "../permissions/permissions.js";
import { NOOP_METER } from "../telemetry/metrics.js";
import type { AgentHandlers, ToolDef } from "../types.js";

function makeHost(overrides: Partial<ToolExecutorHost> = {}): ToolExecutorHost {
  return {
    ctx: { workspace: "/tmp" },
    permissions: new PermissionManager(),
    kill: new KillSwitch(),
    planMode: false,
    dryRunMode: false,
    acceptEdits: false,
    bypassMode: false,
    interactive: true,
    tracer: NOOP_TRACER,
    meter: NOOP_METER,
    turnSpan: undefined,
    toolTimeoutMs: 0,
    ...overrides,
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

const shellTool: ToolDef = {
  name: "shell",
  description: "test-only shell tool",
  parameters: {},
  requiresPermission: true,
  summarize: (args) => `shell(${(args as { command?: string }).command})`,
  execute: async () => "ok",
};

test("bypassMode auto-approves a classifyDanger-flagged destructive shell command with no prompt", async () => {
  let prompted = false;
  const executor = new ToolExecutor([shellTool], makeHost({ bypassMode: true }));

  const [output] = await executor.executeToolCalls(
    [{ id: "call_1", name: "shell", argsJson: JSON.stringify({ command: "rm -rf /tmp/x" }) }],
    {
      ...makeHandlers(),
      requestPermission: async () => {
        prompted = true;
        return "yes";
      },
    }
  );

  assert.equal(
    prompted,
    false,
    "bypass mode must not prompt even for a flagged destructive command"
  );
  assert.equal(output, "ok");
});

test("a deny rule still blocks a shell command even with bypassMode on", async () => {
  const permissions = new PermissionManager({
    allow: [],
    deny: ["shell(rm *)"],
  } as PermissionRules);
  let prompted = false;
  const executor = new ToolExecutor([shellTool], makeHost({ bypassMode: true, permissions }));

  const [output] = await executor.executeToolCalls(
    [{ id: "call_1", name: "shell", argsJson: JSON.stringify({ command: "rm -rf /tmp/x" }) }],
    {
      ...makeHandlers(),
      requestPermission: async () => {
        prompted = true;
        return "yes";
      },
    }
  );

  assert.equal(prompted, false, "a deny rule is refused outright, never prompted");
  assert.match(output, /deny rule/i);
});

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
