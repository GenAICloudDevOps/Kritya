import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ModernMcpConnection } from "../mcp/clientModern.js";
import { StdioTransport } from "../mcp/transport.js";
import { loadMcpTools, shutdownMcp, connectServer } from "../mcp/client.js";
import { NOOP_TRACER } from "../telemetry/tracer.js";
import { saveAuth, type StoredAuth } from "../mcp/tokens.js";

// loadMcpTools registers spawned/connected servers on the module-level
// `connections` list (see client.ts); closing them here is what lets the
// spawned child processes exit and the test process itself terminate,
// matching mcp.test.ts's own after(() => shutdownMcp()) hook.
after(() => shutdownMcp());

const MODERN_TOOLS_SERVER = [
  "const rl = require('readline').createInterface({ input: process.stdin });",
  "const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');",
  "rl.on('line', (l) => {",
  "  if (!l.trim()) return;",
  "  const m = JSON.parse(l);",
  "  if (m.method === 'server/discover')",
  "    return send({ jsonrpc: '2.0', id: m.id, result: { supportedVersions: ['2026-07-28'],",
  "      capabilities: { tools: {} } } });",
  "  if (m.method === 'tools/list')",
  "    return send({ jsonrpc: '2.0', id: m.id, result: { resultType: 'complete',",
  "      tools: [{ name: 'echo', description: 'echoes input', inputSchema: { type: 'object', properties: {} } }] } });",
  "  if (m.method === 'tools/call')",
  "    return send({ jsonrpc: '2.0', id: m.id, result: { resultType: 'complete',",
  "      content: [{ type: 'text', text: 'echoed: ' + JSON.stringify(m.params.arguments) }] } });",
  "  if (m.method === 'prompts/list' || m.method === 'resources/list')",
  "    return send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'Method not found' } });",
  "});",
].join("\n");

function modernConn(script: string): ModernMcpConnection {
  const transport = new StdioTransport(process.execPath, ["-e", script], undefined, ".");
  return new ModernMcpConnection("modern-test", transport);
}

test("initialize() lists tools without ever sending initialize or notifications/initialized", async () => {
  const script = [
    "const rl = require('readline').createInterface({ input: process.stdin });",
    "const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');",
    "rl.on('line', (l) => {",
    "  if (!l.trim()) return;",
    "  const m = JSON.parse(l);",
    "  process.stderr.write(m.method + '\\n');",
    "  if (m.method === 'tools/list')",
    "    return send({ jsonrpc: '2.0', id: m.id, result: { resultType: 'complete', tools: [] } });",
    "  if (m.method === 'prompts/list' || m.method === 'resources/list')",
    "    return send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'Method not found' } });",
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
  assert.deepEqual(methods, ["tools/list", "prompts/list", "resources/list"]);
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
    "  if (m.method === 'prompts/list' || m.method === 'resources/list')",
    "    return send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'Method not found' } });",
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
    "  if (m.method === 'prompts/list' || m.method === 'resources/list')",
    "    return send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'Method not found' } });",
    "});",
  ].join("\n");
  const conn = modernConn(script);
  await conn.initialize();
  await assert.rejects(() => conn.callTool("bad", {}), /bad args/);
  conn.close();
});

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
    { tracer: NOOP_TRACER }
  );
  assert.equal(status.ok, false);
  assert.match(status.error ?? "", /protocol version|not.*support/i);
  assert.match(status.error ?? "", /rejected protocol version/);
});

// ---------- getPrompt / readResource / unwrap()'s unrecognized resultType ----------

const PROMPT_AND_RESOURCE_SERVER = [
  "const rl = require('readline').createInterface({ input: process.stdin });",
  "const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');",
  "rl.on('line', (l) => {",
  "  if (!l.trim()) return;",
  "  const m = JSON.parse(l);",
  "  if (m.method === 'tools/list')",
  "    return send({ jsonrpc: '2.0', id: m.id, result: { resultType: 'complete', tools: [] } });",
  "  if (m.method === 'prompts/list')",
  "    return send({ jsonrpc: '2.0', id: m.id, result: { resultType: 'complete',",
  "      prompts: [{ name: 'greet', arguments: [{ name: 'who' }] }] } });",
  "  if (m.method === 'resources/list')",
  "    return send({ jsonrpc: '2.0', id: m.id, result: { resultType: 'complete',",
  "      resources: [{ uri: 'file:///doc.txt', name: 'doc' }] } });",
  "  if (m.method === 'prompts/get')",
  "    return send({ jsonrpc: '2.0', id: m.id, result: { resultType: 'complete',",
  "      messages: [{ role: 'user', content: { type: 'text', text: 'hi ' + m.params.arguments.who } }] } });",
  "  if (m.method === 'resources/read')",
  "    return send({ jsonrpc: '2.0', id: m.id, result: { resultType: 'complete',",
  "      contents: [{ text: 'the document body' }] } });",
  "});",
].join("\n");

test("getPrompt() unwraps a modern resultType: complete response into rendered text", async () => {
  const conn = modernConn(PROMPT_AND_RESOURCE_SERVER);
  await conn.initialize();
  const text = await conn.getPrompt("greet", { who: "world" });
  assert.equal(text, "hi world");
  conn.close();
});

