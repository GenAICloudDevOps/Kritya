import assert from "node:assert/strict";
import { test } from "node:test";
import http from "node:http";
import {
  modernMeta,
  isRecognizedModernError,
  parseDiscoverResult,
  probeStdioEra,
  probeHttpEra,
} from "../mcp/eraDetect.js";
import { VERSION } from "../version.js";

test("modernMeta includes the protocol version and empty clientCapabilities by default", () => {
  const meta = modernMeta();
  assert.equal(meta["io.modelcontextprotocol/protocolVersion"], "2026-07-28");
  assert.deepEqual(meta["io.modelcontextprotocol/clientCapabilities"], {});
  assert.deepEqual(meta["io.modelcontextprotocol/clientInfo"], {
    name: "kritya",
    version: VERSION,
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
