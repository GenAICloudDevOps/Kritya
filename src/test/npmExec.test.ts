import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { npmLaunch } from "../../scripts/npmExec.mjs";

/**
 * These assert on the *decision* rather than spawning anything. That is the
 * part that matters and the part that was actually wrong: `execFileSync("npm",
 * …)` cannot launch npm on Windows, where npm is an `npm.cmd` shim. Whether
 * the chosen command then runs is npm's business.
 */

/** Runs `fn` with npm_execpath set to `value`, restoring it afterwards. */
async function withNpmExecpath<T>(value: string | undefined, fn: () => T): Promise<T> {
  const previous = process.env.npm_execpath;
  if (value === undefined) delete process.env.npm_execpath;
  else process.env.npm_execpath = value;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.npm_execpath;
    else process.env.npm_execpath = previous;
  }
}

async function realFile(name = "npm-cli.js"): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "kritya-npmexec-"));
  const file = path.join(dir, name);
  await fsp.writeFile(file, "// stand-in for npm's CLI entry point\n");
  return file;
}

test("npmLaunch runs npm_execpath through the current Node binary, with no shell", async () => {
  const cli = await realFile();

  const launch = await withNpmExecpath(cli, () => npmLaunch(["pack", "--dry-run", "--json"]));

  // No shell means no quoting: an argument containing a space survives intact,
  // which is exactly what a `shell: true` fallback would break.
  assert.equal(launch.file, process.execPath);
  assert.deepEqual(launch.args, [cli, "pack", "--dry-run", "--json"]);
  assert.equal(launch.shell, false);
});

test("npmLaunch passes an argument containing spaces through untouched", async () => {
  const cli = await realFile();
  const spaced = path.join(os.tmpdir(), "a directory with spaces", "out");

  const launch = await withNpmExecpath(cli, () =>
    npmLaunch(["pack", "--pack-destination", spaced])
  );

  assert.deepEqual(launch.args, [cli, "pack", "--pack-destination", spaced]);
});

test("npmLaunch falls back to the npm shim when there is no npm_execpath", async () => {
  const launch = await withNpmExecpath(undefined, () => npmLaunch(["--version"]));

  assert.equal(launch.file, "npm");
  assert.deepEqual(launch.args, ["--version"]);
  // A shell is needed on Windows to launch the .cmd shim, and only there.
  assert.equal(launch.shell, process.platform === "win32");
});

test("npmLaunch ignores an npm_execpath that no longer exists", async () => {
  const cli = await realFile();
  const missing = path.join(path.dirname(cli), "gone.js");
  assert.ok(!fs.existsSync(missing));

  const launch = await withNpmExecpath(missing, () => npmLaunch(["--version"]));

  // Falls back rather than trying to execute a stale path.
  assert.equal(launch.file, "npm");
  assert.deepEqual(launch.args, ["--version"]);
});

test("npmLaunch never mutates the arguments it is given", async () => {
  const cli = await realFile();
  const args = ["pack", "--json"];

  await withNpmExecpath(cli, () => npmLaunch(args));

  assert.deepEqual(args, ["pack", "--json"]);
});