test("readResource() unwraps a modern resultType: complete response into joined text", async () => {
  const conn = modernConn(PROMPT_AND_RESOURCE_SERVER);
  await conn.initialize();
  const text = await conn.readResource("file:///doc.txt");
  assert.equal(text, "the document body");
  conn.close();
});

test("unwrap() throws on an unrecognized resultType rather than silently passing it through", async () => {
  const script = [
    "const rl = require('readline').createInterface({ input: process.stdin });",
    "const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');",
    "rl.on('line', (l) => {",
    "  if (!l.trim()) return;",
    "  const m = JSON.parse(l);",
    "  if (m.method === 'tools/list')",
    "    return send({ jsonrpc: '2.0', id: m.id, result: { resultType: 'complete', tools: [{ name: 'weird', inputSchema: {} }] } });",
    "  if (m.method === 'tools/call')",
    "    return send({ jsonrpc: '2.0', id: m.id, result: { resultType: 'somethingElse' } });",
    "  if (m.method === 'prompts/list' || m.method === 'resources/list')",
    "    return send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'Method not found' } });",
    "});",
  ].join("\n");
  const conn = modernConn(script);
  await conn.initialize();
  await assert.rejects(() => conn.callTool("weird", {}), /unrecognized resultType "somethingElse"/);
  conn.close();
});

// ---------- HTTP end-to-end: connectServer -> probeHttpEra -> ModernHttpTransport -> ModernMcpConnection ----------

async function withModernHttpServer(
  handler: (msg: { id: unknown; method: string; params?: any }) => unknown
): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const msg = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const body = handler(msg);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test("connectServer detects a modern HTTP server and uses it end-to-end via loadMcpTools", async () => {
  const srv = await withModernHttpServer((m) => {
    if (m.method === "server/discover") {
      return {
        jsonrpc: "2.0",
        id: m.id,
        result: { supportedVersions: ["2026-07-28"], capabilities: { tools: {} } },
      };
    }
    if (m.method === "tools/list") {
      return {
        jsonrpc: "2.0",
        id: m.id,
        result: {
          resultType: "complete",
          tools: [
            {
              name: "echo",
              description: "echoes input",
              inputSchema: { type: "object", properties: {} },
            },
          ],
        },
      };
    }
    if (m.method === "tools/call") {
      return {
        jsonrpc: "2.0",
        id: m.id,
        result: {
          resultType: "complete",
          content: [{ type: "text", text: "echoed: " + JSON.stringify(m.params.arguments) }],
        },
      };
    }
    // prompts/list, resources/list: unsupported — non-fatal per initialize()'s try/catch.
    return { jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "Method not found" } };
  });
  try {
    const tools = await loadMcpTools({ modernHttpSrv: { url: srv.url } }, { tracer: NOOP_TRACER });
    assert.equal(tools.length, 1);
    const answer = await tools[0].execute({ hello: "world" }, { workspace: "." });
    assert.equal(answer, 'echoed: {"hello":"world"}');
  } finally {
    await srv.close();
  }
});

// ---------- OAuth-protected modern HTTP server: detection + connection end-to-end ----------

let oauthAuthFile: string;

before(async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "kritya-modern-mcp-oauth-test-"));
  oauthAuthFile = path.join(dir, "mcp-auth.json");
  process.env.KRITYA_MCP_AUTH_FILE = oauthAuthFile;
});

after(() => {
  delete process.env.KRITYA_MCP_AUTH_FILE;
});

test("a modern HTTP server behind OAuth is detected as modern (not legacy) once a valid token is stored", async () => {
  const srv = await withModernHttpServerAuthAware();
  try {
    const auth: StoredAuth = {
      resource: srv.url,
      issuer: "https://as.test",
      tokenEndpoint: "https://as.test/token",
      clientId: "cid",
      accessToken: "at-good",
    };
    saveAuth(srv.url, auth);

    const tools = await loadMcpTools({ modernOauthSrv: { url: srv.url } }, { tracer: NOOP_TRACER });
    assert.equal(tools.length, 1);
    const answer = await tools[0].execute({}, { workspace: "." });
    assert.equal(answer, "pong");
  } finally {
    await srv.close();
  }

  async function withModernHttpServerAuthAware(): Promise<{
    url: string;
    close: () => Promise<void>;
  }> {
    const server = http.createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const auth = req.headers.authorization ?? "";
      if (auth !== "Bearer at-good") {
        res.writeHead(401, { "www-authenticate": 'Bearer error="invalid_token"' });
        res.end(JSON.stringify({ error: "invalid_token" }));
        return;
      }
      const msg = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      let body: unknown;
      if (msg.method === "server/discover") {
        body = {
          jsonrpc: "2.0",
          id: msg.id,
          result: { supportedVersions: ["2026-07-28"], capabilities: { tools: {} } },
        };
      } else if (msg.method === "tools/list") {
        body = {
          jsonrpc: "2.0",
          id: msg.id,
          result: { resultType: "complete", tools: [{ name: "ping", inputSchema: {} }] },
        };
      } else if (msg.method === "tools/call") {
        body = {
          jsonrpc: "2.0",
          id: msg.id,
          result: { resultType: "complete", content: [{ type: "text", text: "pong" }] },
        };
      } else {
        body = { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Method not found" } };
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    return {
      url: `http://127.0.0.1:${port}/mcp`,
      close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
  }
});
