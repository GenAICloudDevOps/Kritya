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

test("scrubbedShellEnv removes *_API_KEY vars but keeps the rest", async () => {
  process.env.KRITYA_TEST_API_KEY = "sekrit";
  process.env.KRITYA_TEST_PLAIN = "ok";
  try {
    const { scrubbedShellEnv } = await import(`../config/config.js?t=${Date.now()}`);
    const env = scrubbedShellEnv();
    assert.equal(env.KRITYA_TEST_API_KEY, undefined);
    assert.equal(env.KRITYA_TEST_PLAIN, "ok");
  } finally {
    delete process.env.KRITYA_TEST_API_KEY;
    delete process.env.KRITYA_TEST_PLAIN;
  }
});

test("legacyGlobalModel applies only to the provider it was saved under", async () => {
  const { legacyGlobalModel } = await import(`../config/config.js?t=${Date.now()}`);
  // A pre-per-provider config: the global model was chosen while nvidia was active.
  const config = { provider: "nvidia", model: "nvidia/nemotron-3.5-lightning-30b-a3b" };

  // Still honoured for nvidia, so existing configs keep working...
  assert.equal(legacyGlobalModel(config, "nvidia"), "nvidia/nemotron-3.5-lightning-30b-a3b");
  // ...but never leaks into another provider (this is what used to 404 switchyard).
  assert.equal(legacyGlobalModel(config, "switchyard"), undefined);
  assert.equal(legacyGlobalModel(config, "openai"), undefined);
});

test("legacyGlobalModel treats an absent provider as the nvidia default", async () => {
  const { legacyGlobalModel } = await import(`../config/config.js?t=${Date.now()}`);
  const config = { model: "nvidia/some-model" };
  assert.equal(legacyGlobalModel(config, "nvidia"), "nvidia/some-model");
  assert.equal(legacyGlobalModel(config, "switchyard"), undefined);
});

test("saveConfig writes atomically: round-trips, forces 0o600, and leaves no stray temp file", async (t) => {
  await freshHome();
  const { saveConfig, loadConfig, CONFIG_FILE } = await import(
    `../config/config.js?t=${Date.now()}`
  );

  saveConfig({ provider: "openai" });
  assert.equal(loadConfig().provider, "openai");

  // Simulate a pre-existing config.json with looser permissions (e.g. from
  // an older kritya version, or a restored backup) — the write must still
  // force it back to owner-only.
  await fs.chmod(CONFIG_FILE, 0o644);
  saveConfig({ apiKey: "sk-test" });
  if (process.platform === "win32") {
    t.skip("POSIX modes are not meaningful on Windows");
  } else {
    const mode = (await fs.stat(CONFIG_FILE)).mode & 0o777;
    assert.equal(mode, 0o600);
  }
  assert.equal(loadConfig().apiKey, "sk-test");
  assert.equal(loadConfig().provider, "openai");

  const dirFiles = await fs.readdir(path.dirname(CONFIG_FILE));
  assert.ok(!dirFiles.some((f) => f.includes(".tmp-")));
});
