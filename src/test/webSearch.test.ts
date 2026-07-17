import assert from "node:assert/strict";
import { test } from "node:test";
import { parseMaxResults } from "../tools/webSearch.js";

test("parseMaxResults defaults to 5 when max_results is omitted", () => {
  assert.equal(parseMaxResults(undefined), 5);
});

test("parseMaxResults preserves an explicit 0 instead of defaulting", () => {
  assert.equal(parseMaxResults(0), 0);
});

test("parseMaxResults passes through explicit positive values", () => {
  assert.equal(parseMaxResults(3), 3);
});
