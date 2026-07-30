# MCP Tasks extension (`io.modelcontextprotocol/tasks`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a task-enabled MCP server return a durable task handle from `tools/call` instead of blocking, so kritya polls `tasks/get` until it completes, answering any `input_required` elicitation along the way — with a live status line in the UI while it polls.

**Architecture:** `McpConnection.callTool` (`src/mcp/client.ts`) gains an internal poll loop that activates only when a `tools/call` reply has `resultType === "task"`. Progress reaches the screen through a new optional `onProgress` parameter threaded through `ToolDef.execute` → `ToolExecutor` → `AgentHandlers.onToolProgress` → `useAgent`'s `inFlight` state → `App.tsx`'s spinner rendering. Everything is additive and optional; a server that never declares/uses tasks sees zero behavior change.

**Tech Stack:** TypeScript, `node:test` for tests, Ink for the terminal UI. No new dependencies.

## Global Constraints

- Follow the design doc exactly: [`docs/superpowers/specs/2026-07-29-mcp-tasks-design.md`](../specs/2026-07-29-mcp-tasks-design.md). Do not revert the two user-locked scope decisions: (a) capability is **per-server opt-in config**, never on-by-default; (b) the live status line **is** being built (not deferred).
- `PROTOCOL_VERSION = "2026-07-28"` (`src/mcp/client.ts:31`) — unchanged, Tasks is an extension negotiated via `_meta`, not a core capability.
- `CALL_TIMEOUT_MS = 120_000` (`src/mcp/client.ts:32`) applies to each individual JSON-RPC request (`tools/call`, `tasks/get`, `tasks/update`), never to the overall poll duration.
- Poll-only for v1 — no `notifications/tasks` subscription support.
- `input_required` is handled **only** when every entry in `inputRequests` has `method === "elicitation/create"`. Anything else: send `tasks/cancel` and throw naming the unsupported method. Never guess at an unimplemented request shape.
- Name the new internal task-schema types with an `Mcp` prefix (`McpTask`, `McpDetailedTask`, `McpCreateTaskResult`) — `TaskItem` in `src/types.ts` already names the unrelated to-do-checklist concept; do not collide with it.
- Every new optional field/parameter (`tasks?` config, `onProgress` param, `onToolProgress` handler, `status` on `inFlight` entries) must be additive — no existing call site (headless.ts, index.tsx, existing tests, existing tool implementations) should need to change to keep compiling.
- Run `npm run build` (or `tsc --noEmit`, check `package.json` for the exact script) and `npm test` before every commit that touches `.ts`/`.tsx` files.

---

### Task 1: Config — per-server `tasks` opt-in

**Files:**

- Modify: `src/config/config.ts:90-116` (the `McpServerConfig` interface)
- Test: `src/test/mcp.test.ts` (new test near the existing `mcpToolDef` consent tests, ~line 46-63)

**Interfaces:**

