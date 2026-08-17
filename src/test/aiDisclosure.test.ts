import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { isAiDisclosureShown, markAiDisclosureShown } from "../trust/aiDisclosure.js";

async function makeWorkspace(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "kritya-ai-disclosure-test-"));
}

test("isAiDisclosureShown is false with no store file", async () => {
  const ws = await makeWorkspace();
  const storeFile = path.join(ws, "ai-disclosure.json");
  assert.equal(isAiDisclosureShown(ws, storeFile), false);
});

test("markAiDisclosureShown persists, isAiDisclosureShown reflects it", async () => {
  const ws = await makeWorkspace();
  const storeFile = path.join(await makeWorkspace(), "ai-disclosure.json");
  assert.equal(isAiDisclosureShown(ws, storeFile), false);
  markAiDisclosureShown(ws, storeFile);
  assert.equal(isAiDisclosureShown(ws, storeFile), true);
});

test("marking one workspace does not affect another sharing the same store", async () => {
  const ws1 = await makeWorkspace();
  const ws2 = await makeWorkspace();
  const storeFile = path.join(await makeWorkspace(), "ai-disclosure.json");
  markAiDisclosureShown(ws1, storeFile);
  assert.equal(isAiDisclosureShown(ws1, storeFile), true);
  assert.equal(isAiDisclosureShown(ws2, storeFile), false);
});

test("isAiDisclosureShown is false for malformed JSON", async () => {
  const ws = await makeWorkspace();
  const storeFile = path.join(await makeWorkspace(), "ai-disclosure.json");
  await fs.writeFile(storeFile, "{ not json");
  assert.equal(isAiDisclosureShown(ws, storeFile), false);
});
