import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

/**
 * CONFIG_DIR is computed from os.homedir() at module-load time, so pointing
 * HOME/USERPROFILE at an empty scratch directory *before* the first import of
 * headless.js (via a cache-busting query, as in config.test.ts) gives each
 * test an isolated "no config, no API key" environment without ever touching
 * the developer's real ~/.kritya.
 */
async function freshHome(): Promise<string> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "kritya-headless-home-"));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  return home;
}

function stubConsole(): { logs: string[]; errors: string[]; restore: () => void } {
  const logs: string[] = [];
  const errors: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = ((msg?: unknown) => {
    logs.push(String(msg));
  }) as typeof console.log;
  console.error = ((msg?: unknown) => {
    errors.push(String(msg));
  }) as typeof console.error;
  return {
    logs,
    errors,
    restore: () => {
      console.log = originalLog;
      console.error = originalError;
    },
  };
}

const baseArgs = {
  prompt: "hello",
  provider: "",
  model: "",
  continue: false,
  allowAll: false,
  trust: false,
  timeoutSeconds: 5,
};

test("runHeadless exits 1 and reports as JSON when no provider has an API key configured", async () => {
  await freshHome();
  delete process.env.NVIDIA_API_KEY;
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "kritya-headless-ws-"));
  const { runHeadless } = await import(`../headless.js?t=${Date.now()}`);
  const console_ = stubConsole();
  try {
    const code = await runHeadless({ ...baseArgs, dir: workspace, output: "json" });
    assert.equal(code, 1);
    assert.equal(console_.logs.length, 1);
    const parsed = JSON.parse(console_.logs[0]);
    assert.equal(parsed.success, false);
    assert.match(parsed.error, /No API key found for provider "nvidia"/);
    assert.deepEqual(parsed.toolCalls, []);
    assert.equal(parsed.usage.promptTokens, 0);
  } finally {
    console_.restore();
  }
});

test("runHeadless in text mode prints the same error to stderr instead of stdout JSON", async () => {
  await freshHome();
  delete process.env.NVIDIA_API_KEY;
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "kritya-headless-ws-"));
  const { runHeadless } = await import(`../headless.js?t=${Date.now()}`);
  const console_ = stubConsole();
  try {
    const code = await runHeadless({ ...baseArgs, dir: workspace, output: "text" });
    assert.equal(code, 1);
    assert.equal(
      console_.logs.length,
      0,
      "no result text was produced, so nothing prints to stdout"
    );
    assert.equal(console_.errors.length, 1);
    assert.match(console_.errors[0], /Error: No API key found for provider "nvidia"/);
  } finally {
    console_.restore();
  }
});
