import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { describeGatedContent, gatedContentHash, isTrusted, saveTrust } from "../trust/trust.js";

async function makeWorkspace(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "kritya-trust-test-"));
}

async function writeSettings(workspace: string, content: unknown): Promise<void> {
  const dir = path.join(workspace, ".kritya");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "settings.json"), JSON.stringify(content));
}

test("gatedContentHash is null with no settings file", async () => {
  const ws = await makeWorkspace();
  assert.equal(gatedContentHash(ws), null);
});

test("gatedContentHash is null for a deny-only settings file", async () => {
  const ws = await makeWorkspace();
  await writeSettings(ws, { deny: ["shell(rm *)"] });
  assert.equal(gatedContentHash(ws), null);
});

test("gatedContentHash is null for malformed JSON", async () => {
  const ws = await makeWorkspace();
  await fs.mkdir(path.join(ws, ".kritya"), { recursive: true });
  await fs.writeFile(path.join(ws, ".kritya", "settings.json"), "{ not json");
  assert.equal(gatedContentHash(ws), null);
});

test("gatedContentHash is non-null when allow or hooks are present", async () => {
  const ws1 = await makeWorkspace();
  await writeSettings(ws1, { allow: ["shell(npm test)"] });
  assert.ok(gatedContentHash(ws1));

  const ws2 = await makeWorkspace();
  await writeSettings(ws2, { hooks: { stop: [{ command: "npm run lint" }] } });
  assert.ok(gatedContentHash(ws2));
});

test("gatedContentHash is stable for identical content, changes with content", async () => {
  const ws = await makeWorkspace();
  await writeSettings(ws, { allow: ["shell(npm test)"], deny: ["shell(rm *)"] });
  const first = gatedContentHash(ws);

  // Re-writing with the same allow/hooks (deny is irrelevant to the hash) yields the same hash.
  await writeSettings(ws, { allow: ["shell(npm test)"], deny: ["shell(git push --force)"] });
  assert.equal(gatedContentHash(ws), first);

  // Changing the gated content itself changes the hash.
  await writeSettings(ws, { allow: ["shell(npm test)", "shell(npm run build)"] });
  assert.notEqual(gatedContentHash(ws), first);
});

test("describeGatedContent surfaces settings, .env, and custom commands", async () => {
  const ws = await makeWorkspace();
  await writeSettings(ws, { allow: ["shell(npm test)"], hooks: { stop: [{ command: "lint" }] } });
  await fs.writeFile(path.join(ws, ".env"), "EVIL_VAR=payload\n");
  const cmdDir = path.join(ws, ".kritya", "commands");
  await fs.mkdir(cmdDir, { recursive: true });
  await fs.writeFile(path.join(cmdDir, "deploy.md"), "description: ship it\nrun the deploy");

  const preview = describeGatedContent(ws);
  assert.match(preview, /shell\(npm test\)/, "allow rules shown");
  assert.match(preview, /lint/, "hooks shown");
  assert.match(preview, /EVIL_VAR=<redacted>/, ".env variable name shown, value redacted");
  assert.doesNotMatch(preview, /payload/, ".env value not printed in plaintext");
  assert.match(preview, /\/deploy/, "custom command listed");
});

test("isTrusted/saveTrust round-trip and are hash-pinned", async () => {
  const ws = await makeWorkspace();
  await writeSettings(ws, { allow: ["shell(npm test)"] });
  const storeFile = path.join(await makeWorkspace(), "trusted.json");
  const hash = gatedContentHash(ws)!;

  assert.equal(isTrusted(ws, hash, storeFile), false);
  saveTrust(ws, hash, storeFile);
  assert.equal(isTrusted(ws, hash, storeFile), true);

  // Editing the settings file invalidates trust for the new content.
  await writeSettings(ws, { allow: ["shell(npm test)", "shell(rm *)"] });
  const newHash = gatedContentHash(ws)!;
  assert.notEqual(newHash, hash);
  assert.equal(isTrusted(ws, newHash, storeFile), false);
});
