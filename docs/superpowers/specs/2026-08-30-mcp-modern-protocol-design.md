# MCP 2026-07-28 modern (per-request) protocol support

## Context

Kritya's MCP client (`src/mcp/client.ts`, `src/mcp/transport.ts`) speaks only
the **legacy** era of MCP: an `initialize` handshake, a stateful session
(HTTP `Mcp-Session-Id`), and server-initiated JSON-RPC requests
(`sampling/createMessage`, `elicitation/create`, `roots/list`) answered via
`onServerRequest`. `PROTOCOL_VERSION` is set to `"2026-07-28"`, but that's a
label only — the wire behavior predates the revision it claims.

The actual 2026-07-28 revision removes the handshake entirely. Per
`/specification/2026-07-28/basic/versioning`:

- **Modern** servers (2026-07-28+): stateless, per-request. Every request
  carries `_meta["io.modelcontextprotocol/protocolVersion"]`,
  `clientCapabilities`, optionally `clientInfo`. No `initialize`, no session.
- **Legacy** servers (2025-11-25 and earlier): today's handshake model.
- **Dual-era** servers: support both, keyed off how the client opens (an
  `initialize` request selects legacy; per-request `_meta` selects modern).

A client that wants to reach both kinds must detect which era a server
speaks and behave accordingly. Kritya currently cannot detect or speak the
modern era at all, so it will fail against any modern-only server (see
compatibility matrix in the versioning spec: Legacy client + Modern server =
Fails).

This design covers three sub-projects, built in order:

1. **Modern connection core** — era detection + the modern wire format for
   `tools/list`, `tools/call`, `prompts/list`, `resources/list`.
2. **MRTR** — sampling/elicitation/roots for modern connections.
3. **`x-mcp-header` parameter mirroring** — required-by-spec HTTP header
   mirroring for tool-call arguments a server annotates.

Explicitly out of scope (candidates for a later design pass, not silently
dropped): Tasks extension under modern semantics, `subscriptions/listen`
change notifications, MCP Apps (no fit for a terminal UI), Skills over MCP,
`icons` metadata, and JSON-Schema dialect/`$ref`/composition-keyword safety
hardening.

## Architecture

Rather than branching legacy/modern logic inside the existing
`McpConnection` class, the two eras get separate implementations behind a
shared minimal surface:

```ts
interface McpServerConnection {
  initialize(): Promise<{
    tools: McpToolSpec[];
    prompts: McpPromptSpec[];
    resources: McpResourceSpec[];
  }>;
  getPrompt(name: string, args: Record<string, string>): Promise<string>;
  readResource(uri: string): Promise<string>;
  callTool(
    toolName: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
    tasksEnabled?: boolean,
    onProgress?: (text: string) => void
  ): Promise<string>;
  close(): void;
}
```

- `McpConnection` (existing class in `client.ts`) is renamed in place to
  implement this interface explicitly but is **otherwise unchanged** — the
  legacy path keeps working exactly as today.
- `ModernMcpConnection` (new, `src/mcp/clientModern.ts`) implements the same
  interface around the modern wire format from scratch.
- `connectServer()` in `src/mcp/servers.ts` calls a new `detectEra()` step
  before constructing a connection, then instantiates
  `McpConnection` or `ModernMcpConnection` accordingly. Everything downstream
  of `initialize()` returning (`toolAllowed`, `mcpToolDef`, trust
  fingerprinting, prompt/resource registration, `McpServerStatus` reporting)
  is untouched — it already only depends on the shared interface's return
  shapes.

### Era detection (`src/mcp/eraDetect.ts`)

```ts
type Era = "modern" | "legacy";
function detectEra(name: string, cfg: McpServerConfig, workspace: string): Promise<Era>;
```

- **stdio**: spawn the process (reusing `planSpawn`/the same env-minimization
  as `StdioTransport`), send a `server/discover` request with modern `_meta`.
  Three outcomes per spec:
  - `DiscoverResult` back → modern. Keep the process; `ModernMcpConnection`
    reuses this same spawned process rather than relaunching.
  - A recognized modern JSON-RPC error (`UnsupportedProtocolVersionError`
    etc.) → modern, but log/report the version mismatch as a connection
    failure (no fallback — a modern server that rejects our version isn't
    legacy).
  - Any other error, or no response within `CONNECT_TIMEOUT_MS` → legacy.
    Kill the probe process; `McpConnection` launches its own fresh one
    (matches today's behavior exactly, so no process-reuse complexity on the
    legacy path).
