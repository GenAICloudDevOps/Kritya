import assert from "node:assert/strict";
import { test } from "node:test";
import {
  modernMeta,
  isRecognizedModernError,
  parseDiscoverResult,
  probeStdioEra,
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
