import assert from "node:assert/strict";
import { after, test } from "node:test";
import { ModernMcpConnection } from "../mcp/clientModern.js";
import { StdioTransport } from "../mcp/transport.js";
import { loadMcpTools, shutdownMcp } from "../mcp/client.js";
import { NOOP_TRACER } from "../telemetry/tracer.js";

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