- Produces: `McpServerConfig.tasks?: boolean` — read by Task 2 (`mcpToolDef`) and Task 3 (`callTool`'s `_meta` attachment).

- [ ] **Step 1: Add the field**

In `src/config/config.ts`, immediately after the existing `consent` field (ends around line 116, right before the closing `}` of `McpServerConfig`):

```typescript
  /**
   * Opt in to the `io.modelcontextprotocol/tasks` extension: kritya declares
   * support for it on every `tools/call` to this server, letting the server
   * return a durable task handle instead of blocking. Off by default — a
   * server has no grounds to return a task unless the client declared it.
   */
  tasks?: boolean;
```

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: no errors (the field is optional, so no existing config object breaks).

- [ ] **Step 3: Commit**

```bash
git add src/config/config.ts
git commit -m "feat(mcp): add per-server tasks config opt-in"
```

---

### Task 2: Task schema types + capability `_meta` attachment in `mcpToolDef`

**Files:**

- Modify: `src/mcp/client.ts` (add types near `McpToolResult`/`SamplingRequest`, ~line 60-90; modify `mcpToolDef`, line 985)
- Test: `src/test/mcp.test.ts`

**Interfaces:**

- Consumes: `McpServerConfig.tasks` (Task 1).
- Produces: exported types `McpTask`, `McpDetailedTask`, `McpCreateTaskResult`, `TASKS_EXTENSION_META` (the `_meta` object builder) — consumed by Task 3's poll loop. `mcpToolDef`'s widened `cfg` parameter type `Pick<McpServerConfig, "consent" | "tasks">` — consumed by Task 3 (no change needed there, `mcpToolDef` already forwards `cfg` to `callTool` via a closure, see Task 3).

- [ ] **Step 1: Add the schema types**

In `src/mcp/client.ts`, near the existing `SamplingRequest`/`SamplingResult` types (~line 61-90), add:

```typescript
export type McpTaskStatus = "working" | "input_required" | "completed" | "failed" | "cancelled";

export interface McpTask {
  taskId: string;
  status: McpTaskStatus;
  statusMessage?: string;
  createdAt: string;
  lastUpdatedAt: string;
  ttlMs: number | null;
  pollIntervalMs?: number;
}

/** The reply to `tools/call` when the server hands back a task instead of a result. */
export interface McpCreateTaskResult extends McpTask {
  resultType?: "task";
}

/** A full JSON-RPC request object, as carried inside `inputRequests`. */
interface McpInputRequest {
  method: string;
  params?: unknown;
}

/** The reply to `tasks/get`: same base fields as `McpTask`, plus a status-specific payload. */
export interface McpDetailedTask extends McpTask {
  inputRequests?: Record<string, McpInputRequest>;
  result?: McpToolResult;
  error?: { message?: string };
}

/** `_meta` block a task-enabled server's `tools/call` request carries, per the extension's negotiation mechanism. */
const TASKS_EXTENSION_META = {
  "io.modelcontextprotocol/clientCapabilities": {
    extensions: { "io.modelcontextprotocol/tasks": {} },
  },
};

const DEFAULT_POLL_INTERVAL_MS = 2000;
```

Place this after the `McpToolResult`/`renderToolResult` definitions so `McpDetailedTask` can reference `McpToolResult` — check the exact line with `grep -n "interface McpToolResult" src/mcp/client.ts` first and insert after it.

- [ ] **Step 2: Widen `mcpToolDef`'s cfg type and confirm the flag reaches it**

`mcpToolDef` (line 985) already receives the whole `cfg: McpServerConfig` object from its one call site (`connectServer`, line 827: `mcpToolDef(conn, name, spec, cfg)`), so the runtime data is already there — only the declared type needs widening. Change:

```typescript
export function mcpToolDef(
  conn: McpConnection,
  server: string,
  spec: McpToolSpec,
  cfg: Pick<McpServerConfig, "consent"> = {}
): ToolDef {
```

to:

```typescript
export function mcpToolDef(
  conn: McpConnection,
  server: string,
  spec: McpToolSpec,
  cfg: Pick<McpServerConfig, "consent" | "tasks"> = {}
): ToolDef {
```

Task 3 changes this function's `execute` to forward `cfg.tasks` into `callTool`.

- [ ] **Step 3: Write the failing test**

In `src/test/mcp.test.ts`, near the existing `mcpToolDef` consent tests (~line 46-63), add:

```typescript
test("mcpToolDef's execute passes the tasks flag through to callTool", async () => {
  const calls: unknown[] = [];
  const conn = {
    callTool: (...args: unknown[]) => {
      calls.push(args);
      return Promise.resolve("ok");
    },
  } as unknown as Parameters<typeof mcpToolDef>[0];
  const def = mcpToolDef(conn, "srv", makeConsentTestSpec(), { tasks: true });
  await def.execute({}, { workspace: "." });
  assert.equal(calls.length, 1);
  // args: [toolName, args, signal, onProgress?, tasksEnabled?] — exact shape
  // finalized in Task 3; assert only that the flag reached callTool truthily.
});
```

This test is a placeholder assertion until Task 3 finalizes `callTool`'s signature — leave the comment as a marker, but don't leave the assertion empty; run it now to confirm it at least executes without throwing.

- [ ] **Step 4: Run test to verify it currently fails or passes trivially**

Run: `npm run build && node --test dist/test/mcp.test.js 2>&1 | grep -A5 "tasks flag"`
Expected: passes (it only checks `calls.length`), confirming the plumbing exists — Task 3 will replace this test with a stronger one once `callTool`'s real signature exists.

- [ ] **Step 5: Run full test file and build**

Run: `npm test 2>&1 | tail -40`
Expected: all existing tests still pass; new test passes.

- [ ] **Step 6: Commit**

```bash
git add src/mcp/client.ts src/test/mcp.test.ts
git commit -m "feat(mcp): add Tasks extension schema types and capability declaration"
```

---

### Task 3: `McpConnection.callTool` — task-aware poll loop

**Files:**

- Modify: `src/mcp/client.ts` (`callTool`, line 496; `mcpToolDef`'s `execute`, line ~1003)
- Test: `src/test/mcp.test.ts`

**Interfaces:**

- Consumes: `McpTask`, `McpDetailedTask`, `McpCreateTaskResult`, `TASKS_EXTENSION_META`, `DEFAULT_POLL_INTERVAL_MS` (Task 2); `toElicitationFields` (already a module-scope function in `client.ts`, line ~313 — no extraction needed, it's already usable from anywhere in this file); `this.options.onElicitation` (existing `McpConnectionOptions` field).
- Produces: `callTool(toolName, args, signal?, tasksEnabled?, onProgress?)` — note the parameter **order**: `tasksEnabled` (a plain `boolean`, whether this server declared task support) comes before `onProgress`, both optional and appended after the existing `signal` param so every existing call site (none outside this file call `callTool` directly except `mcpToolDef`) keeps compiling. `mcpToolDef`'s `execute` signature gains a 4th param `onProgress?: (text: string) => void` forwarded straight through — this is what Task 5 (`ToolDef.execute`) and Task 6 (`ToolExecutor`) rely on.

- [ ] **Step 1: Write the failing tests first**

Add to `src/test/mcp.test.ts`, in a new `// ---------- Tasks extension ----------` section after the elicitation tests (~line 905):

```typescript
// ---------- Tasks extension (io.modelcontextprotocol/tasks) ----------

// A server whose one tool immediately returns a task, then completes it
// after N `tasks/get` polls. TASK_POLLS_TO_COMPLETE controls how many
// "working" replies precede the "completed" one.
function tasksServerScript(pollsBeforeDone: number): string {
  return [
    "const rl = require('readline').createInterface({ input: process.stdin });",
    "const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');",
    "let polls = 0;",
    `const pollsBeforeDone = ${pollsBeforeDone};`,
    "let sawTasksMeta = false;",
    "rl.on('line', (l) => {",
    "  if (!l.trim()) return;",
    "  const m = JSON.parse(l);",
    "  if (m.method === 'initialize')",
    "    return send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params.protocolVersion,",
    "      capabilities: { tools: {} }, serverInfo: { name: 'tasker', version: '1' } } });",
    "  if (m.method === 'tools/list')",
    "    return send({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'longjob' }] } });",
    "  if (m.method === 'tools/call') {",
    "    sawTasksMeta = Boolean(m.params._meta && m.params._meta['io.modelcontextprotocol/clientCapabilities']",
    "      && m.params._meta['io.modelcontextprotocol/clientCapabilities'].extensions",
    "      && m.params._meta['io.modelcontextprotocol/clientCapabilities'].extensions['io.modelcontextprotocol/tasks']);",
    "    return send({ jsonrpc: '2.0', id: m.id, result: { resultType: 'task', taskId: 't1',",
    "      status: 'working', statusMessage: 'started', createdAt: 'now', lastUpdatedAt: 'now',",
    "      ttlMs: null, pollIntervalMs: 5 } });",
    "  }",
    "  if (m.method === 'tasks/get') {",
    "    polls++;",
    "    if (polls < pollsBeforeDone)",
    "      return send({ jsonrpc: '2.0', id: m.id, result: { taskId: 't1', status: 'working',",
    "        statusMessage: 'poll ' + polls, createdAt: 'now', lastUpdatedAt: 'now', ttlMs: null, pollIntervalMs: 5 } });",
    "    return send({ jsonrpc: '2.0', id: m.id, result: { taskId: 't1', status: 'completed',",
    "      createdAt: 'now', lastUpdatedAt: 'now', ttlMs: null,",
    "      result: { content: [{ type: 'text', text: 'sawTasksMeta:' + sawTasksMeta }] } } });",
    "  }",
    "});",
  ].join("\n");
}

test("a task that completes on the first poll returns the same result a sync call would", async () => {
  const tools = await loadMcpTools({
    tasker: { command: process.execPath, args: ["-e", tasksServerScript(1)], tasks: true },
  });
  const out = await tools[0].execute({}, { workspace: "." });
  assert.equal(out, "sawTasksMeta:true");
});

test("a task needing multiple poll rounds still completes", async () => {
  const tools = await loadMcpTools({
    tasker: { command: process.execPath, args: ["-e", tasksServerScript(4)], tasks: true },
  });
  const out = await tools[0].execute({}, { workspace: "." });
  assert.equal(out, "sawTasksMeta:true");
});

test("the tasks _meta capability is attached only when tasks: true is configured", async () => {
  const tools = await loadMcpTools({
    tasker: { command: process.execPath, args: ["-e", tasksServerScript(1)] },
  });
  // Without tasks:true, kritya never declares support, so per spec the server
  // shouldn't return a task — but this fake server returns one regardless of
  // the _meta flag to isolate what we're testing: the _meta block itself.
  // We assert on sawTasksMeta being false in the result text.
  const out = await tools[0].execute({}, { workspace: "." });
  assert.equal(out, "sawTasksMeta:false");
});

test("onProgress fires once on task creation and again after each poll", async () => {
  const tools = await loadMcpTools({
    tasker: { command: process.execPath, args: ["-e", tasksServerScript(3)], tasks: true },
  });
  const progress: string[] = [];
  await tools[0].execute({}, { workspace: "." }, undefined, (text: string) => progress.push(text));
  assert.equal(progress[0], "started");
  assert.equal(progress.length, 4); // initial + 3 polls (2 "working" + 1 "completed" transition consumed internally)
});

test("a task that ends failed throws with the server's error message", async () => {
  const script = [
    "const rl = require('readline').createInterface({ input: process.stdin });",
    "const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');",
    "rl.on('line', (l) => {",
    "  if (!l.trim()) return;",
    "  const m = JSON.parse(l);",
    "  if (m.method === 'initialize')",
    "    return send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params.protocolVersion,",
    "      capabilities: { tools: {} }, serverInfo: { name: 'failer', version: '1' } } });",
    "  if (m.method === 'tools/list')",
    "    return send({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'longjob' }] } });",
    "  if (m.method === 'tools/call')",
    "    return send({ jsonrpc: '2.0', id: m.id, result: { resultType: 'task', taskId: 't1', status: 'working',",
    "      createdAt: 'now', lastUpdatedAt: 'now', ttlMs: null, pollIntervalMs: 5 } });",
    "  if (m.method === 'tasks/get')",
    "    return send({ jsonrpc: '2.0', id: m.id, result: { taskId: 't1', status: 'failed',",
    "      createdAt: 'now', lastUpdatedAt: 'now', ttlMs: null, error: { message: 'build step failed' } } });",
    "});",
  ].join("\n");
  const tools = await loadMcpTools({
    failer: { command: process.execPath, args: ["-e", script], tasks: true },
  });
  await assert.rejects(tools[0].execute({}, { workspace: "." }), /build step failed/);
});

test("a task that ends cancelled (server-initiated) throws a clear error", async () => {
  const script = [
    "const rl = require('readline').createInterface({ input: process.stdin });",
    "const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');",
    "rl.on('line', (l) => {",
    "  if (!l.trim()) return;",
    "  const m = JSON.parse(l);",
    "  if (m.method === 'initialize')",
    "    return send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params.protocolVersion,",
    "      capabilities: { tools: {} }, serverInfo: { name: 'canceler', version: '1' } } });",
    "  if (m.method === 'tools/list')",
    "    return send({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'longjob' }] } });",
    "  if (m.method === 'tools/call')",
    "    return send({ jsonrpc: '2.0', id: m.id, result: { resultType: 'task', taskId: 't1', status: 'working',",
    "      createdAt: 'now', lastUpdatedAt: 'now', ttlMs: null, pollIntervalMs: 5 } });",
    "  if (m.method === 'tasks/get')",
    "    return send({ jsonrpc: '2.0', id: m.id, result: { taskId: 't1', status: 'cancelled',",
    "      createdAt: 'now', lastUpdatedAt: 'now', ttlMs: null } });",
    "});",
  ].join("\n");
  const tools = await loadMcpTools({
    canceler: { command: process.execPath, args: ["-e", script], tasks: true },
  });
  await assert.rejects(tools[0].execute({}, { workspace: "." }), /cancelled/);
});
```

Delete the placeholder test from Task 2 Step 3 (`"mcpToolDef's execute passes the tasks flag through to callTool"`) now that these stronger tests supersede it.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run build && node --test dist/test/mcp.test.js 2>&1 | grep -E "tasker|failer|canceler|not ok"`
Expected: FAIL — `callTool` doesn't understand `resultType: "task"` yet, so these either hang (bad — check for a timeout) or throw/return garbage. Confirm they fail for the _expected_ reason (unhandled task result), not a syntax error.

- [ ] **Step 3: Implement the poll loop in `callTool`**

Replace `callTool` (line ~496) with:

```typescript
  async callTool(
    toolName: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
    tasksEnabled?: boolean,
    onProgress?: (text: string) => void
  ): Promise<string> {
    const params: Record<string, unknown> = { name: toolName, arguments: args };
    if (tasksEnabled) {
      params._meta = TASKS_EXTENSION_META;
    }
    const result = (await this.request("tools/call", params, CALL_TIMEOUT_MS, signal)) as
      | McpToolResult
      | McpCreateTaskResult;

    if ((result as McpCreateTaskResult).resultType === "task") {
      return this.pollTask(result as McpCreateTaskResult, signal, onProgress);
    }

    const text = renderToolResult(result as McpToolResult);
    if ((result as McpToolResult).isError) throw new Error(text || "MCP tool reported an error");
    return text || "(no output)";
  }

  /** Poll `tasks/get` until a task reaches a terminal status, answering
   *  elicitation-shaped `input_required` requests along the way. */
  private async pollTask(
    initial: McpCreateTaskResult,
    signal?: AbortSignal,
    onProgress?: (text: string) => void
  ): Promise<string> {
    const taskId = initial.taskId;
    onProgress?.(initial.statusMessage ?? "task created — waiting…");
    let pollIntervalMs = initial.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
      if (signal?.aborted) {
        this.notify("tasks/cancel", { taskId });
        throw new Error("MCP task cancelled by user");
      }
      const detailed = (await this.request(
        "tasks/get",
        { taskId },
        CALL_TIMEOUT_MS,
        signal
      )) as McpDetailedTask;
      pollIntervalMs = detailed.pollIntervalMs ?? pollIntervalMs;

      switch (detailed.status) {
        case "working":
          onProgress?.(detailed.statusMessage ?? "working…");
          continue;
        case "input_required": {
          onProgress?.(detailed.statusMessage ?? "waiting for input…");
          await this.answerInputRequired(taskId, detailed.inputRequests ?? {});
          continue;
        }
        case "completed": {
          onProgress?.(detailed.statusMessage ?? "completed");
          const text = renderToolResult(detailed.result ?? {});
          if (detailed.result?.isError) throw new Error(text || "MCP tool reported an error");
          return text || "(no output)";
        }
        case "failed":
          throw new Error(detailed.error?.message ?? "MCP task failed");
        case "cancelled":
          throw new Error("MCP task was cancelled");
      }
    }
  }

  /** Answer every `input_required` entry via elicitation, or cancel the task
   *  and throw if any entry isn't elicitation-shaped. */
  private async answerInputRequired(
    taskId: string,
    inputRequests: Record<string, McpInputRequest>
  ): Promise<void> {
    const entries = Object.entries(inputRequests);
    const unsupported = entries.find(([, req]) => req.method !== "elicitation/create");
    if (unsupported) {
      this.notify("tasks/cancel", { taskId });
      throw new Error(
        `MCP task requires unsupported input method "${unsupported[1].method}" — cancelled`
      );
    }
    if (!this.options.onElicitation) {
      this.notify("tasks/cancel", { taskId });
      throw new Error("MCP task requires elicitation, but elicitation is not supported here");
    }
    const inputResponses: Record<string, ElicitationResult> = {};
    for (const [key, req] of entries) {
      const p = req.params as {
        message?: string;
        requestedSchema?: {
          properties?: Record<string, { type?: string; title?: string; enum?: string[] }>;
        };
      };
      const fields = toElicitationFields(p?.requestedSchema ?? {});
      inputResponses[key] = await this.options.onElicitation(this.name, p?.message ?? "", fields);
    }
    await this.request("tasks/update", { taskId, inputResponses }, CALL_TIMEOUT_MS);
  }
```

Note: `toElicitationFields` and `renderToolResult` are both already module-scope functions in this same file — no import or extraction needed, confirming the design doc's proposed extraction was unnecessary since they were never methods to begin with.

- [ ] **Step 4: Update `mcpToolDef`'s `execute` to forward the new params**

In `mcpToolDef` (line ~1003), change:

```typescript
    execute: (args, _ctx, signal) => conn.callTool(spec.name, args, signal),
```

to:

```typescript
    execute: (args, _ctx, signal, onProgress) =>
      conn.callTool(spec.name, args, signal, cfg.tasks, onProgress),
```

This requires `ToolDef.execute`'s signature to accept a 4th parameter — that's Task 5. Until Task 5 lands, this line will fail to typecheck; do Task 5's type change first if your tooling checks types per-file, or accept a transient red build within this same task since both land in the same PR before the final commit. (Recommended: do Task 5's `types.ts` edit as part of this task's Step 4, then commit both together — see Step 6.)

Also apply Task 5's `types.ts` change now (pull it forward into this task to keep the build green at every commit):

In `src/types.ts`, change the `ToolDef.execute` signature (line 107):

```typescript
  execute(args: Record<string, unknown>, ctx: ToolContext, signal?: AbortSignal): Promise<string>;
```

to:

```typescript
  execute(
    args: Record<string, unknown>,
    ctx: ToolContext,
    signal?: AbortSignal,
    onProgress?: (text: string) => void
  ): Promise<string>;
```

This is purely additive per TypeScript's structural typing — every existing `execute` implementation with 2 or 3 params still satisfies this type.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test 2>&1 | tail -40`
Expected: all pass, including every pre-existing test (consent, sampling, elicitation, stdio/http) — confirming zero regressions.

- [ ] **Step 6: Commit**

```bash
git add src/mcp/client.ts src/types.ts src/test/mcp.test.ts
git commit -m "feat(mcp): implement Tasks extension poll loop with elicitation-only input_required"
```

---

### Task 4: `input_required` rejection test for non-elicitation requests

**Files:**

- Test: `src/test/mcp.test.ts`

**Interfaces:**

- Consumes: `answerInputRequired`'s fail-closed behavior (Task 3, already implemented) — this task is pure test coverage for a case Task 3's implementation already handles, isolated here because it's a distinct scenario worth its own reviewable test.

- [ ] **Step 1: Write the test**

Add to `src/test/mcp.test.ts`:

```typescript
test("a task whose input_required request isn't elicitation-shaped cancels the task and throws", async () => {
  let sawCancel = false;
  const script = [
    "const rl = require('readline').createInterface({ input: process.stdin });",
    "const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');",
    "rl.on('line', (l) => {",
    "  if (!l.trim()) return;",
    "  const m = JSON.parse(l);",
    "  if (m.method === 'initialize')",
    "    return send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params.protocolVersion,",
    "      capabilities: { tools: {} }, serverInfo: { name: 'inputter', version: '1' } } });",
    "  if (m.method === 'tools/list')",
    "    return send({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'longjob' }] } });",
    "  if (m.method === 'tools/call')",
    "    return send({ jsonrpc: '2.0', id: m.id, result: { resultType: 'task', taskId: 't1', status: 'working',",
    "      createdAt: 'now', lastUpdatedAt: 'now', ttlMs: null, pollIntervalMs: 5 } });",
    "  if (m.method === 'tasks/cancel') { process.stderr.write('SAW_CANCEL\\n'); return; }",
    "  if (m.method === 'tasks/get')",
    "    return send({ jsonrpc: '2.0', id: m.id, result: { taskId: 't1', status: 'input_required',",
    "      createdAt: 'now', lastUpdatedAt: 'now', ttlMs: null,",
    "      inputRequests: { r1: { method: 'sampling/createMessage', params: {} } } } });",
    "});",
  ].join("\n");
  const tools = await loadMcpTools({
    inputter: { command: process.execPath, args: ["-e", script], tasks: true },
  });
  // Cancellation is fire-and-forget (notify, not request) — read the child's
  // stderr line to confirm it was actually sent, rather than only checking
  // the thrown error, since notify() swallows its own transport errors.
  const status = mcpStatus().find((s) => s.name === "inputter");
  void status;
  await assert.rejects(
    tools[0].execute({}, { workspace: "." }),
    /unsupported input method "sampling\/createMessage"/
  );
});
```

Simplify: drop the unused `sawCancel`/`SAW_CANCEL` stderr plumbing if it proves fragile in practice — the important assertion is the thrown error naming the method; the `tasks/cancel` notification is fire-and-forget by design (see Task 3's `answerInputRequired`) and doesn't need a reply, so asserting the throw is sufficient. Keep the test simple:

```typescript
test("a task whose input_required request isn't elicitation-shaped cancels the task and throws", async () => {
  const script = [
    "const rl = require('readline').createInterface({ input: process.stdin });",
    "const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');",
    "rl.on('line', (l) => {",
    "  if (!l.trim()) return;",
    "  const m = JSON.parse(l);",
    "  if (m.method === 'initialize')",
    "    return send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params.protocolVersion,",
    "      capabilities: { tools: {} }, serverInfo: { name: 'inputter', version: '1' } } });",
    "  if (m.method === 'tools/list')",
    "    return send({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'longjob' }] } });",
    "  if (m.method === 'tools/call')",
    "    return send({ jsonrpc: '2.0', id: m.id, result: { resultType: 'task', taskId: 't1', status: 'working',",
    "      createdAt: 'now', lastUpdatedAt: 'now', ttlMs: null, pollIntervalMs: 5 } });",
    "  if (m.method === 'tasks/get')",
    "    return send({ jsonrpc: '2.0', id: m.id, result: { taskId: 't1', status: 'input_required',",
    "      createdAt: 'now', lastUpdatedAt: 'now', ttlMs: null,",
    "      inputRequests: { r1: { method: 'sampling/createMessage', params: {} } } } });",
    "});",
  ].join("\n");
  const tools = await loadMcpTools({
    inputter: { command: process.execPath, args: ["-e", script], tasks: true },
  });
  await assert.rejects(
    tools[0].execute({}, { workspace: "." }),
    /unsupported input method "sampling\/createMessage"/
  );
});
```

- [ ] **Step 2: Run and verify it passes**

Run: `npm run build && node --test dist/test/mcp.test.js 2>&1 | grep -A3 "not elicitation-shaped"`
Expected: PASS (Task 3's implementation already handles this; this step confirms it).

- [ ] **Step 3: Write the `input_required` → elicitation → completes test**

Add:

```typescript
test("a task that goes to input_required, gets answered via elicitation, then completes", async () => {
  const script = [
    "const rl = require('readline').createInterface({ input: process.stdin });",
    "const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');",
    "let asked = false;",
    "let updateResponses = null;",
    "rl.on('line', (l) => {",
    "  if (!l.trim()) return;",
    "  const m = JSON.parse(l);",
    "  if (m.method === 'initialize')",
    "    return send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params.protocolVersion,",
    "      capabilities: { tools: {} }, serverInfo: { name: 'asker', version: '1' } } });",
    "  if (m.method === 'tools/list')",
    "    return send({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'longjob' }] } });",
    "  if (m.method === 'tools/call')",
    "    return send({ jsonrpc: '2.0', id: m.id, result: { resultType: 'task', taskId: 't1', status: 'working',",
    "      createdAt: 'now', lastUpdatedAt: 'now', ttlMs: null, pollIntervalMs: 5 } });",
    "  if (m.method === 'tasks/update') {",
    "    updateResponses = m.params.inputResponses;",
    "    return send({ jsonrpc: '2.0', id: m.id, result: {} });",
    "  }",
    "  if (m.method === 'tasks/get') {",
    "    if (!asked) {",
    "      asked = true;",
    "      return send({ jsonrpc: '2.0', id: m.id, result: { taskId: 't1', status: 'input_required',",
    "        createdAt: 'now', lastUpdatedAt: 'now', ttlMs: null,",
    "        inputRequests: { proceed: { method: 'elicitation/create', params: { message: 'Proceed?',",
    "          requestedSchema: { properties: { ok: { type: 'boolean', title: 'OK' } } } } } } } });",
    "    }",
    "    return send({ jsonrpc: '2.0', id: m.id, result: { taskId: 't1', status: 'completed',",
    "      createdAt: 'now', lastUpdatedAt: 'now', ttlMs: null,",
    "      result: { content: [{ type: 'text', text: 'got:' + JSON.stringify(updateResponses) }] } } });",
    "  }",
    "});",
  ].join("\n");
  const elicitCalls: { message: string }[] = [];
  const tools = await loadMcpTools(
    { asker: { command: process.execPath, args: ["-e", script], tasks: true } },
    {
      tracer: NOOP_TRACER,
      onElicitation: async (_server, message) => {
        elicitCalls.push({ message });
        return { action: "accept" as const, content: { ok: true } };
      },
    }
  );
  const out = await tools[0].execute({}, { workspace: "." });
  assert.equal(elicitCalls.length, 1);
  assert.equal(elicitCalls[0].message, "Proceed?");
  assert.match(out, /"proceed":\{"action":"accept","content":\{"ok":true\}\}/);
});
```

- [ ] **Step 4: Run and verify it passes**

Run: `npm run build && node --test dist/test/mcp.test.js 2>&1 | grep -A5 "input_required.*elicitation"`
Expected: PASS.

- [ ] **Step 5: Run the full suite and build**

Run: `npx tsc --noEmit && npm test`
Expected: everything passes.

- [ ] **Step 6: Commit**

```bash
git add src/test/mcp.test.ts
git commit -m "test(mcp): cover Tasks input_required elicitation and rejection paths"
```

---

### Task 5: `AgentHandlers.onToolProgress` + `ToolExecutor` threading

**Files:**

- Modify: `src/types.ts` (`AgentHandlers` interface, line 136)
- Modify: `src/agent/toolExecutor.ts` (the tool-execution block ~line 344-372, and `executeWithTimeout`, line 395)
- Test: none new at this layer (covered end-to-end by Task 6's `useAgent.test.tsx` case); `ToolExecutor` has no existing dedicated unit test file per the codebase's convention (its behavior is exercised via `useAgent.test.tsx`'s fake-agent harness) — confirm with `grep -rn "ToolExecutor" src/test/` before assuming this, and if a `toolExecutor.test.ts` exists, add a case there instead.

**Interfaces:**

- Consumes: `ToolDef.execute`'s new 4th `onProgress?` parameter (Task 3, already added to `types.ts`).
- Produces: `AgentHandlers.onToolProgress?(id: string, name: string, text: string): void` — consumed by Task 6 (`useAgent.ts`). Note the signature includes `name` (not just `id`/`text`) so a consumer can log/filter by tool without a separate lookup — confirm this matches Task 6's usage before finalizing; if `useAgent.ts` only ever needs `id`, drop `name` to match the design doc's simpler `(id, text)` signature exactly. **Use the design doc's signature: `onToolProgress?(id: string, text: string): void` — no `name` param**, to stay consistent with what's written in section 7 of the spec.

- [ ] **Step 1: Add `onToolProgress` to `AgentHandlers`**

In `src/types.ts`, in the `AgentHandlers` interface (~line 136-162), add after `onToolEnd`:

```typescript
  /** Fires while a tool is running that supports progress updates (currently
   *  only MCP Tasks-backed calls) — zero or more times before onToolEnd. */
  onToolProgress?(id: string, text: string): void;
```

- [ ] **Step 2: Check for an existing toolExecutor test file**

Run: `ls src/test/ | grep -i toolexec`
If a file exists, read it to match its conventions for Step 4 below. If not, proceed — coverage lands via Task 6.

- [ ] **Step 3: Thread `onProgress` through `ToolExecutor`**

In `src/agent/toolExecutor.ts`, find the call to `this.executeWithTimeout(tool, args, signal)` (~line 347). Immediately before it, add:

```typescript
const onProgress = (text: string) => handlers.onToolProgress?.(id, text);
```

Then change the call to:

```typescript
let output = await this.executeWithTimeout(tool, args, signal, onProgress);
```

- [ ] **Step 4: Update `executeWithTimeout` to accept and forward `onProgress`**

Change its signature (line ~395):

```typescript
  private async executeWithTimeout(
    tool: ToolDef,
    args: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<string> {
    const limit = tool.timeoutMs ?? this.host.toolTimeoutMs;
    const work = tool.execute(args, this.host.ctx, signal);
```

to:

```typescript
  private async executeWithTimeout(
    tool: ToolDef,
    args: Record<string, unknown>,
    signal?: AbortSignal,
    onProgress?: (text: string) => void
  ): Promise<string> {
    const limit = tool.timeoutMs ?? this.host.toolTimeoutMs;
    const work = tool.execute(args, this.host.ctx, signal, onProgress);
```

- [ ] **Step 5: Verify the build**

Run: `npx tsc --noEmit`
Expected: no errors. `handlers` must already be in scope at the call site in Step 3 — confirm by reading the surrounding function signature (it's the method containing line 344's `handlers.onToolStart(id, name, summary)`, so `handlers` is already a parameter there).

- [ ] **Step 6: Run the existing test suite for regressions**

Run: `npm test`
Expected: all existing tests pass unchanged (this task adds no new observable behavior yet — `onToolProgress` is optional and unused until Task 6).

- [ ] **Step 7: Commit**

```bash
git add src/types.ts src/agent/toolExecutor.ts
git commit -m "feat(agent): thread onToolProgress from ToolDef.execute through ToolExecutor"
```

---

### Task 6: `useAgent` — `inFlight.status` + `App.tsx` live status rendering

**Files:**

- Modify: `src/ui/useAgent.ts` (the `inFlight` state declaration, line 137; the handlers object passed to `agent.runTurn`, ~line 413-457)
- Modify: `src/ui/App.tsx` (the spinner label and multi-tool list, ~line 555-582)
- Test: `src/test/useAgent.test.tsx`

**Interfaces:**

- Consumes: `AgentHandlers.onToolProgress?(id, text)` (Task 5).
- Produces: `inFlight` entries of shape `{ id: string; name: string; summary: string; status?: string }` — consumed by `App.tsx`'s rendering (this same task).

- [ ] **Step 1: Write the failing `useAgent.test.tsx` case**

In `src/test/useAgent.test.tsx`, near the existing "a tool call in flight is tracked and cleared when it ends" test (~line 292-303), add:

```typescript
test("onToolProgress updates the matching inFlight entry's status", async () => {
  const agent = fakeAgent();
  let capturedInFlight: { id: string; name: string; summary: string; status?: string }[] = [];
  agent.runTurn = (async (_text, handlers) => {
    handlers.onToolStart("1", "mcp_ci_run_pipeline", "running pipeline");
    handlers.onToolProgress?.("1", "waiting for build…");
    capturedInFlight = api.inFlight;
  }) as FakeRunTurn;
  const { api } = await setup({ agent });
  await api.runAgent("run the pipeline");
  await tick();
  const entry = capturedInFlight.find((t) => t.id === "1");
  assert.equal(entry?.status, "waiting for build…");
});
```

Check the exact `tick()`/`setup()`/`fakeAgent()` helper usage against the surrounding tests in the same file — `api` must be captured via closure the same way other tests in this file read live state after awaiting (some tests read `api.inFlight` right after `await tick()` rather than capturing inside the fake `runTurn`; match whichever pattern the neighboring "tool call in flight" test at line ~292 actually uses, since `api` isn't necessarily in scope before `setup()` returns it). If `api` isn't accessible inside `agent.runTurn`'s closure (defined before `setup()` returns), restructure to check `inFlight` state via the returned `api.inFlight` synchronously after `await tick()` instead, following exactly the pattern the "tool call in flight" test (line 292) uses for `onToolStart`/`onToolEnd`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build && node --test dist/test/useAgent.test.js 2>&1 | grep -A5 "onToolProgress"`
Expected: FAIL — `onToolProgress` doesn't exist on the handlers object `useAgent` builds yet.

- [ ] **Step 3: Add `status` to the `inFlight` type and an `onToolProgress` handler**

In `src/ui/useAgent.ts`, change the `inFlight` state declaration (line 137):

```typescript
const [inFlight, setInFlight] = useState<{ id: string; name: string; summary: string }[]>([]);
```

to:

```typescript
const [inFlight, setInFlight] = useState<
  { id: string; name: string; summary: string; status?: string }[]
>([]);
```

Then, in the handlers object passed to `agent.runTurn` (~line 413-457), add `onToolProgress` alongside the existing `onToolStart`/`onToolEnd`:

```typescript
          onToolProgress: (id, text) => {
            setInFlight((prev) => prev.map((t) => (t.id === id ? { ...t, status: text } : t)));
          },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test 2>&1 | tail -40`
Expected: PASS, including all pre-existing tests in the file.

- [ ] **Step 5: Update `App.tsx`'s rendering**

In `src/ui/App.tsx` (~line 563-580), change:

```typescript
              (inFlight.length > 1
                ? `${inFlight.length} tools running (Esc to cancel)`
                : inFlight.length === 1
                  ? `${inFlight[0].summary} (Esc to cancel)`
                  : activity
```

to:

```typescript
              (inFlight.length > 1
                ? `${inFlight.length} tools running (Esc to cancel)`
                : inFlight.length === 1
                  ? `${inFlight[0].status ? `${inFlight[0].summary} — ${inFlight[0].status}` : inFlight[0].summary} (Esc to cancel)`
                  : activity
```

And the multi-tool dimmed list right below it:

```typescript
              {inFlight.map((t) => (
                <Text key={t.id} dimColor>
                  · {t.summary}
                </Text>
              ))}
```

to:

```typescript
              {inFlight.map((t) => (
                <Text key={t.id} dimColor>
                  · {t.status ? `${t.summary} — ${t.status}` : t.summary}
                </Text>
              ))}
```

- [ ] **Step 6: Manually sanity-check the build (no App.tsx test exists for this rendering detail per the codebase's convention of not snapshot-testing Ink output)**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Run the full test suite**

Run: `npm test`
Expected: all tests pass, including the new `useAgent.test.tsx` case and every pre-existing `App.tsx`-adjacent test.

- [ ] **Step 8: Commit**

```bash
git add src/ui/useAgent.ts src/ui/App.tsx src/test/useAgent.test.tsx
git commit -m "feat(ui): render live MCP task status text in the tool-call spinner"
```

---

### Task 7: README — document the `tasks` config field

**Files:**

- Modify: `README.md` (MCP servers section, ~line 684-693, right after the existing consent/sampling/elicitation paragraphs added in commit `b2b3aae`)

**Interfaces:**

- None — documentation only.

- [ ] **Step 1: Add the paragraph**

In `README.md`, after the paragraph ending "...both are declined automatically in headless/non-interactive mode." (the sampling/elicitation paragraph, ends ~line 693), add:

```markdown
Set `"tasks": true` on a server whose long-running tools (a CI pipeline, a
batch job, a human approval step) support the
[Tasks extension](https://modelcontextprotocol.io/extensions/tasks/overview):
kritya declares support for it on every call to that server, and a tool that
returns a task handle instead of blocking is polled in the background — the
spinner grows a live status suffix (e.g. "running pipeline — waiting for
build…") instead of just sitting there. A task's own `input_required` step is
answered the same way a direct `elicitation/create` request would be; a task
that asks for anything else is cancelled with an error naming what it needed.
Off by default, same reasoning as `consent`: a server has no grounds to
return a task the client never said it could handle.
```

- [ ] **Step 2: Proofread against the actual behavior**

Re-read Task 3's implementation and confirm every claim in the paragraph (per-server opt-in, live status suffix, elicitation-only input_required, cancellation on unsupported input) matches what was actually built — adjust wording if any detail drifted during implementation.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs(mcp): document the tasks config field and Tasks extension support"
```

---

## Self-Review Notes (already applied above, kept for the record)

- **Spec coverage:** Config opt-in (Task 1), capability `_meta` declaration (Task 2), poll loop incl. `working`/`completed`/`failed`/`cancelled` (Task 3), `input_required` elicitation-only handling incl. rejection (Tasks 3-4), cancellation on abort (Task 3, inside `pollTask`), UI live status (Tasks 5-6), README (Task 7), full test list from the spec's Testing section (Tasks 3-4, 6) — all covered.
- **Type consistency:** `callTool(toolName, args, signal, tasksEnabled, onProgress)` in Task 3 matches the call in `mcpToolDef`'s `execute` (Task 3 Step 4). `ToolDef.execute`'s 4th param `onProgress?: (text: string) => void` (Task 3 Step 4 / design's Task 5) matches `AgentHandlers.onToolProgress?(id, text)`'s payload type and `ToolExecutor`'s wrapping closure (Task 5). `inFlight` entries' `status?: string` field (Task 6) matches what `App.tsx` reads (Task 6 Step 5).
- **Named-type collision check:** confirmed `McpTask`/`McpDetailedTask`/`McpCreateTaskResult` (Task 2) don't collide with the pre-existing `TaskItem` (`src/types.ts`, the to-do-checklist type) — different name, different file's primary export surface.
- **No placeholders:** every step has literal code, not descriptions. Task 4 Step 1's first draft test (with `SAW_CANCEL` stderr plumbing) is explicitly superseded by the simplified version in the same step — the simplified version is what actually gets written to the file.
- **Out of scope, confirmed absent from this plan:** `notifications/tasks` push support, non-elicitation `input_required` handling, non-blocking/background turn execution, MCP Apps, Skills-over-MCP.
