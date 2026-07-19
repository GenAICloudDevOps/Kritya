import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BUDGET_WARN_THRESHOLD_PCT,
  cacheSavingsFor,
  costFor,
  crossedBudgetWarnThreshold,
  DEFAULT_TOKEN_BUDGET,
  tokenBudgetFor,
} from "../agent/budget.js";

test("tokenBudgetFor uses the configured budget when set and positive", () => {
  assert.equal(tokenBudgetFor({ tokenBudget: 2_000_000 }), 2_000_000);
});

test("tokenBudgetFor falls back to the default when unset", () => {
  assert.equal(tokenBudgetFor({}), DEFAULT_TOKEN_BUDGET);
});

test("tokenBudgetFor falls back to the default for a zero or negative value", () => {
  assert.equal(tokenBudgetFor({ tokenBudget: 0 }), DEFAULT_TOKEN_BUDGET);
  assert.equal(tokenBudgetFor({ tokenBudget: -5 }), DEFAULT_TOKEN_BUDGET);
});

test("crossedBudgetWarnThreshold fires when usage rises past the threshold", () => {
  assert.equal(crossedBudgetWarnThreshold(70, 85), true);
});

test("crossedBudgetWarnThreshold does not fire when already above the threshold", () => {
  assert.equal(crossedBudgetWarnThreshold(85, 90), false);
});

test("crossedBudgetWarnThreshold does not fire while still below the threshold", () => {
  assert.equal(crossedBudgetWarnThreshold(10, 50), false);
});

test("crossedBudgetWarnThreshold fires again after a reset drops usage back down", () => {
  assert.equal(crossedBudgetWarnThreshold(0, 82), true);
});

test("the default warn threshold is below 100 (the hard stop)", () => {
  assert.ok(BUDGET_WARN_THRESHOLD_PCT < 100);
});

const pricing = { input: 1.0, output: 4.0, cachedInput: 0.1 };

test("costFor prices cached prompt tokens at the discounted rate", () => {
  // 1M prompt (600k cached) + 100k completion:
  // 400k @ $1 + 600k @ $0.10 + 100k @ $4 = 0.4 + 0.06 + 0.4
  const u = { promptTokens: 1_000_000, completionTokens: 100_000, cachedPromptTokens: 600_000 };
  assert.ok(Math.abs(costFor(u, pricing) - 0.86) < 1e-9);
});

test("costFor without a cachedInput rate charges everything at the input rate", () => {
  const u = { promptTokens: 1_000_000, completionTokens: 0, cachedPromptTokens: 600_000 };
  assert.ok(Math.abs(costFor(u, { input: 1.0, output: 4.0 }) - 1.0) < 1e-9);
});

test("costFor handles usage with no cached-token field (older providers)", () => {
  const u = { promptTokens: 500_000, completionTokens: 250_000 };
  assert.ok(Math.abs(costFor(u, pricing) - (0.5 + 1.0)) < 1e-9);
});

test("cacheSavingsFor is the delta between full and discounted input rates", () => {
  const u = { promptTokens: 1_000_000, completionTokens: 0, cachedPromptTokens: 600_000 };
  // 600k * ($1.00 - $0.10) / 1M = 0.54
  assert.ok(Math.abs(cacheSavingsFor(u, pricing) - 0.54) < 1e-9);
});

test("cacheSavingsFor is zero without a cachedInput rate or without cache hits", () => {
  const u = { promptTokens: 1_000_000, completionTokens: 0, cachedPromptTokens: 600_000 };
  assert.equal(cacheSavingsFor(u, { input: 1.0, output: 4.0 }), 0);
  assert.equal(cacheSavingsFor({ promptTokens: 1_000_000, completionTokens: 0 }, pricing), 0);
});
