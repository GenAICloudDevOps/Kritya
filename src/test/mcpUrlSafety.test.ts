import assert from "node:assert/strict";
import { test } from "node:test";
import { assertSafeUrl } from "../mcp/client.js";

test("assertSafeUrl allows https to a public host", () => {
  assert.doesNotThrow(() => assertSafeUrl("s", "https://example.com/mcp"));
});

test("assertSafeUrl allows http to loopback (local dev server)", () => {
  assert.doesNotThrow(() => assertSafeUrl("s", "http://localhost:8080/mcp"));
  assert.doesNotThrow(() => assertSafeUrl("s", "http://127.0.0.1:8080/mcp"));
});

test("assertSafeUrl rejects http to a non-loopback host regardless of range", () => {
  assert.throws(() => assertSafeUrl("s", "http://example.com/mcp"), /plain http/);
});

test("assertSafeUrl rejects an unsupported scheme", () => {
  assert.throws(() => assertSafeUrl("s", "ftp://example.com/mcp"), /unsupported scheme/);
});

test("assertSafeUrl rejects an invalid URL", () => {
  assert.throws(() => assertSafeUrl("s", "not a url"), /invalid url/);
});

test("assertSafeUrl rejects https to a private/internal host, incl. cloud metadata", () => {
  // A bearer token in the MCP config would otherwise be sent in the clear to
  // an internal address the moment "https" makes the scheme check pass —
  // the scheme check alone says nothing about where the traffic actually goes.
  assert.throws(() => assertSafeUrl("s", "https://169.254.169.254/mcp"), /private\/internal/);
  assert.throws(() => assertSafeUrl("s", "https://10.0.0.5/mcp"), /private\/internal/);
  assert.throws(() => assertSafeUrl("s", "https://192.168.1.1/mcp"), /private\/internal/);
});

test("assertSafeUrl still allows https to loopback", () => {
  assert.doesNotThrow(() => assertSafeUrl("s", "https://127.0.0.1:8080/mcp"));
});
