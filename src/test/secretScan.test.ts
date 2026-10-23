import assert from "node:assert/strict";
import { test } from "node:test";
import { redactSecrets, scanCommandForSecretWrite, scanForSecrets } from "../tools/secretScan.js";

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

test("scanForSecrets catches an npm access token", () => {
  const content = "npm_" + "a".repeat(36);
  const matches = scanForSecrets(content);
  assert.ok(matches.some((m) => m.kind === "npm access token"));
});

test("scanForSecrets catches a PyPI upload token", () => {
  const content = "pypi-AgEIcHlwaS5vcmc" + "A".repeat(60);
  const matches = scanForSecrets(content);
  assert.ok(matches.some((m) => m.kind === "PyPI upload token"));
});

test("scanForSecrets catches an Azure Storage Account key", () => {
  const content = "AccountKey=" + "A".repeat(86) + "==";
  const matches = scanForSecrets(content);
  assert.ok(matches.some((m) => m.kind === "Azure Storage Account key"));
});

test("scanForSecrets catches a GCP service account key by its client email", () => {
  const content = '"client_email": "my-svc@my-project.iam.gserviceaccount.com"';
  const matches = scanForSecrets(content);
  assert.ok(matches.some((m) => m.kind === "GCP service account key"));
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

const FAKE_AWS_KEY = "AKIA" + "Z".repeat(16);

test("scanCommandForSecretWrite catches a secret redirected into a file", () => {
  const matches = scanCommandForSecretWrite(`echo '${FAKE_AWS_KEY}' > keys.txt`);
  assert.ok(matches.some((m) => m.kind === "AWS Access Key ID"));
});

test("scanCommandForSecretWrite catches a secret written via a heredoc redirect", () => {
  const command = `cat > app.config <<EOF\naws_key = ${FAKE_AWS_KEY}\nEOF`;
  const matches = scanCommandForSecretWrite(command);
  assert.ok(matches.some((m) => m.kind === "AWS Access Key ID"));
});

test("scanCommandForSecretWrite catches a secret piped through tee", () => {
  const matches = scanCommandForSecretWrite(`echo '${FAKE_AWS_KEY}' | tee keys.txt`);
  assert.ok(matches.some((m) => m.kind === "AWS Access Key ID"));
});

test("scanCommandForSecretWrite ignores a secret with no file write (e.g. an auth header)", () => {
  const matches = scanCommandForSecretWrite(
    `curl -s -H "Authorization: Bearer ${FAKE_AWS_KEY}" https://example.com`
  );
  assert.deepEqual(matches, []);
});

test("scanCommandForSecretWrite does not treat fd duplication (2>&1) as a file write", () => {
  const matches = scanCommandForSecretWrite(`echo ${FAKE_AWS_KEY} 2>&1`);
  assert.deepEqual(matches, []);
});

test("scanCommandForSecretWrite ignores ordinary redirects with no secret", () => {
  assert.deepEqual(scanCommandForSecretWrite("npm test > results.txt 2>&1"), []);
  assert.deepEqual(scanCommandForSecretWrite("echo hello | tee out.txt"), []);
});
