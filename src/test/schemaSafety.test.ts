import assert from "node:assert/strict";
import { test } from "node:test";
import { checkSchemaSafety } from "../mcp/schemaSafety.js";

test("no $schema field passes", () => {
  assert.equal(
    checkSchemaSafety({ type: "object", properties: { a: { type: "string" } } }).ok,
    true
  );
});

test("$schema naming 2020-12 (and reasonable variants) passes", () => {
  for (const dialect of [
    "https://json-schema.org/draft/2020-12/schema",
    "https://json-schema.org/draft/2020-12/schema#",
    "https://json-schema.org/draft/2020-12/schema/",
    "http://json-schema.org/draft/2020-12/schema",
  ]) {
    const result = checkSchemaSafety({ $schema: dialect, type: "object" });
    assert.equal(result.ok, true, `expected "${dialect}" to pass: ${result.reason}`);
  }
});

test("$schema naming an older/unsupported dialect fails with a clear reason", () => {
  const result = checkSchemaSafety({
    $schema: "http://json-schema.org/draft-07/schema#",
    type: "object",
  });
  assert.equal(result.ok, false);
  assert.match(result.reason ?? "", /unsupported JSON Schema dialect/i);
  assert.match(result.reason ?? "", /draft-07/);
});

test("an unrecognized $schema string fails", () => {
  const result = checkSchemaSafety({ $schema: "not-a-real-dialect", type: "object" });
  assert.equal(result.ok, false);
});

test("a local $ref (#/$defs/foo) anywhere in the schema passes", () => {
  const result = checkSchemaSafety({
    type: "object",
    properties: { a: { $ref: "#/$defs/foo" } },
    $defs: { foo: { type: "string" } },
  });
  assert.equal(result.ok, true);
});

test("a $ref pointing at an http(s) URI fails with a clear reason", () => {
  for (const ref of ["http://example.com/schema.json", "https://example.com/schema.json#/foo"]) {
    const result = checkSchemaSafety({
      type: "object",
      properties: { a: { $ref: ref } },
    });
    assert.equal(result.ok, false, `expected "${ref}" to fail`);
    assert.match(result.reason ?? "", /network URI/i);
    assert.ok(result.reason?.includes(ref));
  }
});

test("a schema exceeding the depth bound fails", () => {
  // Build a deliberately deep nested-properties fixture.
  let deep: Record<string, unknown> = { type: "string" };
  for (let i = 0; i < 60; i++) {
    deep = { type: "object", properties: { next: deep } };
  }
  const result = checkSchemaSafety(deep);
  assert.equal(result.ok, false);
  assert.match(result.reason ?? "", /nesting depth/i);
});

test("a schema exceeding the node-count bound fails", () => {
  const properties: Record<string, unknown> = {};
  for (let i = 0; i < 6000; i++) {
    properties[`p${i}`] = { type: "string" };
  }
  const result = checkSchemaSafety({ type: "object", properties });
  assert.equal(result.ok, false);
  assert.match(result.reason ?? "", /node count/i);
});

test("a schema exceeding the node-count bound via $defs also fails", () => {
  const defs: Record<string, unknown> = {};
  for (let i = 0; i < 6000; i++) {
    defs[`d${i}`] = { type: "string" };
  }
  const result = checkSchemaSafety({ type: "object", $defs: defs });
  assert.equal(result.ok, false);
  assert.match(result.reason ?? "", /node count/i);
});

test("a normal, unremarkable tool schema passes", () => {
  const result = checkSchemaSafety({
    type: "object",
    properties: {
      query: { type: "string" },
      limit: { type: "integer" },
    },
    required: ["query"],
  });
  assert.equal(result.ok, true);
});

test("a non-object schema (e.g. undefined/null) passes", () => {
  assert.equal(checkSchemaSafety(undefined).ok, true);
  assert.equal(checkSchemaSafety(null).ok, true);
  assert.equal(checkSchemaSafety({}).ok, true);
});
