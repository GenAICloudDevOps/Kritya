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
