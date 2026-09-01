import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  ModernHttpTransport,
  validateToolHeaders,
  buildParamHeaders,
  type ParamHeaderEntry,
} from "../mcp/transportModern.js";
import type { JsonRpcMessage } from "../mcp/transport.js";
import { saveAuth, type StoredAuth } from "../mcp/tokens.js";
import { McpAuthRequiredError } from "../mcp/oauth.js";

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

test("send() refuses a cross-origin redirect and never leaks credentials to it", async () => {
  let serverBHit = false;
  const srvB = await withServer((_req, res) => {
    serverBHit = true;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { resultType: "complete" } }));
  });
  const srvA = await withServer((_req, res) => {
    res.writeHead(302, { location: srvB.url });
    res.end();
  });
  try {
    const transport = new ModernHttpTransport(srvA.url, { authorization: "Bearer secret" });
    transport.onMessage = () => {};
    await assert.rejects(
      transport.send({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }, 5000),
      /different origin/
    );
    assert.equal(serverBHit, false);
  } finally {
    await srvA.close();
    await srvB.close();
  }
});

test("send() includes _meta with protocol version, client info, and client capabilities in the POST body", async () => {
  let capturedBody: any;
  const srv = await withServer(async (req, res) => {
    capturedBody = await readJsonBody(req);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { resultType: "complete" } }));
  });
  try {
    const transport = new ModernHttpTransport(srv.url, {});
    transport.onMessage = () => {};
    await transport.send({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }, 5000);
    const meta = capturedBody?.params?._meta;
    assert.ok(meta, "expected params._meta to be present in the POST body");
    assert.ok("io.modelcontextprotocol/protocolVersion" in meta);
    assert.ok("io.modelcontextprotocol/clientInfo" in meta);
    assert.ok("io.modelcontextprotocol/clientCapabilities" in meta);
  } finally {
    await srv.close();
  }
});

test("send() re-encodes an Mcp-Name value that already looks like the base64 sentinel", async () => {
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
    const collision = "=?base64?literal?=";
    await transport.send(
      { jsonrpc: "2.0", id: 1, method: "resources/read", params: { uri: collision } },
      5000
    );
    assert.notEqual(seenHeaders["mcp-name"], collision);
    assert.match(seenHeaders["mcp-name"], /^=\?base64\?[A-Za-z0-9+/=]*\?=$/);
    const decoded = Buffer.from(
      seenHeaders["mcp-name"].replace(/^=\?base64\?/, "").replace(/\?=$/, ""),
      "base64"
    ).toString("utf8");
    assert.equal(decoded, collision);
  } finally {
    await srv.close();
  }
});

// ---------- OAuth re-verification against ModernHttpTransport ----------
//
// Mirrors mcpOauth.test.ts's fake-provider pattern but scoped to just the
// token endpoint: a StoredAuth is seeded directly (skipping discovery/
// registration/PKCE, already covered end to end for the legacy path), so
// these focus on the part that's actually new — ModernHttpTransport's own
// 401 handling, reused from HttpTransport's shape.

let authFile: string;

before(async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "kritya-modern-oauth-test-"));
  authFile = path.join(dir, "mcp-auth.json");
  process.env.KRITYA_MCP_AUTH_FILE = authFile;
});

after(() => {
  delete process.env.KRITYA_MCP_AUTH_FILE;
});

interface FakeAuthServer {
  url: string;
  close: () => Promise<void>;
  readonly refreshCount: number;
}

async function startFakeAuthServer(): Promise<FakeAuthServer> {
  const counter = { refreshCount: 0 };
  const server = http.createServer(async (req, res) => {
    if (req.url === "/token") {
      counter.refreshCount++;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          access_token: "at-fresh",
          refresh_token: "rt-1",
          token_type: "Bearer",
          expires_in: 3600,
        })
      );
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    get refreshCount() {
      return counter.refreshCount;
    },
  };
}

