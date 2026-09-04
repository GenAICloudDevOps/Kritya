import assert from "node:assert/strict";
import { test } from "node:test";
import { ProviderClient } from "../provider/client.js";

test("ProviderClient allows an HTTPS provider on a public host", () => {
  assert.doesNotThrow(() => new ProviderClient("key", "https://example.com/v1"));
});

test("ProviderClient allows HTTP for a loopback provider", () => {
  assert.doesNotThrow(() => new ProviderClient("key", "http://127.0.0.1:11434/v1"));
  assert.doesNotThrow(() => new ProviderClient("key", "http://localhost:11434/v1"));
});

test("ProviderClient rejects plaintext HTTP to a public host", () => {
  assert.throws(() => new ProviderClient("key", "http://provider.example/v1"), /plain http/);
});

test("ProviderClient rejects HTTPS to private or internal addresses", () => {
  assert.throws(() => new ProviderClient("key", "https://169.254.169.254/v1"), /private\/internal/);
  assert.throws(() => new ProviderClient("key", "https://10.0.0.5/v1"), /private\/internal/);
});

test("ProviderClient rejects malformed and unsupported provider URLs", () => {
  assert.throws(() => new ProviderClient("key", "not a url"), /invalid url/);
  assert.throws(() => new ProviderClient("key", "ftp://example.com/v1"), /unsupported scheme/);
});
