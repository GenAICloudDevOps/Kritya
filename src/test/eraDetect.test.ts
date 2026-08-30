import assert from "node:assert/strict";
import { test } from "node:test";
import { modernMeta, isRecognizedModernError, parseDiscoverResult } from "../mcp/eraDetect.js";
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
