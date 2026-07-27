import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isNonEmptyString,
  isValidPermissionDecision,
  isValidStartOpts,
} from "../electron/ipcValidation.js";

test("isNonEmptyString accepts non-blank strings, rejects everything else", () => {
  assert.equal(isNonEmptyString("gpt"), true);
  assert.equal(isNonEmptyString(""), false);
  assert.equal(isNonEmptyString("   "), false);
  assert.equal(isNonEmptyString(undefined), false);
  assert.equal(isNonEmptyString(42), false);
  assert.equal(isNonEmptyString({ toString: () => "gpt" }), false);
});

test("isValidPermissionDecision only accepts the three known decisions", () => {
  assert.equal(isValidPermissionDecision("yes"), true);
  assert.equal(isValidPermissionDecision("always"), true);
  assert.equal(isValidPermissionDecision("no"), true);
  assert.equal(isValidPermissionDecision("maybe"), false);
  assert.equal(isValidPermissionDecision(undefined), false);
  assert.equal(isValidPermissionDecision({ decision: "yes" }), false);
});

test("isValidStartOpts accepts undefined and well-shaped opts, rejects malformed ones", () => {
  assert.equal(isValidStartOpts(undefined), true);
  assert.equal(isValidStartOpts({}), true);
  assert.equal(isValidStartOpts({ provider: "openai", model: "gpt-5" }), true);
  assert.equal(isValidStartOpts(null), false);
  assert.equal(isValidStartOpts("openai"), false);
  assert.equal(isValidStartOpts([]), false);
  assert.equal(isValidStartOpts({ provider: 123 }), false);
  assert.equal(isValidStartOpts({ model: {} }), false);
  // Prototype pollution style payload — must not be treated as valid opts.
  assert.equal(isValidStartOpts({ __proto__: { polluted: true } }), true);
});
