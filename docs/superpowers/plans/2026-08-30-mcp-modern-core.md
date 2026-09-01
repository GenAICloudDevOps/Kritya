# MCP Modern Protocol Core (Sub-project 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give kritya's MCP client the ability to detect and connect to
"modern" (2026-07-28, per-request `_meta`, no `initialize` handshake, no
session) MCP servers on both stdio and HTTP, for the request types that
don't need server-initiated input (`tools/list`, `tools/call`,
`prompts/list`, `prompts/get`, `resources/list`, `resources/read`). Servers
still on the legacy `initialize`-handshake era keep working exactly as
today, unchanged.

**Architecture:** A new `detectEra()` probe (`server/discover`, three-way
outcome) decides per server, per `connectServer()` call, whether to build
the existing `McpConnection` (legacy, untouched) or a new
`ModernMcpConnection` (new file, modern wire format) — both implementing the
same minimal `McpServerConnection` interface so `connectServer()`'s
downstream logic (tool wrapping, trust fingerprinting, status reporting)
doesn't change. Modern HTTP gets its own `ModernHttpTransport`; modern
stdio reuses the existing `StdioTransport` since framing is unchanged.

**Tech Stack:** TypeScript, Node's built-in test runner (`node:test` +
`node:assert/strict`), no new dependencies. `npm test` builds first, then
runs `scripts/run-tests.mjs`.

**Spec:** [docs/superpowers/specs/2026-08-30-mcp-modern-protocol-design.md](../specs/2026-08-30-mcp-modern-protocol-design.md)

## Global Constraints

