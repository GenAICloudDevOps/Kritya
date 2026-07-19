import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BUDGET_WARN_THRESHOLD_PCT,
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
