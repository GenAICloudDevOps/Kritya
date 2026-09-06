import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { isBannerSeen, markBannerSeen } from "../trust/bannerSeen.js";

async function makeWorkspace(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "kritya-banner-seen-test-"));
}

test("isBannerSeen is false with no store file", async () => {
  const ws = await makeWorkspace();
  const storeFile = path.join(ws, "banner-seen.json");
  assert.equal(isBannerSeen(ws, storeFile), false);
});

test("markBannerSeen persists, isBannerSeen reflects it", async () => {
  const ws = await makeWorkspace();
  const storeFile = path.join(await makeWorkspace(), "banner-seen.json");
  assert.equal(isBannerSeen(ws, storeFile), false);
  markBannerSeen(ws, storeFile);
  assert.equal(isBannerSeen(ws, storeFile), true);
});

test("marking one workspace does not affect another sharing the same store", async () => {
  const ws1 = await makeWorkspace();
  const ws2 = await makeWorkspace();
  const storeFile = path.join(await makeWorkspace(), "banner-seen.json");
  markBannerSeen(ws1, storeFile);
  assert.equal(isBannerSeen(ws1, storeFile), true);
  assert.equal(isBannerSeen(ws2, storeFile), false);
});

test("isBannerSeen is false for malformed JSON", async () => {
  const ws = await makeWorkspace();
  const storeFile = path.join(await makeWorkspace(), "banner-seen.json");
  await fs.writeFile(storeFile, "{ not json");
  assert.equal(isBannerSeen(ws, storeFile), false);
});