- No new external dependencies.
- The existing legacy path (`McpConnection`, `HttpTransport`,
  `StdioTransport`, `connectServer`'s current behavior) must not change
  behavior — the full existing `src/test/mcp.test.ts` suite must keep
  passing unmodified throughout this plan.
- Era detection is **not** persisted across kritya restarts — re-probed
  once per `connectServer()` call.
- `assertSafeUrl` (private-network / plaintext-HTTP rejection) runs exactly
  once per HTTP server, before era detection.
- A modern response with `resultType: "input_required"` is rejected with a
  clear error in this plan (MRTR support is Sub-project 2, a separate plan)
  — never hang, never silently drop the request.
- Test files live in `src/test/`, never colocated with source. New tests go
  in `src/test/mcpModern.test.ts` (new file — the existing `mcp.test.ts`
  stays legacy-only).
- Follow this repo's existing MCP test convention: real child-process test
  servers via `process.execPath -e "<inline JS>"` speaking
  newline-delimited JSON-RPC over stdio, driven through the public
  `loadMcpTools`/`connectServer` functions — never a fake `Transport` or
  direct construction of an unexported class.
- `import assert from "node:assert/strict"; import { test } from "node:test";`
  — flat `test(name, fn)` calls, no `describe`, no `expect`, no mocking
  library.

---

### Task 1: `server/discover` request/response types and era-detection result type

**Files:**

- Create: `src/mcp/eraDetect.ts`
- Test: Create `src/test/eraDetect.test.ts`

**Interfaces:**

- Produces:
  ```ts
  export type Era = "modern" | "legacy";

  export interface DiscoverResult {
    supportedVersions: string[];
    capabilities: Record<string, unknown>;
    serverInfo?: { name: string; version: string };
    instructions?: string;
  }

  /** Builds the `_meta` block every modern request/response carries. */
  export function modernMeta(extra?: Record<string, unknown>): Record<string, unknown>;

  /** True when a JSON-RPC error is one of the three modern version/capability errors. */
  export function isRecognizedModernError(err: { code?: number } | undefined): boolean;

  /** Parses a raw JSON-RPC result into a DiscoverResult, or undefined if the shape doesn't match. */
  export function parseDiscoverResult(result: unknown): DiscoverResult | undefined;
  ```

This task has no I/O yet — it's the pure parsing/shape layer both the stdio
and HTTP probes (Tasks 2–3) will share.

- [ ] **Step 1: Write the failing tests**

Create `src/test/eraDetect.test.ts`:

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { modernMeta, isRecognizedModernError, parseDiscoverResult } from "../mcp/eraDetect.js";

test("modernMeta includes the protocol version and empty clientCapabilities by default", () => {
  const meta = modernMeta();
  assert.equal(meta["io.modelcontextprotocol/protocolVersion"], "2026-07-28");
  assert.deepEqual(meta["io.modelcontextprotocol/clientCapabilities"], {});
  assert.deepEqual(meta["io.modelcontextprotocol/clientInfo"], {
    name: "kritya",
    version: undefined,
  });
});

test("modernMeta merges extra fields into clientCapabilities untouched", () => {
  const meta = modernMeta({ roots: {} });
  assert.deepEqual(meta["io.modelcontextprotocol/clientCapabilities"], { roots: {} });
});

test("isRecognizedModernError is true for -32020, -32021, -32022", () => {
  assert.equal(isRecognizedModernError({ code: -32020 }), true);
  assert.equal(isRecognizedModernError({ code: -32021 }), true);
  assert.equal(isRecognizedModernError({ code: -32022 }), true);
});

test("isRecognizedModernError is false for other codes or undefined", () => {
  assert.equal(isRecognizedModernError({ code: -32601 }), false);
  assert.equal(isRecognizedModernError(undefined), false);
});

test("parseDiscoverResult accepts a well-formed DiscoverResult", () => {
  const parsed = parseDiscoverResult({
    resultType: "complete",
    supportedVersions: ["2026-07-28"],
    capabilities: { tools: {} },
    _meta: { "io.modelcontextprotocol/serverInfo": { name: "srv", version: "1" } },
  });
  assert.deepEqual(parsed, {
    supportedVersions: ["2026-07-28"],
    capabilities: { tools: {} },
    serverInfo: { name: "srv", version: "1" },
    instructions: undefined,
  });
});

test("parseDiscoverResult returns undefined for a shape missing supportedVersions", () => {
  assert.equal(parseDiscoverResult({ resultType: "complete", capabilities: {} }), undefined);
});

test("parseDiscoverResult returns undefined for non-object input", () => {
  assert.equal(parseDiscoverResult(null), undefined);
  assert.equal(parseDiscoverResult("nope"), undefined);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL (`src/mcp/eraDetect.js` does not exist)

- [ ] **Step 3: Implement `src/mcp/eraDetect.ts`**

```ts
import { VERSION } from "../version.js";

/**
 * Era detection and the modern (2026-07-28+) per-request `_meta` shape.
 *
 * Modern MCP has no `initialize` handshake: every request carries its
 * protocol version, capabilities, and identity in `_meta`, and the server
 * answers each request independently. See
 * /specification/2026-07-28/basic/versioning for the era model this file
 * implements detection for.
 */

export const MODERN_PROTOCOL_VERSION = "2026-07-28";

export type Era = "modern" | "legacy";

export interface DiscoverResult {
  supportedVersions: string[];
  capabilities: Record<string, unknown>;
  serverInfo?: { name: string; version: string };
  instructions?: string;
}

/** The `_meta` block every modern request carries, per spec's "Per-request protocol fields". */
export function modernMeta(
  clientCapabilities: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    "io.modelcontextprotocol/protocolVersion": MODERN_PROTOCOL_VERSION,
    "io.modelcontextprotocol/clientInfo": { name: "kritya", version: VERSION },
    "io.modelcontextprotocol/clientCapabilities": clientCapabilities,
  };
}

/** The three error codes the 2026-07-28 spec reserves for version/capability/header mismatches. */
const MODERN_ERROR_CODES = new Set([-32020, -32021, -32022]);

export function isRecognizedModernError(err: { code?: number } | undefined): boolean {
  return typeof err?.code === "number" && MODERN_ERROR_CODES.has(err.code);
}

/** Parse a raw JSON-RPC `result` into a DiscoverResult; undefined if the shape doesn't match. */
export function parseDiscoverResult(result: unknown): DiscoverResult | undefined {
  if (!result || typeof result !== "object") return undefined;
  const r = result as {
    supportedVersions?: unknown;
    capabilities?: unknown;
    instructions?: unknown;
    _meta?: { "io.modelcontextprotocol/serverInfo"?: { name: string; version: string } };
  };
  if (
    !Array.isArray(r.supportedVersions) ||
    !r.supportedVersions.every((v) => typeof v === "string")
  ) {
    return undefined;
  }
  if (!r.capabilities || typeof r.capabilities !== "object") return undefined;
  return {
    supportedVersions: r.supportedVersions,
    capabilities: r.capabilities as Record<string, unknown>,
    serverInfo: r._meta?.["io.modelcontextprotocol/serverInfo"],
    instructions: typeof r.instructions === "string" ? r.instructions : undefined,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/mcp/eraDetect.ts src/test/eraDetect.test.ts
git commit -m "feat(mcp): add modern _meta helpers and DiscoverResult parsing"
```

---

### Task 2: stdio era probe (`server/discover` over a spawned process)

**Files:**

- Modify: `src/mcp/eraDetect.ts`
- Test: Modify `src/test/eraDetect.test.ts`

**Interfaces:**

- Consumes: `modernMeta`, `isRecognizedModernError`, `parseDiscoverResult`
  (Task 1); `planSpawn` from `../mcp/spawnWin.js` (existing).
- Produces:

  ```ts
  export interface StdioProbeResult {
    era: Era;
    /** Set only when era === "modern" — the spawned, still-running process, so
     *  ModernMcpConnection can reuse it instead of relaunching. */
    process?: import("node:child_process").ChildProcess;
    discover?: DiscoverResult;
  }

  export function probeStdioEra(
    command: string,
    args: string[],
    env: Record<string, string> | undefined,
    cwd: string,
    timeoutMs?: number
  ): Promise<StdioProbeResult>;
  ```

- [ ] **Step 1: Write the failing tests**

Add to `src/test/eraDetect.test.ts` (add `probeStdioEra` to the import from
`../mcp/eraDetect.js`):

```ts
// ---------- probeStdioEra ----------

const MODERN_STDIO_SERVER = [
  "const rl = require('readline').createInterface({ input: process.stdin });",
  "const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');",
  "rl.on('line', (l) => {",
  "  if (!l.trim()) return;",
  "  const m = JSON.parse(l);",
  "  if (m.method === 'server/discover') {",
  "    return send({ jsonrpc: '2.0', id: m.id, result: { resultType: 'complete',",
  "      supportedVersions: ['2026-07-28'], capabilities: { tools: {} },",
  "      _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'modern-stdio', version: '1' } } } });",
  "  }",
  "});",
].join("\n");

const LEGACY_STDIO_SERVER = [
  "const rl = require('readline').createInterface({ input: process.stdin });",
  "const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');",
  "rl.on('line', (l) => {",
  "  if (!l.trim()) return;",
  "  const m = JSON.parse(l);",
  "  if (m.method === 'server/discover') {",
  "    return send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'Method not found' } });",
  "  }",
  "});",
].join("\n");

const SILENT_STDIO_SERVER = [
  "const rl = require('readline').createInterface({ input: process.stdin });",
  "rl.on('line', () => {});", // never responds to anything
].join("\n");

const VERSION_MISMATCH_STDIO_SERVER = [
  "const rl = require('readline').createInterface({ input: process.stdin });",
  "const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');",
  "rl.on('line', (l) => {",
  "  if (!l.trim()) return;",
  "  const m = JSON.parse(l);",
  "  if (m.method === 'server/discover') {",
  "    return send({ jsonrpc: '2.0', id: m.id, error: { code: -32022, message: 'Unsupported protocol version',",
  "      data: { supported: ['2099-01-01'], requested: '2026-07-28' } } });",
  "  }",
  "});",
].join("\n");

test("probeStdioEra detects a modern server and returns the running process", async () => {
  const result = await probeStdioEra(process.execPath, ["-e", MODERN_STDIO_SERVER], undefined, ".");
  assert.equal(result.era, "modern");
  assert.ok(result.process);
  assert.equal(result.discover?.serverInfo?.name, "modern-stdio");
  result.process?.kill();
});

test("probeStdioEra falls back to legacy on an unrecognized error", async () => {
  const result = await probeStdioEra(process.execPath, ["-e", LEGACY_STDIO_SERVER], undefined, ".");
  assert.equal(result.era, "legacy");
  assert.equal(result.process, undefined);
});

test("probeStdioEra falls back to legacy on timeout with no response", async () => {
  const result = await probeStdioEra(
    process.execPath,
    ["-e", SILENT_STDIO_SERVER],
    undefined,
    ".",
    200
  );
  assert.equal(result.era, "legacy");
});

test("probeStdioEra reports modern era on a recognized version-mismatch error, not legacy", async () => {
  const result = await probeStdioEra(
    process.execPath,
    ["-e", VERSION_MISMATCH_STDIO_SERVER],
    undefined,
    "."
  );
  assert.equal(result.era, "modern");
  assert.equal(result.process, undefined);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL (`probeStdioEra` not exported)

- [ ] **Step 3: Implement `probeStdioEra` in `src/mcp/eraDetect.ts`**

Add near the bottom of the file:

```ts
import { spawn, type ChildProcess } from "node:child_process";
import { planSpawn } from "./spawnWin.js";

export interface StdioProbeResult {
  era: Era;
  process?: ChildProcess;
  discover?: DiscoverResult;
}

const DEFAULT_PROBE_TIMEOUT_MS = 5_000;

/**
 * Probe a stdio server with `server/discover`, per
 * /specification/2026-07-28/basic/transports/stdio#backward-compatibility.
 * Three outcomes: a DiscoverResult (modern, process kept alive for reuse), a
 * recognized modern error (modern, but report — don't fall back), or
 * anything else / a timeout (legacy — the caller launches its own process).
 */
export function probeStdioEra(
  command: string,
  args: string[],
  env: Record<string, string> | undefined,
  cwd: string,
  timeoutMs = DEFAULT_PROBE_TIMEOUT_MS
): Promise<StdioProbeResult> {
  return new Promise((resolve) => {
    const plan = planSpawn(command, args);
    const proc = spawn(plan.command, plan.args, {
      env: { ...process.env, ...env } as Record<string, string>,
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      windowsVerbatimArguments: plan.windowsVerbatimArguments,
    });

    let buffer = "";
    let settled = false;
    const finish = (result: StdioProbeResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      proc.stdout?.removeAllListeners("data");
      if (result.era === "legacy") proc.kill();
      resolve(result);
    };

    const timer = setTimeout(() => finish({ era: "legacy" }), timeoutMs);
    timer.unref?.();

    proc.on("error", () => finish({ era: "legacy" }));
    proc.stdout?.setEncoding("utf8");
    proc.stdout?.on("data", (chunk: string) => {
      buffer += chunk;
      const idx = buffer.indexOf("\n");
      if (idx < 0) return;
      const line = buffer.slice(0, idx).trim();
      if (!line) return;
      let msg: { result?: unknown; error?: { code?: number } };
      try {
        msg = JSON.parse(line);
      } catch {
        finish({ era: "legacy" });
        return;
      }
      if (msg.result !== undefined) {
        const discover = parseDiscoverResult(msg.result);
        if (discover) {
          finish({ era: "modern", process: proc, discover });
          return;
        }
      }
      if (isRecognizedModernError(msg.error)) {
        finish({ era: "modern" });
        return;
      }
      finish({ era: "legacy" });
    });

    proc.stdin?.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "discover-probe",
        method: "server/discover",
        params: { _meta: modernMeta() },
      }) + "\n"
    );
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/mcp/eraDetect.ts src/test/eraDetect.test.ts
git commit -m "feat(mcp): add stdio server/discover era probe"
```

---

### Task 3: HTTP era probe (modern-request-first, 400-body inspection)

**Files:**

- Modify: `src/mcp/eraDetect.ts`
- Test: Modify `src/test/eraDetect.test.ts`

**Interfaces:**

- Consumes: `modernMeta`, `isRecognizedModernError`, `parseDiscoverResult`
  (Task 1).
- Produces:

  ```ts
  export interface HttpProbeResult {
    era: Era;
    discover?: DiscoverResult;
  }

  export function probeHttpEra(
    url: string,
    headers: Record<string, string>,
    timeoutMs?: number
  ): Promise<HttpProbeResult>;
  ```

- [ ] **Step 1: Write the failing tests**

Add to `src/test/eraDetect.test.ts` (add `probeHttpEra` to the import; add
`import http from "node:http";` at the top):

```ts
// ---------- probeHttpEra ----------

async function withServer(
  handler: (
    req: import("node:http").IncomingMessage,
    res: import("node:http").ServerResponse
  ) => void
): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function readBody(req: import("node:http").IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => resolve(body));
  });
}

