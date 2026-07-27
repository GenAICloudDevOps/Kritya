import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isNonEmptyString,
  isValidPermissionDecision,
  isValidStartOpts,
  isValidModeFlags,
  permissionIdBelongsToSession,
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

test("isValidModeFlags accepts well-shaped boolean flags, rejects malformed ones", () => {
  assert.equal(isValidModeFlags({ planMode: true }), true);
  assert.equal(isValidModeFlags({ dryRunMode: false, acceptEdits: true }), true);
  assert.equal(isValidModeFlags({}), true);
  assert.equal(isValidModeFlags(undefined), false);
  assert.equal(isValidModeFlags(null), false);
  assert.equal(isValidModeFlags({ planMode: "yes" }), false);
  assert.equal(isValidModeFlags({ unknownFlag: true }), false);
  assert.equal(isValidModeFlags([]), false);
});

test("permissionIdBelongsToSession matches only ids minted for that webContents id", () => {
  assert.equal(permissionIdBelongsToSession("perm-3-1", 3), true);
  assert.equal(permissionIdBelongsToSession("perm-3-42", 3), true);
  assert.equal(permissionIdBelongsToSession("perm-31-1", 3), false);
  assert.equal(permissionIdBelongsToSession("perm-3-1", 4), false);
  assert.equal(permissionIdBelongsToSession("not-a-perm-id", 3), false);
});
