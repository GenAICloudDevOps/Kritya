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