test("probeHttpEra detects a modern server from a 200 DiscoverResult", async () => {
  const srv = await withServer(async (req, res) => {
    await readBody(req);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "discover-probe",
        result: {
          resultType: "complete",
          supportedVersions: ["2026-07-28"],
          capabilities: { tools: {} },
        },
      })
    );
  });
  try {
    const result = await probeHttpEra(srv.url, {});
    assert.equal(result.era, "modern");
    assert.deepEqual(result.discover?.supportedVersions, ["2026-07-28"]);
  } finally {
    await srv.close();
  }
});

test("probeHttpEra detects modern from a 400 body carrying a recognized modern error", async () => {
  const srv = await withServer(async (req, res) => {
    await readBody(req);
    res.writeHead(400, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "discover-probe",
        error: { code: -32022, message: "Unsupported protocol version" },
      })
    );
  });
  try {
    const result = await probeHttpEra(srv.url, {});
    assert.equal(result.era, "modern");
  } finally {
    await srv.close();
  }
});

test("probeHttpEra falls back to legacy on a 404 with a non-modern body", async () => {
  const srv = await withServer(async (req, res) => {
    await readBody(req);
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  });
  try {
    const result = await probeHttpEra(srv.url, {});
    assert.equal(result.era, "legacy");
  } finally {
    await srv.close();
  }
});

test("probeHttpEra falls back to legacy when the connection is refused", async () => {
  const result = await probeHttpEra("http://127.0.0.1:1/mcp", {}, 500);
  assert.equal(result.era, "legacy");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL (`probeHttpEra` not exported)

- [ ] **Step 3: Implement `probeHttpEra` in `src/mcp/eraDetect.ts`**

```ts
export interface HttpProbeResult {
  era: Era;
  discover?: DiscoverResult;
}

const DEFAULT_HTTP_PROBE_TIMEOUT_MS = 10_000;

/**
 * Probe an HTTP server by attempting a modern `server/discover` POST, per
 * /specification/2026-07-28/basic/transports/streamable-http#backward-compatibility.
 */
export async function probeHttpEra(
  url: string,
  headers: Record<string, string>,
  timeoutMs = DEFAULT_HTTP_PROBE_TIMEOUT_MS
): Promise<HttpProbeResult> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": MODERN_PROTOCOL_VERSION,
        "mcp-method": "server/discover",
        ...headers,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "discover-probe",
        method: "server/discover",
        params: { _meta: modernMeta() },
      }),
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return { era: "legacy" };
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { era: "legacy" };
  }
  const msg = body as { result?: unknown; error?: { code?: number } };

  if (res.ok) {
    const discover = parseDiscoverResult(msg.result);
    if (discover) return { era: "modern", discover };
    return { era: "legacy" };
  }
  if (isRecognizedModernError(msg.error)) return { era: "modern" };
  return { era: "legacy" };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/mcp/eraDetect.ts src/test/eraDetect.test.ts
git commit -m "feat(mcp): add HTTP server/discover era probe"
```

---

### Task 4: `ModernHttpTransport`

**Files:**

- Create: `src/mcp/transportModern.ts`
- Test: Create `src/test/transportModern.test.ts`

**Interfaces:**

- Consumes: `Transport`, `JsonRpcMessage` (from `./transport.js`, existing,
  unchanged); `modernMeta`, `MODERN_PROTOCOL_VERSION` (Task 1); `OAuthSession`
  (from `./oauth.js`, existing, reused verbatim).
- Produces: `export class ModernHttpTransport implements Transport`

- [ ] **Step 1: Write the failing tests**

Create `src/test/transportModern.test.ts`:

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import http from "node:http";
import { ModernHttpTransport } from "../mcp/transportModern.js";
import type { JsonRpcMessage } from "../mcp/transport.js";

async function withServer(
  handler: (
    req: import("node:http").IncomingMessage,
    res: import("node:http").ServerResponse
  ) => void
): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function readJsonBody(req: import("node:http").IncomingMessage): Promise<any> {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => resolve(JSON.parse(body)));
  });
}

