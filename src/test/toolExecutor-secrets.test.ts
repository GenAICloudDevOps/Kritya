import assert from "node:assert/strict";
import { test } from "node:test";
import { ToolExecutor, type ToolExecutorHost } from "../agent/toolExecutor.js";
import { NOOP_TRACER } from "../telemetry/tracer.js";
import { KillSwitch } from "../agent/killSwitch.js";
import { PermissionManager } from "../permissions/permissions.js";
import type { AuditLog, ToolRecord } from "../audit/audit.js";
import type { AgentHandlers, ToolDef } from "../types.js";

function makeRecordingAudit(): { audit: AuditLog; records: ToolRecord[] } {
  const records: ToolRecord[] = [];
  const audit = {
    logPermission() {},
    logTool(entry: Omit<ToolRecord, keyof unknown> & { tool: string; summary: string }) {
      records.push(entry as ToolRecord);
    },
  } as unknown as AuditLog;
  return { audit, records };
}

function makeHost(audit: AuditLog): ToolExecutorHost {
  return {
    ctx: { workspace: "/tmp" },
    permissions: new PermissionManager(),
    kill: new KillSwitch(),
    planMode: false,
    dryRunMode: false,
    acceptEdits: false,
    interactive: true,
    tracer: NOOP_TRACER,
    meter: {
      counter: () => ({ add() {} }),
      histogram: () => ({ record() {} }),
      flush() {},
      async flushAndWait() {},
      stop() {},
    },
    turnSpan: undefined,
    toolTimeoutMs: 0,
    audit,
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

test("a tool summary containing a real secret is redacted before it reaches the audit log", async () => {
  const leaky: ToolDef = {
    name: "leaky_tool",
    description: "test-only tool whose summary embeds a secret",
    parameters: {},
    requiresPermission: false,
    summarize: () => "Fetch URL: https://example.com/?token=AKIAABCDEFGHIJKLMNOP",
    execute: async () => "ok",
  };
  const { audit, records } = makeRecordingAudit();
  const executor = new ToolExecutor([leaky], makeHost(audit));

  await executor.executeToolCalls(
    [{ id: "call_1", name: "leaky_tool", argsJson: "{}" }],
    makeHandlers()
  );

  assert.equal(records.length, 1);
  assert.ok(!records[0].summary.includes("AKIAABCDEFGHIJKLMNOP"));
  assert.ok(records[0].summary.includes("REDACTED"));
});
