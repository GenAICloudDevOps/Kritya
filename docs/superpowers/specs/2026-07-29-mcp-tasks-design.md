# MCP Tasks extension (`io.modelcontextprotocol/tasks`)

## Context

MCP's Tasks extension lets a server return a durable handle instead of
blocking `tools/call` for long-running work (CI pipelines, batch jobs, human
approval gates). The client polls `tasks/get` until the task reaches a
terminal status, answering any mid-flight input requests via `tasks/update`.
This follows the earlier
[2026-07-28 spec alignment design](2026-07-29-mcp-2026-07-28-spec-alignment-design.md),
which deliberately left Tasks out of scope. It reuses that work's
sampling/elicitation plumbing directly: the elicitation callback already
built for `elicitation/create` is the same mechanism a task's
`input_required` state needs.

Schema reference (field names/types quoted from
[experimental-ext-tasks schema.ts](https://github.com/modelcontextprotocol/experimental-ext-tasks/blob/main/schema/draft/schema.ts)):

- `TaskStatus = "working" | "input_required" | "completed" | "failed" | "cancelled"`
- `Task = { taskId, status, statusMessage?, createdAt, lastUpdatedAt, ttlMs: number | null, pollIntervalMs? }`
- `CreateTaskResult = Result & Task` (server's reply to `tools/call` in lieu of the normal result; `resultType` is `"task"`)
- `DetailedTask` (the `tasks/get` reply) is a per-status union adding `inputRequests` (on `input_required`), `result` (on `completed`), or `error` (on `failed`)
- `InputRequest = CreateMessageRequest | ListRootsRequest | ElicitRequest` — full JSON-RPC request objects, keyed arbitrarily in an `inputRequests` map
- `UpdateTaskRequest.params = { taskId, inputResponses }`, keyed the same way
- `CancelTaskRequest.params = { taskId }`

Scope decisions from brainstorming (see conversation, not re-litigated here):
poll-only for v1 (no `notifications/tasks` push support); block the current
turn while a task polls, with no client-side timeout cap beyond the task's
own `ttlMs`/server behavior; handle only elicitation-shaped `input_required`
requests, rejecting anything else by cancelling the task; best-effort
`tasks/cancel` on user abort; capability declared per-server via explicit
config opt-in (not on-by-default); and a live status line in the UI while a
task polls.

## 1. Config — per-server opt-in

Add `tasks?: boolean` to `McpServerConfig` (`src/config/config.ts:90-116`),
alongside the existing `consent` field. Unset/false: today's behavior,
unchanged — kritya never attaches the capability declaration, so a
task-capable server has no grounds to return a task for that connection (the
spec requires the server to check the client declared support first).

## 2. Capability declaration

Per the extension's negotiation mechanism (distinct from the core
`initialize` capabilities used for sampling/elicitation — Tasks is an
extension, negotiated per-request), a task-enabled server's `tools/call`
request gets an extra `_meta` field:

```jsonc
{
  "_meta": {
    "io.modelcontextprotocol/clientCapabilities": {
      "extensions": { "io.modelcontextprotocol/tasks": {} },
    },
  },
}
```

`mcpToolDef` (`client.ts:985`) needs the server's `tasks` flag alongside the
`consent` flag it already receives — widen its `cfg` parameter from
`Pick<McpServerConfig, "consent">` to `Pick<McpServerConfig, "consent" | "tasks">`.

## 3. `McpConnection.callTool` — task-aware

`callTool` (`client.ts:496`) gains an optional 4th parameter,
`onProgress?: (text: string) => void` (see section 7), and internal
task-handling logic:

1. Build the `tools/call` params; attach the `_meta` block from section 2
   when the server config passed the `tasks` flag through.
2. Send via the existing `request()` — task creation must ack synchronously
   per spec, so the existing `CALL_TIMEOUT_MS` still applies to this first
   call.
3. If the result's `resultType === "task"` (a `CreateTaskResult`), enter the
   poll loop below. Otherwise, handle the result exactly as today — this is
   the path every non-task-enabled server, and any task-enabled server whose
   server-side chose not to use a task, continues to take.

No change is needed to the outer per-call timeout kritya already applies:
`mcpToolDef` sets `timeoutMs: 0` for every MCP tool unconditionally
(`client.ts:998`, "every request already carries CALL_TIMEOUT_MS") — the poll
loop can run indefinitely without touching that mechanism, since each
individual `tasks/get` call has its own short `CALL_TIMEOUT_MS`, not the
overall task duration.

## 4. Poll loop

```
onProgress(initial.statusMessage ?? "task created — waiting…")
loop:
  sleep(current.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS)
  if signal aborted:
    notify("tasks/cancel", { taskId })  // fire-and-forget, best-effort
    throw Error("MCP task cancelled by user")
  reply = request("tasks/get", { taskId }, CALL_TIMEOUT_MS, signal)  // DetailedTask
  onProgress(reply.statusMessage ?? <generic phrase for reply.status>)
  switch reply.status:
    "working":         continue looping
    "input_required":  handle inputRequests (section 5), tasks/update, continue looping
    "completed":       return renderToolResult(reply.result)  // same render path as a sync result
    "failed":          throw Error(reply.error.message ?? "MCP task failed")
    "cancelled":       throw Error("MCP task was cancelled")
```

`DEFAULT_POLL_INTERVAL_MS` is a new constant (proposed: 2000ms) used only
when the server omits `pollIntervalMs`.

## 5. `input_required` — elicitation only

Each entry in `inputRequests` is a full JSON-RPC request object. If **every**
entry has `method === "elicitation/create"`: for each, translate its
`params.requestedSchema` using the same schema-translation helper
`onServerRequest`'s `elicitation/create` branch already uses (extract it into
a shared function so both call sites use one implementation), call the
existing `onElicitation` callback, and collect the results into an
`inputResponses` map keyed identically to `inputRequests`. Send
`tasks/update({ taskId, inputResponses })`, then resume polling.

If **any** entry's method isn't `elicitation/create` (i.e. it's a
`CreateMessageRequest` or `ListRootsRequest`), send `tasks/cancel({ taskId })`
and throw an error naming the unsupported method — the same fail-closed
pattern as the existing nested-schema elicitation rejection, rather than
guessing at an unimplemented request type.

## 6. Cancellation

The `signal` already passed into `callTool` (turn abort / kill switch) is
checked at the top of each poll iteration (section 4). On abort, send
`tasks/cancel` best-effort before rejecting — mirrors the existing
`notifications/cancelled` courtesy `request()` already sends on abort
(`client.ts:370`). Cancellation is cooperative per spec; the server may not
honor it, and kritya doesn't wait to find out.

## 7. UI — live status text

Plumbing from the poll loop up to the screen, bottom to top:

1. `McpConnection.callTool`'s new `onProgress` (section 3) fires once
   immediately on task creation, then again after every poll (section 4).
2. `mcpToolDef`'s `execute` forwards its new 4th parameter straight to
   `callTool`.
3. `ToolDef.execute` (`types.ts:107`) gains a matching optional 4th
   parameter, `onProgress?(text: string): void`. Purely additive: existing
   tool implementations with shorter parameter lists remain valid — TypeScript
   allows a function with fewer parameters to satisfy a type expecting more.
4. `ToolExecutor` (`toolExecutor.ts`) builds
   `const onProgress = (text: string) => handlers.onToolProgress?.(id, text);`
   and threads it through `executeWithTimeout` into `tool.execute(...)`.
5. `AgentHandlers` (`types.ts:136`) gains
   `onToolProgress?(id: string, text: string): void;` — optional, so
   headless/subagent handler objects need no changes.
6. `useAgent.ts`: the `inFlight` entries (`{ id, name, summary }`) gain a
   `status?: string` field; the new `onToolProgress` handler does
   `setInFlight((prev) => prev.map((t) => (t.id === id ? { ...t, status: text } : t)))`.
7. `App.tsx`: the spinner label (single in-flight tool) and the multi-tool
   list both render `t.status ? `${t.summary} — ${t.status}` : t.summary`
   instead of bare `t.summary` — a task-backed call's line grows a live
   suffix; every other tool call renders exactly as it does today.

## Error handling

- `failed` task: throw using `reply.error.message`, same shape existing MCP
  tool-call errors already surface to the model.
- `cancelled` task (server-initiated, not user abort): throw a clear
  "task was cancelled" error.
- Unsupported `input_required` request type: cancel the task, throw naming
  the unsupported method (section 5) — never silently drop it or guess.
- A server returning a task without the client having declared the
  capability shouldn't happen; if it does, the malformed-response path
  already used for any unexpected `tools/call` result shape applies (no new
  handling needed).

## Testing

Same convention as the rest of the MCP client: `node:test` + fake stdio
servers (inline JS, spawned via `process.execPath -e`) driven through
`loadMcpTools`, in `src/test/mcp.test.ts`. New cases:

- a task that completes on the first poll (result matches what a synchronous
  call would have returned)
- a task that needs multiple poll rounds before completing
- a task that goes to `input_required`, gets answered via the elicitation
  callback, and then completes
- a task that ends `failed`, and one that ends `cancelled`
- a task whose `input_required` request isn't elicitation-shaped — confirms
  `tasks/cancel` is sent and a clear error is thrown
- confirms the `_meta` capability declaration is attached only when
  `tasks: true` is configured for that server, and never sent otherwise
- `onProgress` fires with the expected sequence of status strings across a
  multi-poll task

Plus one `useAgent.test.tsx` case: an `onToolProgress` call updates the
matching `inFlight` entry's `status` field.

## Out of scope (future passes)

- `notifications/tasks` server push (poll-only for v1).
- Non-elicitation `input_required` requests (sampling/roots mid-task).
- Non-blocking/background turn execution — the current turn still waits on
  the poll loop; teaching the agent loop to suspend a step and resume later
  is a bigger architectural change than this design covers.
- MCP Apps, Skills-over-MCP — unrelated extensions, no dependency here.