test("send() refreshes a stale token on 401 and retries successfully", async () => {
  const as = await startFakeAuthServer();
  const srv = await withServer(async (req, res) => {
    const auth = req.headers.authorization ?? "";
    await readJsonBody(req);
    if (auth !== "Bearer at-fresh") {
      res.writeHead(401, { "www-authenticate": 'Bearer error="invalid_token"' });
      res.end(JSON.stringify({ error: "invalid_token" }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({ jsonrpc: "2.0", id: 1, result: { resultType: "complete", tools: [] } })
    );
  });
  try {
    const auth: StoredAuth = {
      resource: srv.url,
      issuer: as.url,
      tokenEndpoint: `${as.url}/token`,
      clientId: "cid",
      accessToken: "at-stale",
      refreshToken: "rt-1",
    };
    saveAuth(srv.url, auth);

    const transport = new ModernHttpTransport(srv.url, {});
    let received: JsonRpcMessage | undefined;
    transport.onMessage = (m) => (received = m);
    await transport.send({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }, 5000);
    assert.deepEqual(received?.result, { resultType: "complete", tools: [] });
    assert.equal(as.refreshCount, 1, "should have refreshed exactly once");
  } finally {
    await srv.close();
    await as.close();
  }
});

test("send() throws McpAuthRequiredError when a fresh 401 has no refresh token to fall back on", async () => {
  const srv = await withServer(async (req, res) => {
    await readJsonBody(req);
    res.writeHead(401, {
      "www-authenticate":
        'Bearer error="invalid_token", resource_metadata="https://example.test/.well-known/oauth-protected-resource"',
    });
    res.end(JSON.stringify({ error: "invalid_token" }));
  });
  try {
    const auth: StoredAuth = {
      resource: srv.url,
      issuer: "https://as.test",
      tokenEndpoint: "https://as.test/token",
      clientId: "cid",
      accessToken: "at-dead",
      // No refreshToken: handleUnauthorized() can't recover, matching the
      // "must log in again" branch.
    };
    saveAuth(srv.url, auth);

    const transport = new ModernHttpTransport(srv.url, {});
    transport.onMessage = () => {};
    await assert.rejects(
      transport.send({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }, 5000),
      (err: unknown) => err instanceof McpAuthRequiredError
    );
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

// ---------- x-mcp-header parameter mirroring: validateToolHeaders / buildParamHeaders ----------

test("validateToolHeaders: valid top-level string annotation resolves to an entry, and buildParamHeaders mirrors it", () => {
  const schema = {
    type: "object",
    properties: {
      apiKey: { type: "string", "x-mcp-header": "X-Api-Key" },
    },
  };
  const result = validateToolHeaders(schema);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.entries, [{ path: ["apiKey"], header: "X-Api-Key" }]);
  const headers = buildParamHeaders(result.entries, { apiKey: "secret123" });
  assert.deepEqual(headers, { "mcp-param-x-api-key": "secret123" });
});

test("validateToolHeaders: a nested property reached purely via properties chains is found", () => {
  const schema = {
    type: "object",
    properties: {
      outer: {
        type: "object",
        properties: {
          inner: {
            type: "object",
            properties: {
              tenant: { type: "string", "x-mcp-header": "X-Tenant-Id" },
            },
          },
        },
      },
    },
  };
  const result = validateToolHeaders(schema);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.entries, [{ path: ["outer", "inner", "tenant"], header: "X-Tenant-Id" }]);
  const headers = buildParamHeaders(result.entries, { outer: { inner: { tenant: "acme" } } });
  assert.deepEqual(headers, { "mcp-param-x-tenant-id": "acme" });
});

test("buildParamHeaders: base64-sentinel-encodes a non-ASCII string value", () => {
  const entries: ParamHeaderEntry[] = [{ path: ["name"], header: "X-Name" }];
  const headers = buildParamHeaders(entries, { name: "café" });
  assert.match(headers["mcp-param-x-name"], /^=\?base64\?[A-Za-z0-9+/=]*\?=$/);
  const decoded = Buffer.from(
    headers["mcp-param-x-name"].replace(/^=\?base64\?/, "").replace(/\?=$/, ""),
    "base64"
  ).toString("utf8");
  assert.equal(decoded, "café");
});

test("buildParamHeaders: omits a null value and an absent property entirely", () => {
  const entries: ParamHeaderEntry[] = [
    { path: ["present"], header: "X-Present" },
    { path: ["nullish"], header: "X-Nullish" },
    { path: ["missing"], header: "X-Missing" },
  ];
  const headers = buildParamHeaders(entries, { present: "value", nullish: null });
  assert.deepEqual(headers, { "mcp-param-x-present": "value" });
});

test("buildParamHeaders: converts integer and boolean values to decimal/lowercase strings", () => {
  const entries: ParamHeaderEntry[] = [
    { path: ["count"], header: "X-Count" },
    { path: ["flag"], header: "X-Flag" },
  ];
  const headers = buildParamHeaders(entries, { count: 42, flag: true });
  assert.equal(headers["mcp-param-x-count"], "42");
  assert.equal(headers["mcp-param-x-flag"], "true");
  const headers2 = buildParamHeaders(entries, { count: 0, flag: false });
  assert.equal(headers2["mcp-param-x-count"], "0");
  assert.equal(headers2["mcp-param-x-flag"], "false");
});

test("validateToolHeaders: rejects a schema with case-insensitively colliding header names", () => {
  const schema = {
    type: "object",
    properties: {
      a: { type: "string", "x-mcp-header": "X-Tenant" },
      b: { type: "string", "x-mcp-header": "x-tenant" },
    },
  };
  const result = validateToolHeaders(schema);
  assert.equal(result.ok, false);
});

test("validateToolHeaders: rejects an annotation reachable only through items (array)", () => {
  const schema = {
    type: "object",
    properties: {
      list: {
        type: "array",
        items: { type: "string", "x-mcp-header": "X-Item" },
      },
    },
  };
  const result = validateToolHeaders(schema);
  assert.equal(result.ok, false);
});

test("validateToolHeaders: rejects an annotation reachable only through oneOf", () => {
  const schema = {
    type: "object",
    oneOf: [{ properties: { a: { type: "string", "x-mcp-header": "X-A" } } }],
  };
  const result = validateToolHeaders(schema);
  assert.equal(result.ok, false);
});

test("validateToolHeaders: rejects x-mcp-header co-located with $ref on the same node", () => {
  const schema = {
    type: "object",
    properties: {
      a: { $ref: "#/definitions/Thing", type: "string", "x-mcp-header": "X-A" },
    },
  };
  const result = validateToolHeaders(schema);
  assert.equal(result.ok, false);
});

test("validateToolHeaders: an x-mcp-header nested inside a $ref target (not co-located) is simply never found, not rejected", () => {
  const schema = {
    type: "object",
    properties: {
      a: { $ref: "#/definitions/Thing" },
    },
    definitions: {
      Thing: {
        type: "object",
        properties: {
          b: { type: "string", "x-mcp-header": "X-B" },
        },
      },
    },
  };
  const result = validateToolHeaders(schema);
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.entries, []);
});

test("validateToolHeaders: rejects x-mcp-header applied to a number-typed property", () => {
  const schema = {
    type: "object",
    properties: {
      amount: { type: "number", "x-mcp-header": "X-Amount" },
    },
  };
  const result = validateToolHeaders(schema);
  assert.equal(result.ok, false);
});

test("validateToolHeaders: rejects an empty x-mcp-header value", () => {
  const schema = {
    type: "object",
    properties: { a: { type: "string", "x-mcp-header": "" } },
  };
  const result = validateToolHeaders(schema);
  assert.equal(result.ok, false);
});

test("validateToolHeaders: rejects x-mcp-header values containing an invalid character", () => {
  const schemaSpace = {
    type: "object",
    properties: { a: { type: "string", "x-mcp-header": "X Header" } },
  };
  assert.equal(validateToolHeaders(schemaSpace).ok, false);

  const schemaColon = {
    type: "object",
    properties: { a: { type: "string", "x-mcp-header": "X:Header" } },
  };
  assert.equal(validateToolHeaders(schemaColon).ok, false);
});

test("validateToolHeaders: rejects a schema exceeding the max nesting depth, quickly and without hanging", () => {
  let schema: unknown = { type: "string" };
  for (let i = 0; i < 60; i++) {
    schema = { type: "object", properties: { next: schema } };
  }
  const start = Date.now();
  const result = validateToolHeaders(schema);
  assert.ok(Date.now() - start < 1000, "should reject quickly, not hang");
  assert.equal(result.ok, false);
});

test("validateToolHeaders: rejects a schema exceeding the max node count, quickly and without hanging", () => {
  const properties: Record<string, unknown> = {};
  for (let i = 0; i < 5001; i++) {
    properties[`p${i}`] = { type: "string" };
  }
  const schema = { type: "object", properties };
  const start = Date.now();
  const result = validateToolHeaders(schema);
  assert.ok(Date.now() - start < 1000, "should reject quickly, not hang");
  assert.equal(result.ok, false);
});
