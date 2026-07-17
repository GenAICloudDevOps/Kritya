import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

async function freshHome(): Promise<string> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "kritya-home-"));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  return home;
}

test("loadConfig no longer falls back to the legacy .code-cli config path", async () => {
  const home = await freshHome();
  const legacyFile = path.join(home, ".code-cli", "config.json");
  await fs.mkdir(path.dirname(legacyFile), { recursive: true });
  await fs.writeFile(legacyFile, JSON.stringify({ model: "legacy-model" }));

  const { loadConfig } = await import(`../config/config.js?t=${Date.now()}`);
  assert.deepEqual(loadConfig(), {});
});