- **HTTP**: POST a modern-shaped request (`server/discover`, modern headers)
  to the configured URL first.
  - Success (200, `DiscoverResult`) → modern.
  - `400`/`404`/`405` whose body is a recognized modern JSON-RPC error →
    modern (version mismatch or similar — report, don't fall back).
  - Anything else (including a body that isn't a recognized modern error) →
    legacy. Proceed with the existing `HttpTransport` + `initialize()` flow.
- Detected era is **not** persisted across kritya restarts (confirmed with
  user) — re-probed once per `connectServer()` call, i.e. once per session
  per configured server. This costs one extra round trip per server per
  startup and self-heals if a server's era changes between runs.
- `assertSafeUrl` / private-network and plaintext-HTTP checks run exactly
  once, before era detection, shared by both paths (no duplication of the
  security gate).

### Modern transport (`src/mcp/transportModern.ts`)

- `StdioTransport` is reused as-is for modern stdio — framing is identical
  (newline-delimited JSON-RPC); only message _content_ differs, which
  `ModernMcpConnection` constructs.
- HTTP gets a new `ModernHttpTransport` class (not a branch inside the
  existing `HttpTransport`) because the contract differs enough to make a
  shared implementation more confusing than two focused ones:
  - No `Mcp-Session-Id` capture/replay.
  - Required headers on every POST: `MCP-Protocol-Version`, `Mcp-Method`,
    and (for `tools/call`/`resources/read`/`prompts/get`) `Mcp-Name`,
    Base64-sentinel-encoded per spec when the value isn't safe plain ASCII.
  - Every request body carries `_meta` with `protocolVersion`,
    `clientCapabilities`, optionally `clientInfo` — no separate
    `initialize`/`notifications/initialized` step.
  - Same redirect/same-origin/OAuth-401-retry logic as today's
    `HttpTransport` is reused verbatim (extracted into a small shared helper
    if duplication gets ugly, but not a hard requirement for v1) — OAuth
    behavior must be explicitly re-verified against the new transport, not
    assumed to carry over untested.
  - No `DELETE`-on-close (no session to terminate).

### Response handling

Every modern response's `result.resultType` is checked:

- `"complete"` (or absent, for backward tolerance) → unwrap normally.
- `"input_required"` → **Sub-project 1 rejects this** with a clear error:
  `"MCP server "<name>" requires an interactive capability (sampling,
elicitation, or roots) that modern-mode kritya does not yet support"`.
  Sub-project 2 replaces this branch with the real MRTR retry loop.
- Anything else → treated as a protocol error (unrecognized `resultType` is
  invalid per spec) and surfaced the same way any other connection failure
  is today (`status.error`, audit log via `trace?.audit?.logTool`).

Version/header errors (`UnsupportedProtocolVersionError` -32022,
`HeaderMismatch` -32020, `MissingRequiredClientCapabilityError` -32021) flow
into the existing `status.error` reporting path in `McpServerStatus` — same
`/mcp` table and audit-log surface as any other connection failure, just new
causes and clearer messages (e.g. naming the missing capability from
`data.requiredCapabilities`).

## Sub-project 2: MRTR (sampling / elicitation / roots)

Modern-era servers never send their own JSON-RPC request for
sampling/elicitation/roots. Instead, `callTool` (or any request) can come
back with `resultType: "input_required"` and an `inputRequests` map (same
shape kritya's existing Tasks polling already uses for `inputRequests` —
see `answerInputRequired` in `client.ts`, which this reuses conceptually).

`ModernMcpConnection` gains a loop, replacing Sub-project 1's "reject
input_required" branch:

1. Receive `InputRequiredResult` with one or more `inputRequests` entries
   (each a full JSON-RPC-shaped request: `sampling/createMessage`,
   `elicitation/create`, or `roots/list`).
2. For each entry, dispatch to the same `onSampling`/`onElicitation`
   callbacks (`McpConnectionOptions`) already threaded through from the UI
   layer — no new UI plumbing needed, this reuses `SamplingRequest`/
   `SamplingResult`/`ElicitationField`/`ElicitationResult` and the existing
   Ink prompt components verbatim.
3. `roots/list` is answered locally (same static workspace-root response
   `McpConnection` already gives, no callback needed).
4. Resend the **original** request with `inputResponses` attached, per
   MRTR's retry pattern — not a new request, the same `tools/call` (or
   whichever) with the prior `inputRequests` answered.
5. Repeat until a `resultType: "complete"` (or terminal error) comes back.
   Bound the number of round trips (reuse `CALL_TIMEOUT_MS`-style ceiling)
   so a misbehaving server can't loop forever.

Decline/cancel/error semantics match today's `onSampling`/`onElicitation`
callback contracts exactly (a `{ ok: false }` or `{ action: "decline" }`
becomes the corresponding `inputResponses` entry, not a thrown error, so the
server gets a proper answer rather than the request just dying).

## Sub-project 3: `x-mcp-header` parameter mirroring (HTTP only)

Applies only to `ModernHttpTransport`'s `tools/call`. Per
`/specification/2026-07-28/basic/transports/streamable-http`:

1. When wrapping a modern tool spec (`mcpToolDef`-equivalent for modern
   connections), scan `inputSchema` for properties with `x-mcp-header`,
   validating the constraints (non-empty, HTTP token-safe, no CR/LF,
   case-insensitively unique, primitive type only, statically reachable via
   `properties` chains only — no `items`/composition/`$ref` in the path).
   A tool with an invalid `x-mcp-header` annotation is **excluded** from
   `tools/list`'s result entirely (spec: "MUST exclude the invalid tool"),
   with a logged warning naming the tool and reason.
2. On `tools/call`, for each valid annotated property present (non-null) in
   the call arguments, mirror its value into `Mcp-Param-{Name}`, encoding
   per the Value Encoding rules (plain ASCII as-is; otherwise
   `=?base64?...?=` of the UTF-8 bytes, including the sentinel-collision
   case where a plain value happens to already look like the sentinel
   pattern).
3. If a `HeaderMismatch` comes back specifically for a missing/invalid
   `Mcp-Param-*`, re-fetch `tools/list` once (schema may have changed) and
   retry the call once with fresh headers, per spec guidance — not an
   unbounded retry loop.

stdio transport ignores `x-mcp-header` entirely (spec: clients using other
transports MAY ignore it).

## Testing

Matches existing conventions exactly — no new mocking approach:

- Real child-process test servers via `process.execPath -e "<inline JS>"`
  speaking newline-delimited JSON-RPC, same as `ROOTS_SERVER`/
  `SAMPLING_SERVER` patterns already in `src/test/mcp.test.ts`.
- New modern-era test servers respond to `server/discover` and modern
  per-request `_meta` shapes instead of `initialize`.
- New tests live in `src/test/mcpModern.test.ts` (kept separate from
  `mcp.test.ts` given the volume: era detection, modern tools/call,
  MRTR loop, and header-mirroring each need several cases).
- HTTP-specific tests (headers, Base64 sentinel encoding, 400-body
  inspection) use the same in-process `fetch` stub / local HTTP server
  pattern the existing `mcpOauth.test.ts`/`mcpUrlSafety.test.ts` already use
  — reuse rather than reinvent.
- Legacy-path regression: the full existing `mcp.test.ts` suite must keep
  passing unmodified — proof the legacy `McpConnection` path is untouched.

## Error handling summary

Every new failure mode (era-mismatch, header-mismatch, missing-capability,
input_required-not-yet-supported in Sub-project 1, MRTR round-trip ceiling
exceeded, invalid `x-mcp-header` tool) surfaces through the _existing_
`McpServerStatus.error` / audit-log path — no new user-facing error
surface to design, just new causes with actionable messages.

## Out of scope (tracked, not dropped)

- Tasks extension under modern MRTR semantics (needs its own look at
  whether the existing `_meta`-tagged polling model still applies).
- `subscriptions/listen` change notifications (not implemented in either
  era today).
- MCP Apps (no terminal-UI fit — permanent exclusion, not deferred).
- Skills over MCP.
- `icons` metadata.
- JSON-Schema dialect/`$ref`/composition-keyword safety hardening (2020-12
  dialect enforcement, no auto-dereference of remote `$ref`, DoS bounds).
- OAuth re-verification against `ModernHttpTransport` is called out above
  as required within Sub-project 1's implementation, not a separate
  sub-project — flagged here so it isn't missed at plan-writing time.
