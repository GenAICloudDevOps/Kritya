import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CONTEXT_WARN_THRESHOLD_PCT,
  crossedContextWarnThreshold,
} from "../agent/contextWarning.js";

test("crossedContextWarnThreshold fires when usage rises past the threshold", () => {
  assert.equal(crossedContextWarnThreshold(70, 80), true);
});

test("crossedContextWarnThreshold does not fire when already above the threshold", () => {
  assert.equal(crossedContextWarnThreshold(80, 85), false);
});

test("crossedContextWarnThreshold does not fire while still below the threshold", () => {
  assert.equal(crossedContextWarnThreshold(10, 50), false);
});

test("crossedContextWarnThreshold fires again after dropping back down and rising", () => {
  assert.equal(crossedContextWarnThreshold(20, 76), true);
});

test("the default threshold is below the auto-compact threshold", () => {
  assert.ok(CONTEXT_WARN_THRESHOLD_PCT < 80);
});