test("send() includes MCP-Protocol-Version, Mcp-Method, and no session header", async () => {
  const seenHeaders: Record<string, string> = {};
  const srv = await withServer(async (req, res) => {
    Object.entries(req.headers).forEach(([k, v]) => (seenHeaders[k] = String(v)));
    await readJsonBody(req);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({ jsonrpc: "2.0", id: 1, result: { resultType: "complete", tools: [] } })
    );
  });
  try {
    const transport = new ModernHttpTransport(srv.url, {});
    let received: JsonRpcMessage | undefined;
    transport.onMessage = (m) => (received = m);
    await transport.send({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }, 5000);
    assert.equal(seenHeaders["mcp-protocol-version"], "2026-07-28");
    assert.equal(seenHeaders["mcp-method"], "tools/list");
    assert.equal(seenHeaders["mcp-session-id"], undefined);
    assert.deepEqual(received?.result, { resultType: "complete", tools: [] });
  } finally {
    await srv.close();
  }
});

test("send() sets Mcp-Name for tools/call from params.name", async () => {
  const seenHeaders: Record<string, string> = {};
  const srv = await withServer(async (req, res) => {
    Object.entries(req.headers).forEach(([k, v]) => (seenHeaders[k] = String(v)));
    await readJsonBody(req);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { resultType: "complete" } }));
  });
  try {
    const transport = new ModernHttpTransport(srv.url, {});
    transport.onMessage = () => {};
    await transport.send(
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "search", arguments: {} } },
      5000
    );
    assert.equal(seenHeaders["mcp-name"], "search");
  } finally {
    await srv.close();
  }
});

test("send() base64-sentinel-encodes an Mcp-Name value with non-ASCII characters", async () => {
  const seenHeaders: Record<string, string> = {};
  const srv = await withServer(async (req, res) => {
    Object.entries(req.headers).forEach(([k, v]) => (seenHeaders[k] = String(v)));
    await readJsonBody(req);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { resultType: "complete" } }));
  });
  try {
    const transport = new ModernHttpTransport(srv.url, {});
    transport.onMessage = () => {};
    await transport.send(
      { jsonrpc: "2.0", id: 1, method: "resources/read", params: { uri: "file:///café" } },
      5000
    );
    assert.match(seenHeaders["mcp-name"], /^=\?base64\?/);
  } finally {
    await srv.close();
  }
});

