import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyReconCall, ReconTripwire, type ReconSignal } from "../permissions/recon.js";
import { ToolExecutor, type ToolExecutorHost } from "../agent/toolExecutor.js";
import { NOOP_TRACER } from "../telemetry/tracer.js";
import { KillSwitch } from "../agent/killSwitch.js";
import { PermissionManager } from "../permissions/permissions.js";
import type { AgentHandlers, ToolDef } from "../types.js";

function kinds(signals: ReconSignal[]): string[] {
  return signals.map((s) => s.kind);
}

test("classifyReconCall flags a shell command that touches a credential file", () => {
  assert.deepEqual(kinds(classifyReconCall("shell", { command: "cat .env" })), [
    "credential-probe",
  ]);
  assert.deepEqual(
    kinds(classifyReconCall("shell", { command: "grep TOKEN ~/.aws/credentials" })),
    ["credential-probe"]
  );
});

test("classifyReconCall flags whole-environment dumps but not single-variable use", () => {
  assert.deepEqual(kinds(classifyReconCall("shell", { command: "env" })), ["env-dump"]);
  assert.deepEqual(kinds(classifyReconCall("shell", { command: "printenv" })), ["env-dump"]);
  assert.deepEqual(kinds(classifyReconCall("shell", { command: "export -p" })), ["env-dump"]);
  assert.deepEqual(kinds(classifyReconCall("shell", { command: "cat /proc/self/environ" })), [
    "env-dump",
  ]);
  assert.deepEqual(classifyReconCall("shell", { command: "printenv PATH" }), []);
  assert.deepEqual(classifyReconCall("shell", { command: "env FOO=1 npm test" }), []);
});

test("classifyReconCall flags identity/network probes and system-directory listings", () => {
  assert.deepEqual(kinds(classifyReconCall("shell", { command: "whoami" })), ["system-probe"]);
  assert.deepEqual(kinds(classifyReconCall("shell", { command: "netstat -tulpn" })), [
    "system-probe",
  ]);
  assert.deepEqual(kinds(classifyReconCall("shell", { command: "ls ~" })), ["enumeration"]);
  assert.deepEqual(kinds(classifyReconCall("shell", { command: "ls -la /etc" })), ["enumeration"]);
  assert.deepEqual(kinds(classifyReconCall("shell", { command: "find / -name '*.ts'" })), [
    "enumeration",
  ]);
});

test("classifyReconCall stacks kinds from one busy command, one signal per kind", () => {
  const signals = classifyReconCall("shell", { command: "cat .env && env && whoami" });
  assert.deepEqual(kinds(signals).sort(), ["credential-probe", "env-dump", "system-probe"]);
});

test("classifyReconCall leaves ordinary work alone", () => {
  assert.deepEqual(classifyReconCall("shell", { command: "npm test" }), []);
  assert.deepEqual(classifyReconCall("shell", { command: "ls -la src" }), []);
  assert.deepEqual(classifyReconCall("shell", { command: "find . -name '*.ts'" }), []);
  assert.deepEqual(classifyReconCall("shell", { command: "echo hello" }), []);
  assert.deepEqual(classifyReconCall("read_file", { path: "src/index.ts" }), []);
  assert.deepEqual(classifyReconCall("edit_file", { path: "README.md" }), []);
});

test("classifyReconCall flags file tools aimed at credential files and system dirs", () => {
  assert.deepEqual(kinds(classifyReconCall("read_file", { path: ".env" })), ["credential-probe"]);
  assert.deepEqual(kinds(classifyReconCall("glob", { pattern: "**/*.pem" })), ["credential-probe"]);
  assert.deepEqual(kinds(classifyReconCall("list_dir", { path: "~" })), ["enumeration"]);
  assert.deepEqual(kinds(classifyReconCall("list_dir", { path: "/etc" })), ["enumeration"]);
});

test("tripwire trips on a sequence no single gate would stop, then latches", () => {
  const tw = new ReconTripwire();
  assert.equal(tw.record(classifyReconCall("shell", { command: "cat .env" })).blocked, false); // 5
  assert.equal(tw.record(classifyReconCall("shell", { command: "env" })).blocked, false); // 9
  const trip = tw.record(classifyReconCall("shell", { command: "ls /etc" })); // 11 — over
  assert.equal(trip.blocked, true);
  assert.equal(tw.tripped, true);
  assert.deepEqual(tw.tripKinds.sort(), ["credential-probe", "enumeration", "env-dump"]);
  // Latched: further recon calls are blocked, ordinary calls are not.
  assert.equal(tw.record(classifyReconCall("shell", { command: "whoami" })).blocked, true);
  assert.equal(tw.record(classifyReconCall("shell", { command: "npm test" })).blocked, false);
  assert.equal(tw.record(classifyReconCall("read_file", { path: "src/a.ts" })).blocked, false);
});

test("tripwire score decays out of the rolling window instead of accumulating forever", () => {
  const tw = new ReconTripwire();
  tw.record(classifyReconCall("shell", { command: "cat .env" })); // 5
  tw.record(classifyReconCall("shell", { command: "env" })); // 9
  for (let i = 0; i < 20; i++) tw.record([]);
  const after = tw.record(classifyReconCall("shell", { command: "env" }));
  assert.equal(after.blocked, false);
  assert.equal(after.score, 4);
  assert.equal(tw.tripped, false);
});

function makeHost(): ToolExecutorHost {
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
    meter: {
      counter: () => ({ add() {} }),
      histogram: () => ({ record() {} }),
      flush() {},
      async flushAndWait() {},
      stop() {},
    },
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

test("executor blocks the call that completes a recon pattern, then keeps blocking recon only", async () => {
  const shellStub: ToolDef = {
    name: "shell",
    description: "test stub",
    parameters: {},
    requiresPermission: false,
    summarize: () => "shell",
    execute: async () => "ran",
  };
  const executor = new ToolExecutor([shellStub], makeHost());
  const handlers = makeHandlers();
  const run = (command: string) =>
    executor.executeToolCalls(
      [{ id: command, name: "shell", argsJson: JSON.stringify({ command }) }],
      handlers
    );

  assert.equal((await run("cat .env"))[0], "ran");
  assert.equal((await run("env"))[0], "ran");
  const tripped = (await run("ls /etc"))[0];
  assert.match(tripped, /recon-pattern tripwire/);
  assert.equal((await run("echo hi"))[0], "ran");
  const stillBlocked = (await run("whoami"))[0];
  assert.match(stillBlocked, /recon-pattern tripwire/);
});
