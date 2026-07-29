# MCP 2026-07-28 spec alignment: sampling, elicitation, per-tool consent

## Context

MCP's 2026-07-28 spec revision adds several capabilities kritya's hand-rolled
MCP client (`src/mcp/client.ts`) doesn't implement. This design covers the
four highest-value, lowest-risk pieces: the protocol version bump, sampling,
elicitation, and per-tool-call consent. MCP Apps, Tasks, and Skills-over-MCP
are deliberately out of scope — MCP Apps needs a separate design (unclear fit
for a terminal UI), Tasks and Skills-over-MCP are lower priority and will get
their own design passes later.

Kritya already has the two building blocks these features need:

- `ProviderClient` (`src/provider/client.ts`) — the agent's own LLM connection,
  reusable for sampling.
- The `requestPermission` Promise/phase pattern (`src/agent/toolExecutor.ts`
  → `src/ui/useAgent.ts` → `src/ui/App.tsx`) — the existing "pause mid-turn,
  show an Ink prompt, resume on user decision" idiom, reusable for elicitation
  and consent.

## 1. Protocol version bump

`PROTOCOL_VERSION` at `src/mcp/client.ts:31` changes from `"2025-06-18"` to
`"2026-07-28"`. No other change: `initialize()` already adopts whatever
version the server echoes back (`client.ts:323`), so this is safe even
against servers that only understand the older version.

## 2. Sampling capability

**Capability declaration**: add `sampling: {}` to the `capabilities` object
sent in `initialize()` (`client.ts:317`).

**Handling `sampling/createMessage`**: `onServerRequest` (`client.ts:233`)
gains a branch for this method. It receives the server's `messages`,
optional `systemPrompt`, and `maxTokens`, and needs to produce a completion.

Threading: `McpConnection`/`connectServer` already accepts an options bag
(`McpLoadOptions`, referenced at `client.ts:511`) for things like tracer and
audit log. Add a `sampleCallback` field carrying a function backed by
`ProviderClient.chat` (or a slimmed-down variant that takes raw messages and
returns a single completion, not a full agent turn). This callback is
supplied once when servers are loaded (wherever `loadMcpTools`/`connectServer`
is invoked, near where `ProviderClient` is already constructed).

**User visibility**: a server using sampling spends the user's model quota
without them typing anything. Route every sampling request through the same
permission-prompt pattern used for tool calls: first sampling request from a
given server in a session prompts "Server X wants to use your model to
generate text — allow?" with `yes` / `always` (this session) / `no` options,
reusing `PermissionDecision` semantics. A `no` returns a JSON-RPC error
(`-32603` or similar), not a hang.

**Response shape**: `{ role: "assistant", content: { type: "text", text },
model, stopReason }` per spec.

## 3. Elicitation capability

**Capability declaration**: add `elicitation: {}` to `initialize()`.

**Handling `elicitation/create`**: server sends a `message` (string) and a
JSON schema describing the expected response shape. Support only flat
schemas of string / enum / boolean fields for v1 — reject (JSON-RPC error,
not a guess) any schema with nesting or unsupported types, with a message
naming the unsupported field.

**UI plumbing** (mirrors `requestPermission` exactly):

- `src/types.ts`: add `"elicitation"` to the `Phase` union.
- `src/ui/useAgent.ts`: add `requestElicitation(message, schema)` returning
  `Promise<ElicitationResult>`, implemented as
  `new Promise((resolve) => { setElicitation({ message, schema, resolve }); setPhase("elicitation"); })`.
- New `src/ui/ElicitationPrompt.tsx`: renders the message and a form (text
  input / `SelectList` for enum / yes-no for boolean) built from the schema
  fields, with three possible outcomes:
  - **Accept**: user fills the form, submits → resolves with
    `{ action: "accept", content: {...} }`.
  - **Decline**: explicit "no" control → resolves with `{ action: "decline" }`.
  - **Cancel**: escape/abort → resolves with `{ action: "cancel" }`.
- `src/ui/App.tsx`: render `<ElicitationPrompt .../>` when `phase === "elicitation"`.

`onServerRequest`'s `elicitation/create` branch calls `requestElicitation`
(threaded down the same way as the sampling callback) and translates the
three outcomes into the spec's `{ action, content? }` result shape.

## 4. Per-tool-call consent

**Config**: add `consent?: "trust-hints" | "always-confirm"` to
`McpServerConfig` (`src/config/config.ts:90-116`). Default
(`"trust-hints"`, or field omitted) preserves current behavior.

**Enforcement**: `mcpToolDef` (`client.ts:867`) currently sets
`requiresPermission: !isReadOnly(spec)`. Change to:
`requiresPermission: cfg.consent === "always-confirm" ? true : !isReadOnly(spec)`.
No new UI — this flows through the existing `requestPermission`/
`PermissionPrompt` path in `toolExecutor.ts` untouched.

## Error handling

- Sampling/elicitation requests when the corresponding capability wasn't
  declared by kritya (shouldn't happen, but a server could send one anyway):
  respond with `-32601 method not found`, same as any other unsupported
  method today.
- User declines sampling or cancels elicitation: proper JSON-RPC error
  response, never silently hang or fabricate a response.
- Unsupported elicitation schema: JSON-RPC error naming the unsupported
  field, not a best-effort guess at rendering it.

## Testing

- Unit tests for the new `onServerRequest` branches: correct handling of
  `sampling/createMessage` and `elicitation/create` request/response shapes,
  and their error paths (decline, cancel, unsupported schema, capability not
  declared).
- Unit test for `consent: "always-confirm"` forcing `requiresPermission: true`
  in `mcpToolDef` regardless of `readOnlyHint`.
- Integration-style test exercising the full Promise/phase resume cycle for
  both sampling and elicitation (mock transport sends the server request,
  assert the UI phase changes, simulate a user decision, assert the
  JSON-RPC response sent back matches) — consistent with this project's
  preference for integration coverage over isolated unit tests.

## Out of scope (future design passes)

- MCP Apps extension (inline interactive UI) — needs its own design; unclear
  fit for a terminal/Ink UI.
- Tasks extension (async long-running ops via polling/durable handles).
- Skills-over-MCP — would need reconciling with kritya's existing separate
  skills system.