test("close() does not send a DELETE (no session to terminate)", async () => {
  let deleteCalled = false;
  const srv = await withServer((req, res) => {
    if (req.method === "DELETE") deleteCalled = true;
    res.writeHead(200);
    res.end();
  });
  try {
    const transport = new ModernHttpTransport(srv.url, {});
    transport.close();
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(deleteCalled, false);
  } finally {
    await srv.close();
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL (`src/mcp/transportModern.js` does not exist)

- [ ] **Step 3: Implement `src/mcp/transportModern.ts`**

```ts
import { McpAuthRequiredError, OAuthSession, parseWwwAuthenticate } from "./oauth.js";
import type { JsonRpcMessage, Transport } from "./transport.js";
import { modernMeta, MODERN_PROTOCOL_VERSION } from "./eraDetect.js";

/** Same-origin redirects we'll follow before calling it a loop. */
const MAX_REDIRECTS = 5;

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

/**
 * True when a string is safe to send verbatim as an HTTP header value:
 * visible ASCII (0x21-0x7E), space, and horizontal tab only, no
 * leading/trailing whitespace, per RFC 9110 field-value rules.
 */
function isPlainAsciiHeaderSafe(s: string): boolean {
  if (s !== s.trim()) return false;
  return /^[\x20-\x7E]*$/.test(s) && !/[^\x20-\x7E]/.test(s);
}

const BASE64_SENTINEL_RE = /^=\?base64\?[A-Za-z0-9+/=]*\?=$/;

/**
 * Encode a value for an `Mcp-Name`/`Mcp-Param-*` header per the 2026-07-28
 * Streamable HTTP spec's Value Encoding rules: plain ASCII as-is, otherwise
 * (or if it collides with the sentinel pattern itself) base64-sentinel the
 * UTF-8 bytes.
 */
export function encodeHeaderValue(value: string): string {
  if (isPlainAsciiHeaderSafe(value) && !BASE64_SENTINEL_RE.test(value)) return value;
  return `=?base64?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

/** Pull the `Mcp-Name` source value (params.name or params.uri) for a request, if any. */
function mcpNameFor(msg: JsonRpcMessage): string | undefined {
  const params = msg.params as { name?: unknown; uri?: unknown } | undefined;
  if (typeof params?.name === "string") return params.name;
  if (typeof params?.uri === "string") return params.uri;
  return undefined;
}

/**
 * Streamable HTTP transport for the modern (2026-07-28+), stateless,
 * per-request era: no `Mcp-Session-Id`, no `initialize`, every POST carries
 * `_meta` in the body and mirrors `MCP-Protocol-Version`/`Mcp-Method`/
 * `Mcp-Name` into headers. See
 * /specification/2026-07-28/basic/transports/streamable-http.
 */
export class ModernHttpTransport implements Transport {
  onMessage: (msg: JsonRpcMessage) => void = () => {};
  onError: (err: Error) => void = () => {};
  private oauth: OAuthSession;

  constructor(
    private url: string,
    private headers: Record<string, string>
  ) {
    this.oauth = new OAuthSession(url);
  }

  private async buildHeaders(msg: JsonRpcMessage): Promise<Record<string, string>> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": MODERN_PROTOCOL_VERSION,
      "mcp-method": msg.method ?? "",
      ...this.headers,
    };
    const name = mcpNameFor(msg);
    if (name !== undefined) headers["mcp-name"] = encodeHeaderValue(name);
    const hasExplicitAuth = Object.keys(headers).some((k) => k.toLowerCase() === "authorization");
    if (!hasExplicitAuth) {
      const token = await this.oauth.accessToken();
      if (token) headers.authorization = `Bearer ${token}`;
    }
    return headers;
  }

  private withMeta(msg: JsonRpcMessage): JsonRpcMessage {
    const params = (msg.params ?? {}) as Record<string, unknown>;
    return { ...msg, params: { ...params, _meta: modernMeta() } };
  }

  async send(msg: JsonRpcMessage, timeoutMs: number, signal?: AbortSignal): Promise<void> {
    const body = this.withMeta(msg);
    let res = await this.post(body, timeoutMs, signal);

    if (res.status === 401) {
      const refreshed = await this.oauth.handleUnauthorized();
      if (refreshed) {
        await res.body?.cancel().catch(() => {});
        res = await this.post(body, timeoutMs, signal);
      }
      if (res.status === 401) {
        const challenge = parseWwwAuthenticate(res.headers.get("www-authenticate"));
        await res.body?.cancel().catch(() => {});
        throw new McpAuthRequiredError(this.url, challenge);
      }
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      let parsed: JsonRpcMessage | undefined;
      try {
        parsed = JSON.parse(text);
      } catch {
        // not JSON — fall through to the generic HTTP error below
      }
      if (parsed?.error) {
        this.onMessage(parsed);
        return;
      }
      throw new Error(`HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ""}`);
    }
    const contentType = res.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      const parsed = (await res.json()) as JsonRpcMessage;
      this.onMessage(parsed);
    } else if (contentType.includes("text/event-stream")) {
      await this.readSse(res);
    }
  }

  private async post(
    msg: JsonRpcMessage,
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<Response> {
    const body = JSON.stringify(msg);
    let url = this.url;
    for (let hop = 0; ; hop++) {
      const res = await fetch(url, {
        method: "POST",
        headers: await this.buildHeaders(msg),
        body,
        redirect: "manual",
        signal: signal ?? AbortSignal.timeout(timeoutMs),
      });
      if (!isRedirect(res.status)) return res;
      const location = res.headers.get("location");
      await res.body?.cancel().catch(() => {});
      if (!location) throw new Error(`HTTP ${res.status} redirect with no Location header`);
      if (hop >= MAX_REDIRECTS) throw new Error(`too many redirects from ${this.url}`);
      const target = new URL(location, url);
      if (target.origin !== new URL(url).origin) {
        throw new Error(
          `refusing redirect to a different origin (${target.origin}) — ` +
            `it would send this server's credentials there.`
        );
      }
      url = target.toString();
    }
  }

  private async readSse(res: Response): Promise<void> {
    if (!res.body) return;
    const decoder = new TextDecoder();
    let buffer = "";
    const dispatch = (rawEvent: string) => {
      const data = rawEvent
        .split(/\r?\n/)
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trimStart())
        .join("\n");
      if (!data) return;
      try {
        this.onMessage(JSON.parse(data) as JsonRpcMessage);
      } catch {
        // ignore non-JSON events (comments, keep-alives)
      }
    };
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true });
      let idx: number;
      while ((idx = buffer.search(/\r?\n\r?\n/)) >= 0) {
        const rawEvent = buffer.slice(0, idx);
        buffer = buffer.slice(idx).replace(/^\r?\n\r?\n/, "");
        dispatch(rawEvent);
      }
    }
    if (buffer.trim()) dispatch(buffer);
  }

  close(): void {
    // No session to terminate — modern mode never sends DELETE.
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/mcp/transportModern.ts src/test/transportModern.test.ts
git commit -m "feat(mcp): add ModernHttpTransport for the 2026-07-28 per-request wire format"
```

---

### Task 5: `ModernMcpConnection`

**Files:**

- Create: `src/mcp/clientModern.ts`
- Test: Create `src/test/mcpModern.test.ts`

**Interfaces:**

- Consumes: `Transport`, `StdioTransport` (from `./transport.js`, existing,
  unchanged), `ModernHttpTransport` (Task 4), `modernMeta`,
  `MODERN_PROTOCOL_VERSION` (Task 1), `McpToolSpec`, `McpPromptSpec`,
  `McpResourceSpec` (types already exported from `./client.js` — import
  with `import type`).
- Produces:
  ```ts
  export class ModernMcpConnection {
    constructor(name: string, transport: Transport);
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

`callTool`'s signature matches `McpConnection.callTool` exactly, including
`tasksEnabled?`/`onProgress?`, even though this task ignores both
parameters (Tasks-under-modern is explicitly out of scope per the spec's
"Out of scope" section). This is required, not cosmetic: Task 6 declares
`conn: McpConnection | ModernMcpConnection` and calls `conn.callTool(...)`
with all five arguments (via the existing `mcpToolDef`'s `execute`, which
kritya's tool-calling code already invokes this way) — if the two classes'
signatures don't match exactly, that union call site fails to typecheck.

- [ ] **Step 1: Write the failing tests**

Create `src/test/mcpModern.test.ts`:

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { ModernMcpConnection } from "../mcp/clientModern.js";
import { StdioTransport } from "../mcp/transport.js";

const MODERN_TOOLS_SERVER = [
  "const rl = require('readline').createInterface({ input: process.stdin });",
  "const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');",
  "rl.on('line', (l) => {",
  "  if (!l.trim()) return;",
  "  const m = JSON.parse(l);",
  "  if (m.method === 'tools/list')",
  "    return send({ jsonrpc: '2.0', id: m.id, result: { resultType: 'complete',",
  "      tools: [{ name: 'echo', description: 'echoes input', inputSchema: { type: 'object', properties: {} } }] } });",
  "  if (m.method === 'tools/call')",
  "    return send({ jsonrpc: '2.0', id: m.id, result: { resultType: 'complete',",
  "      content: [{ type: 'text', text: 'echoed: ' + JSON.stringify(m.params.arguments) }] } });",
  "});",
].join("\n");

function modernConn(script: string): ModernMcpConnection {
  const transport = new StdioTransport(process.execPath, ["-e", script], undefined, ".");
  return new ModernMcpConnection("modern-test", transport);
}

test("initialize() lists tools without ever sending initialize or notifications/initialized", async () => {
  const seenMethods: string[] = [];
  const script = [
    "const rl = require('readline').createInterface({ input: process.stdin });",
    "const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');",
    "rl.on('line', (l) => {",
    "  if (!l.trim()) return;",
    "  const m = JSON.parse(l);",
    "  process.stderr.write(m.method + '\\n');",
    "  if (m.method === 'tools/list')",
    "    return send({ jsonrpc: '2.0', id: m.id, result: { resultType: 'complete', tools: [] } });",
    "});",
  ].join("\n");
  const transport = new StdioTransport(process.execPath, ["-e", script], undefined, ".");
  const stderrChunks: string[] = [];
  (transport as unknown as { proc: import("node:child_process").ChildProcess }).proc.stderr?.on(
    "data",
    (c: Buffer) => stderrChunks.push(c.toString())
  );
  const conn = new ModernMcpConnection("t", transport);
  const result = await conn.initialize();
  assert.deepEqual(result.tools, []);
  await new Promise((r) => setTimeout(r, 50));
  const methods = stderrChunks.join("").trim().split("\n");
  assert.deepEqual(methods, ["tools/list"]);
  conn.close();
});

test("initialize() returns tools from tools/list under modern resultType shape", async () => {
  const conn = modernConn(MODERN_TOOLS_SERVER);
  const result = await conn.initialize();
  assert.equal(result.tools.length, 1);
  assert.equal(result.tools[0].name, "echo");
  conn.close();
});

test("callTool() sends _meta and unwraps a resultType: complete response", async () => {
  const conn = modernConn(MODERN_TOOLS_SERVER);
  await conn.initialize();
  const answer = await conn.callTool("echo", { hello: "world" });
  assert.equal(answer, 'echoed: {"hello":"world"}');
  conn.close();
});

test("callTool() throws a clear error on resultType: input_required (MRTR not yet supported)", async () => {
  const script = [
    "const rl = require('readline').createInterface({ input: process.stdin });",
    "const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');",
    "rl.on('line', (l) => {",
    "  if (!l.trim()) return;",
    "  const m = JSON.parse(l);",
    "  if (m.method === 'tools/list')",
    "    return send({ jsonrpc: '2.0', id: m.id, result: { resultType: 'complete', tools: [{ name: 'ask', inputSchema: {} }] } });",
    "  if (m.method === 'tools/call')",
    "    return send({ jsonrpc: '2.0', id: m.id, result: { resultType: 'input_required',",
    "      inputRequests: { a: { method: 'elicitation/create', params: {} } } } });",
    "});",
  ].join("\n");
  const conn = modernConn(script);
  await conn.initialize();
  await assert.rejects(() => conn.callTool("ask", {}), /does not yet support/i);
  conn.close();
});

test("callTool() surfaces a JSON-RPC error as a thrown Error", async () => {
  const script = [
    "const rl = require('readline').createInterface({ input: process.stdin });",
    "const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');",
    "rl.on('line', (l) => {",
    "  if (!l.trim()) return;",
    "  const m = JSON.parse(l);",
    "  if (m.method === 'tools/list')",
    "    return send({ jsonrpc: '2.0', id: m.id, result: { resultType: 'complete', tools: [{ name: 'bad', inputSchema: {} }] } });",
    "  if (m.method === 'tools/call')",
    "    return send({ jsonrpc: '2.0', id: m.id, error: { code: -32602, message: 'bad args' } });",
    "});",
  ].join("\n");
  const conn = modernConn(script);
  await conn.initialize();
  await assert.rejects(() => conn.callTool("bad", {}), /bad args/);
  conn.close();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL (`src/mcp/clientModern.js` does not exist)

- [ ] **Step 3: Implement `src/mcp/clientModern.ts`**

```ts
import type { Transport, JsonRpcMessage } from "./transport.js";
import { modernMeta } from "./eraDetect.js";
import type { McpToolSpec, McpPromptSpec, McpResourceSpec } from "./client.js";

interface Pending {
  resolve(value: unknown): void;
  reject(err: Error): void;
  timer: NodeJS.Timeout;
}

const REQUEST_TIMEOUT_MS = 120_000;

interface McpContentBlock {
  type: string;
  text?: string;
}

/**
 * Modern (2026-07-28+) MCP client: no `initialize`, every request carries
 * its own `_meta`. Implements the same minimal surface as the legacy
 * `McpConnection` (see docs/superpowers/specs/2026-08-30-mcp-modern-protocol-design.md)
 * so `connectServer()` can use either interchangeably. `resultType:
 * "input_required"` (MRTR — sampling/elicitation/roots) is rejected with a
 * clear error here; Sub-project 2 replaces this with the real retry loop.
 */
export class ModernMcpConnection {
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private closed = false;

  constructor(
    private name: string,
    private transport: Transport
  ) {
    transport.onMessage = (msg) => this.onMessage(msg);
    transport.onError = (err) => this.fail(new Error(`MCP server "${name}": ${err.message}`));
  }

  private fail(err: Error): void {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }

  private onMessage(msg: JsonRpcMessage): void {
    if (typeof msg.id !== "number") return;
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.error) p.reject(new Error(msg.error.message ?? "MCP error"));
    else p.resolve(msg.result);
  }

  private request(
    method: string,
    params: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error(`MCP server "${this.name}" is not running`));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request "${method}" timed out`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      this.transport
        .send(
          { jsonrpc: "2.0", id, method, params: { ...params, _meta: modernMeta() } },
          REQUEST_TIMEOUT_MS,
          signal
        )
        .catch((err: Error) => {
          const p = this.pending.get(id);
          if (!p) return;
          this.pending.delete(id);
          clearTimeout(p.timer);
          p.reject(err);
        });
    });
  }

  /** Unwrap a modern result's resultType, throwing for input_required (MRTR — Sub-project 2). */
  private unwrap<T>(result: unknown): T {
    const r = result as { resultType?: string };
    if (r.resultType === "input_required") {
      throw new Error(
        `MCP server "${this.name}" requires an interactive capability (sampling, elicitation, ` +
          `or roots) that modern-mode kritya does not yet support`
      );
    }
    if (r.resultType !== undefined && r.resultType !== "complete") {
      throw new Error(
        `MCP server "${this.name}" returned an unrecognized resultType "${r.resultType}"`
      );
    }
    return result as T;
  }

  async initialize(): Promise<{
    tools: McpToolSpec[];
    prompts: McpPromptSpec[];
    resources: McpResourceSpec[];
  }> {
    const listed = this.unwrap<{ tools?: McpToolSpec[] }>(await this.request("tools/list", {}));
    let prompts: McpPromptSpec[] = [];
    let resources: McpResourceSpec[] = [];
    try {
      const p = this.unwrap<{ prompts?: McpPromptSpec[] }>(await this.request("prompts/list", {}));
      prompts = p.prompts ?? [];
    } catch {
      // prompts unsupported by this server — non-fatal, same as legacy behavior
    }
    try {
      const r = this.unwrap<{ resources?: McpResourceSpec[] }>(
        await this.request("resources/list", {})
      );
      resources = r.resources ?? [];
    } catch {
      // resources unsupported — non-fatal
    }
    return { tools: listed.tools ?? [], prompts, resources };
  }

  async getPrompt(name: string, args: Record<string, string>): Promise<string> {
    const result = this.unwrap<{ messages?: { role?: string; content?: McpContentBlock }[] }>(
      await this.request("prompts/get", { name, arguments: args })
    );
    const messages = result.messages ?? [];
    const multiRole = new Set(messages.map((m) => m.role ?? "user")).size > 1;
    return messages
      .map((m) => {
        const text = m.content?.text ?? "";
        return multiRole ? `[${m.role ?? "user"}] ${text}` : text;
      })
      .filter(Boolean)
      .join("\n\n");
  }

  async readResource(uri: string): Promise<string> {
    const result = this.unwrap<{ contents?: { text?: string }[] }>(
      await this.request("resources/read", { uri })
    );
    return (result.contents ?? []).map((c) => c.text ?? "").join("\n");
  }

  async callTool(
    toolName: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
    _tasksEnabled?: boolean,
    _onProgress?: (text: string) => void
  ): Promise<string> {
    // Tasks-under-modern is out of scope for this plan (see spec's "Out of
    // scope"); the params exist only so this signature matches
    // McpConnection.callTool's, which callers invoke uniformly through the
    // McpConnection | ModernMcpConnection union built in Task 6.
    const result = this.unwrap<{ content?: McpContentBlock[]; isError?: boolean }>(
      await this.request("tools/call", { name: toolName, arguments: args }, signal)
    );
    const text = (result.content ?? [])
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join("\n");
    if (result.isError) throw new Error(text || "MCP tool reported an error");
    return text || "(no output)";
  }

  close(): void {
    this.closed = true;
    this.transport.close();
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/mcp/clientModern.ts src/test/mcpModern.test.ts
git commit -m "feat(mcp): add ModernMcpConnection for the 2026-07-28 per-request protocol"
```

---

### Task 6: Wire era detection into `connectServer`

**Files:**

- Modify: `src/mcp/servers.ts`
- Modify: `src/mcp/client.ts` (import/use `ModernMcpConnection` as an
  alternative to `McpConnection` inside `connectServer`)
- Test: Modify `src/test/mcpModern.test.ts`

**Interfaces:**

- Consumes: `probeStdioEra`, `probeHttpEra` (Tasks 2–3), `ModernMcpConnection`
  (Task 5), `ModernHttpTransport` (Task 4).
- Produces: `connectServer()` now dispatches to the modern path
  transparently — no change to its exported signature or `McpServerStatus`
  shape.

This task modifies `connectServer` in `src/mcp/client.ts` (the function is
defined there, not in `servers.ts` — `servers.ts` only holds config
loading/merging per the codebase's existing module split; confirm this by
re-reading `connectServer`'s current location in `client.ts` before editing,
since the spec doc's file list was written before Tasks 1–5 concretized
where things actually live).

- [ ] **Step 1: Write the failing test**

Add to `src/test/mcpModern.test.ts` (this exercises the whole path through
the public `loadMcpTools`, matching the repo's integration-test convention):

```ts
import { loadMcpTools } from "../mcp/client.js";
import { NOOP_TRACER } from "../telemetry/tracer.js";

test("connectServer detects a modern stdio server and uses it end-to-end via loadMcpTools", async () => {
  const tools = await loadMcpTools(
    { modernSrv: { command: process.execPath, args: ["-e", MODERN_TOOLS_SERVER] } },
    { tracer: NOOP_TRACER }
  );
  assert.equal(tools.length, 1);
  const answer = await tools[0].execute({ hello: "world" }, { workspace: "." });
  assert.equal(answer, 'echoed: {"hello":"world"}');
});

test("connectServer still uses the legacy path for a server that doesn't answer server/discover", async () => {
  const LEGACY_SERVER = [
    "const rl = require('readline').createInterface({ input: process.stdin });",
    "const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');",
    "rl.on('line', (l) => {",
    "  if (!l.trim()) return;",
    "  const m = JSON.parse(l);",
    "  if (m.method === 'server/discover')",
    "    return send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'Method not found' } });",
    "  if (m.method === 'initialize')",
    "    return send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params.protocolVersion,",
    "      capabilities: { tools: {} }, serverInfo: { name: 'legacy', version: '1' } } });",
    "  if (m.method === 'tools/list')",
    "    return send({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'ping' }] } });",
    "  if (m.method === 'tools/call')",
    "    return send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: 'pong' }] } });",
    "});",
  ].join("\n");
  const tools = await loadMcpTools(
    { legacySrv: { command: process.execPath, args: ["-e", LEGACY_SERVER] } },
    { tracer: NOOP_TRACER }
  );
  assert.equal(tools.length, 1);
  const answer = await tools[0].execute({}, { workspace: "." });
  assert.equal(answer, "pong");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL (modern server is currently handled by the legacy
`initialize` path and hangs/errors instead of returning tools)

- [ ] **Step 3: Read `connectServer` before editing**

Run: `grep -n "export async function connectServer" -A 5 src/mcp/client.ts`

Confirm the exact current signature and the line where
`conn = new McpConnection(...)` is constructed (this was around
`client.ts:1042` as of the design doc, but re-check — earlier tasks in this
plan may have shifted line numbers via unrelated formatting).

- [ ] **Step 4: Add the era-detection branch**

In `src/mcp/client.ts`, add imports at the top:

```ts
import { probeStdioEra, probeHttpEra } from "./eraDetect.js";
import { ModernMcpConnection } from "./clientModern.js";
import { ModernHttpTransport } from "./transportModern.js";
import { StdioTransport as ModernStdioTransportAlias } from "./transport.js"; // stdio framing is shared; see Task 5 note
```

(the `ModernStdioTransportAlias` import is likely already covered by the
existing `StdioTransport` import in this file — check first and don't
duplicate the import if so).

Inside `connectServer`, before the existing
`conn = new McpConnection(name, makeTransport(name, cfg, workspace), workspace, {...})`
line, insert era detection and branch:

```ts
let modernConn: ModernMcpConnection | undefined;
if (cfg.url) {
  assertSafeUrl(name, cfg.url);
  const probe = await probeHttpEra(cfg.url, cfg.headers ?? {});
  if (probe.era === "modern") {
    modernConn = new ModernMcpConnection(name, new ModernHttpTransport(cfg.url, cfg.headers ?? {}));
  }
} else if (cfg.command) {
  const cwd = cfg.cwd ? path.resolve(workspace, cfg.cwd) : workspace;
  const probe = await probeStdioEra(cfg.command, cfg.args ?? [], cfg.env, cwd);
  if (probe.era === "modern") {
    // Reuse the already-spawned probe process when the server kept it
    // alive; otherwise (a modern server that rejected our version) fall
    // through to the ordinary makeTransport path, which will also hit
    // that same version mismatch and report it clearly via status.error.
    if (probe.process) {
      const reusedTransport: Transport = {
        onMessage: () => {},
        onError: () => {},
        send: (msg, timeoutMs, signal) =>
          new Promise((resolve, reject) => {
            const onData = (chunk: string) => {
              const line = chunk.split("\n")[0]?.trim();
              if (!line) return;
              probe.process?.stdout?.off("data", onData);
              try {
                reusedTransport.onMessage(JSON.parse(line));
                resolve();
              } catch (err) {
                reject(err as Error);
              }
            };
            probe.process?.stdout?.on("data", onData);
            probe.process?.stdin?.write(JSON.stringify(msg) + "\n");
            signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
          }),
        close: () => probe.process?.kill(),
      };
      modernConn = new ModernMcpConnection(name, reusedTransport);
    }
  }
}
```

Then change the connection-construction branch:

```ts
conn =
  modernConn ??
  new McpConnection(name, makeTransport(name, cfg, workspace), workspace, {
    onSampling: trace?.onSampling,
    onElicitation: trace?.onElicitation,
  });
```

Note: `conn`'s declared type must widen to accept either class — check its
current declaration (`let conn: McpConnection | undefined;`) and change it
to `let conn: McpConnection | ModernMcpConnection | undefined;`. Everywhere
else in `connectServer` that calls `conn.initialize()`, `conn.close()`, etc.
already only uses methods both classes implement (confirmed by Task 5's
interface), so no further changes should be needed — but re-read the full
function body after this edit to confirm nothing calls a
`McpConnection`-only method (e.g. nothing outside this block should call
`conn.getPrompt`/`readResource`/`callTool` directly on a narrowed type).

**Known simplification, called out explicitly rather than hidden:** the
reused-process transport built inline above is a minimal one-shot adapter
(it doesn't handle multiple in-flight requests or errors from process exit)
because `ModernMcpConnection`'s `initialize()` and subsequent calls in this
plan's tests are always sequential. If this proves too fragile in Task 7's
broader testing, extract it into a small `ReusedProcessTransport` class in
`transportModern.ts` implementing the full `Transport` interface properly
(buffering, `onError` wired to the process's `exit`/`error` events, matching
`StdioTransport`'s existing robustness) — do this refactor now if the Task 6
tests reveal flakiness, rather than deferring silently.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test`
Expected: PASS, including both new tests and the full existing
`src/test/mcp.test.ts` suite unmodified.

- [ ] **Step 6: Typecheck**

Run: `npm run build`
Expected: no errors

- [ ] **Step 7: Commit**

```bash
git add src/mcp/client.ts src/test/mcpModern.test.ts
git commit -m "feat(mcp): wire era detection into connectServer, dispatching to legacy or modern"
```

---

### Task 7: Version/capability error surfacing in `McpServerStatus`

**Files:**

- Modify: `src/mcp/client.ts` (the `catch` block in `connectServer`)
- Test: Modify `src/test/mcpModern.test.ts`

**Interfaces:**

- Consumes: `isRecognizedModernError` is not directly needed here — the
  error already surfaces as a thrown `Error` from `ModernMcpConnection`'s
  `request()`/`unwrap()`; this task only ensures the message is clear and
  reaches `status.error` the same way any other connection failure does.

- [ ] **Step 1: Write the failing test**

Add to `src/test/mcpModern.test.ts`:

```ts
import { connectServer } from "../mcp/client.js";

test("a modern server rejecting our protocol version reports a clear status.error, not a hang", async () => {
  const VERSION_MISMATCH_SERVER = [
    "const rl = require('readline').createInterface({ input: process.stdin });",
    "const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');",
    "rl.on('line', (l) => {",
    "  if (!l.trim()) return;",
    "  const m = JSON.parse(l);",
    "  const err = { code: -32022, message: 'Unsupported protocol version',",
    "    data: { supported: ['2099-01-01'], requested: '2026-07-28' } };",
    "  return send({ jsonrpc: '2.0', id: m.id, error: err });",
    "});",
  ].join("\n");
  const { status } = await connectServer(
    "mismatched",
    { command: process.execPath, args: ["-e", VERSION_MISMATCH_SERVER] },
    { tracer: (await import("../telemetry/tracer.js")).NOOP_TRACER }
  );
  assert.equal(status.ok, false);
  assert.match(status.error ?? "", /protocol version|not.*support/i);
});
```

- [ ] **Step 2: Run test to verify it fails or passes accidentally-correctly**

Run: `npm test`
Expected: Likely FAIL or an unclear error message — a modern server that
recognizes our version request but rejects it (per Task 2/6, this is
detected as `era: "modern"` with no `process` kept alive) currently falls
through to attempting `makeTransport` + legacy `initialize`, which will
produce a confusing "method not found"-style error rather than naming the
actual version mismatch.

- [ ] **Step 3: Make the version-mismatch case fail with a clear message**

In the era-detection branch added in Task 6 (stdio case), when
`probe.era === "modern"` but `probe.process` is undefined (the
recognized-modern-error case), don't fall through to the legacy path at
all — throw immediately with the specific message. Change:

```ts
const probe = await probeStdioEra(cfg.command, cfg.args ?? [], cfg.env, cwd);
if (probe.era === "modern") {
  if (probe.process) {
    // ... existing reused-transport code from Task 6 ...
  } else {
    throw new Error(
      `server "${name}" speaks the modern MCP protocol but rejected protocol version ` +
        `"2026-07-28" — this server may require a newer or older kritya`
    );
  }
}
```

Apply the same pattern to the HTTP branch: when `probe.era === "modern"`
but detection came from a 400-body recognized-error rather than a 200
`DiscoverResult` (i.e. `probe.discover` is undefined), throw the equivalent
message instead of constructing `modernConn`.

This throw is caught by `connectServer`'s existing outer `try/catch`
(confirm this by re-reading the function's current catch block — it already
routes any thrown `Error` into `status.error` and `span.setStatus("ERROR",
...)`), so no new error-handling plumbing is needed — just don't silently
fall through to a misleading legacy attempt.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: Typecheck and full suite**

Run: `npm run build && npm test`
Expected: no errors, all tests pass, including the full pre-existing
`src/test/mcp.test.ts` suite unmodified.

- [ ] **Step 6: Commit**

```bash
git add src/mcp/client.ts src/test/mcpModern.test.ts
git commit -m "fix(mcp): surface a modern server's version mismatch clearly instead of falling through to legacy"
```

---

## Post-plan verification

- [ ] Run the complete suite once more end to end: `npm run build && npm test`.
- [ ] Manually smoke-test against a real modern-only MCP server if one is
      available (none are commonly deployed yet as of this writing — if
      none exists, this step is N/A and should be re-attempted once a real
      modern-only server is available to test against).
- [ ] Confirm `/mcp` (the status command) renders a modern-connected
      server's tools identically to a legacy one — spot-check by running
      kritya interactively against the `MODERN_TOOLS_SERVER` test fixture
      wired into a throwaway `.mcp.json`, since this plan's tests only
      exercise `loadMcpTools`/`connectServer` directly, not the `/mcp` UI
      rendering path.
