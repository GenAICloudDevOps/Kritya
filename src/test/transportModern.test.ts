import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ModernHttpTransport } from "../mcp/transportModern.js";
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
