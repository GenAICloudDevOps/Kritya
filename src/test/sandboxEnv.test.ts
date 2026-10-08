// Kept in its own file on purpose: `CONFIG_DIR` is computed from the home
// directory at module load, so the scratch HOME/USERPROFILE below has to be set
// before anything imports `config.js` — and `node:test` gives each file its own
// process (same reason as doctorEnv.test.ts). Importing sandbox.js pulls in
// config.js transitively, so even a type-only import would be too early.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

test("the sandbox backend is discovered even when .env is loaded by no one else", async (t) => {
  const previousHome = process.env.HOME;
  const previousProfile = process.env.USERPROFILE;
  const previousExec = process.env.KRITYA_MXC_EXEC;
  const previousBinDir = process.env.MXC_BIN_DIR;

  const home = fs.mkdtempSync(path.join(os.tmpdir(), "kritya-sandbox-env-"));
  // Point the config directory at the scratch home *before* importing, since
  // CONFIG_DIR is frozen at module load from os.homedir().
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  fs.mkdirSync(path.join(home, ".kritya"), { recursive: true });

  // A fake executor plus the MXC_BIN_DIR layout that locateMxcExecutable
  // expects: <binDir>/<arch>/wxc-exec.exe. Only existence is checked; nothing
  // is spawned.
  const binDir = path.join(home, "mxcbin");
  const arch = os.arch() === "arm64" ? "arm64" : "x64";
  fs.mkdirSync(path.join(binDir, arch), { recursive: true });
  const fakeExec = path.join(binDir, arch, "wxc-exec.exe");
  fs.writeFileSync(fakeExec, "");

  // The backend is configured through the global .env and nowhere else — this
  // is the whole point of the test: the sandbox module must load that file
  // itself rather than relying on whichever entry point calls it first.
  fs.writeFileSync(path.join(home, ".kritya", ".env"), `MXC_BIN_DIR=${binDir}\n`, { mode: 0o600 });

  delete process.env.KRITYA_MXC_EXEC;
  delete process.env.MXC_BIN_DIR;

  try {
    // Fresh module instance so nothing is memoized from an earlier import and
    // CONFIG_DIR is computed against the scratch home.
    const mod = await import(
      `${pathToFileURL(path.join(process.cwd(), "dist/shell/sandbox.js")).href}?env=${Date.now()}`
    );
    t.mock.method(os, "platform", () => "win32");
    mod.resetSandboxToolCache();

    // No loadDotEnv call by the caller — that is the bug being guarded.
    assert.equal(
      mod.sandboxAvailable(),
      true,
      "MXC_BIN_DIR from the global .env should make the backend available"
    );
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousProfile;
    if (previousExec === undefined) delete process.env.KRITYA_MXC_EXEC;
    else process.env.KRITYA_MXC_EXEC = previousExec;
    if (previousBinDir === undefined) delete process.env.MXC_BIN_DIR;
    else process.env.MXC_BIN_DIR = previousBinDir;
    fs.rmSync(home, { recursive: true, force: true });
  }
});
