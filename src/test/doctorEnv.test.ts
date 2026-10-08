import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

/**
 * `kritya doctor` must see a provider key that lives only in the user's global
 * `~/.kritya/.env` — the same file the interactive and headless paths load.
 * Before `runDoctorCli` loaded it, the provider check saw only the ambient
 * environment and reported a false "no API key", which also flipped the exit
 * code to 1 on a perfectly healthy install.
 *
 * CONFIG_DIR is derived from os.homedir() at module-load time, so this file
 * points HOME/USERPROFILE at a scratch directory *before* the first import of
 * doctor.js (via a cache-busting query, as in headless.test.ts). That is why
 * nothing here imports config.js at the top: a single static import would
 * freeze CONFIG_DIR at the developer's real home and quietly defeat the whole
 * setup. node:test gives each file its own process, so this stays isolated.
 */
async function freshHome(): Promise<string> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "kritya-doctor-home-"));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  return home;
}

function stubConsole(): { logs: string[]; restore: () => void } {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = ((msg?: unknown) => {
    logs.push(String(msg));
  }) as typeof console.log;
  return {
    logs,
    restore: () => {
      console.log = originalLog;
    },
  };
}

test("runDoctorCli resolves a provider key that lives only in the global .env", async () => {
  const home = await freshHome();
  const configDir = path.join(home, ".kritya");
  const envFile = path.join(configDir, ".env");
  await fs.mkdir(configDir, { recursive: true });
  await fs.writeFile(envFile, "NVIDIA_API_KEY=key-from-the-global-dotenv\n");

  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "kritya-doctor-ws-"));
  // loadDotEnv never overrides an existing variable, so an ambient key would
  // make this pass for the wrong reason.
  const previousKey = process.env.NVIDIA_API_KEY;
  delete process.env.NVIDIA_API_KEY;

  const { logs, restore } = stubConsole();
  try {
    const { runDoctorCli } = await import(`../commands/doctor.js?t=${Date.now()}`);

    const providerOf = (report: {
      sections: Array<{ title: string; checks: Array<{ level: string; label: string }> }>;
    }) => {
      const section = report.sections.find((s) => s.title === "Provider");
      assert.ok(section, "expected a Provider section");
      return section;
    };

    // The key exists only in ~/.kritya/.env — the case that used to fail.
    const okCode = await runDoctorCli([workspace, "--offline", "--json"], { workspace });
    const okReport = JSON.parse(logs.join("\n"));
    const okProvider = providerOf(okReport);
    assert.equal(
      okProvider.checks.filter((c) => c.level === "fail").length,
      0,
      `expected no failing provider check, got ${JSON.stringify(okProvider.checks)}`
    );
    assert.ok(
      okProvider.checks.some((c) => c.level === "ok" && /API key resolved/.test(c.label)),
      `expected the key to resolve, got ${JSON.stringify(okProvider.checks)}`
    );
    assert.equal(okCode, 0, "a healthy install must exit 0");

    // Control: with the .env gone the check must fail again, otherwise the
    // assertion above would pass even if doctor ignored the file entirely.
    await fs.rm(envFile);
    delete process.env.NVIDIA_API_KEY;
    logs.length = 0;

    const failCode = await runDoctorCli([workspace, "--offline", "--json"], { workspace });
    const failProvider = providerOf(JSON.parse(logs.join("\n")));
    assert.ok(
      failProvider.checks.some((c) => c.level === "fail" && /no API key/.test(c.label)),
      `expected a missing-key failure, got ${JSON.stringify(failProvider.checks)}`
    );
    assert.equal(failCode, 1, "a missing key must still exit 1");
  } finally {
    restore();
    if (previousKey === undefined) delete process.env.NVIDIA_API_KEY;
    else process.env.NVIDIA_API_KEY = previousKey;
    await fs.rm(home, { recursive: true, force: true });
    await fs.rm(workspace, { recursive: true, force: true });
  }
});
