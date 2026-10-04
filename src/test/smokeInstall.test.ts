import assert from "node:assert/strict";
import { test } from "node:test";
import { inspectInstalledRun } from "../../scripts/smoke-install.mjs";

const PKG = { name: "kritya", version: "0.9.0-beta" };

test("inspectInstalledRun accepts a matching version and non-empty help", () => {
  const failures = inspectInstalledRun(PKG, {
    version: "0.9.0-beta",
    help: "kritya — a lean, provider-agnostic terminal coding agent\n",
  });

  assert.deepEqual(failures, []);
});

test("inspectInstalledRun flags a version mismatch", () => {
  const failures = inspectInstalledRun(PKG, { version: "0.8.26-beta", help: "usage\n" });

  assert.equal(failures.length, 1);
  assert.match(failures[0], /printed "0\.8\.26-beta" but package\.json says "0\.9\.0-beta"/);
});

test("inspectInstalledRun flags an empty --help", () => {
  const failures = inspectInstalledRun(PKG, { version: "0.9.0-beta", help: "   \n" });

  assert.equal(failures.length, 1);
  assert.match(failures[0], /--help` printed nothing/);
});

test("inspectInstalledRun reports both failures together", () => {
  const failures = inspectInstalledRun(PKG, { version: "0.0.0", help: "" });

  assert.equal(failures.length, 2);
});
