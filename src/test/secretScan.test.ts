import assert from "node:assert/strict";
import { test } from "node:test";
import { redactSecrets, scanForSecrets } from "../tools/secretScan.js";

test("scanForSecrets catches a prefixed env-var assignment like OPENAI_API_KEY=", () => {
  const content = "OPENAI_API_KEY=abcdEFGH12345678ijklMNOP";
  const matches = scanForSecrets(content);
  assert.equal(matches.length, 1);
});

test("scanForSecrets catches a prefixed env-var assignment like DB_PASSWORD=", () => {
  const content = "DB_PASSWORD=Sup3rSecretPassw0rdXYZ";
  const matches = scanForSecrets(content);
  assert.equal(matches.length, 1);
});

test("redactSecrets masks a prefixed env-var value from a cat .env style dump", () => {
  const content = [
    "ANTHROPIC_API_KEY=sk-ant-api03-abcdefghijklmnopqrstuvwxyz",
    "STRIPE_SECRET_KEY=Sup3rRandomHighEntropyValue123456",
  ].join("\n");
  const { redacted, matches } = redactSecrets(content);
  assert.ok(matches.length >= 2);
  assert.ok(!redacted.includes("abcdefghijklmnopqrstuvwxyz"));
  assert.ok(!redacted.includes("Sup3rRandomHighEntropyValue123456"));
});
