import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertJsonDepthWithinLimit,
  assertJsonSizeWithinLimit,
  assertJsonWithinLimits,
  JsonSafetyError,
} from "../config/jsonSafety.js";

test("assertJsonSizeWithinLimit passes small input and rejects oversized input", () => {
  assert.doesNotThrow(() => assertJsonSizeWithinLimit("{}", 10));
  assert.throws(() => assertJsonSizeWithinLimit("x".repeat(11), 10), JsonSafetyError);
});

test("assertJsonDepthWithinLimit ignores braces/brackets inside string values", () => {
  const raw = JSON.stringify({ note: "{[{[{[{[" });
  assert.doesNotThrow(() => assertJsonDepthWithinLimit(raw, 5));
});

test("assertJsonDepthWithinLimit rejects deep nesting", () => {
  const deep = "[".repeat(10) + "]".repeat(10);
  assert.throws(() => assertJsonDepthWithinLimit(deep, 5), JsonSafetyError);
});

test("assertJsonDepthWithinLimit handles escaped quotes inside strings", () => {
  const raw = String.raw`{"a": "he said \"[[[[[\""}`;
  assert.doesNotThrow(() => assertJsonDepthWithinLimit(raw, 3));
});

test("assertJsonWithinLimits runs both checks", () => {
  assert.doesNotThrow(() => assertJsonWithinLimits("{}", "test"));
  assert.throws(() => assertJsonWithinLimits("x".repeat(100), "test", 10, 100), JsonSafetyError);
});
