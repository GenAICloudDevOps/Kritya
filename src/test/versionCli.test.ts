import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { VERSION } from "../version.js";

const execFileAsync = promisify(execFile);
const distIndex = path.join(process.cwd(), "dist", "index.js");

/**
 * `kritya --version` is the one command a script, a CI pipeline, or a package
 * manager calls before anything else is known to work, so its contract is
 * narrow and worth pinning: exactly the version on stdout, nothing else, exit
 * zero.
 *
 * It is also the fix this test exists to protect. The version used to be
 * printed and then `process.exit()` was deferred behind an awaited update
 * notice; because `--version` is top-level module code with no `return`, the
 * interactive path below it ran anyway and was killed mid-frame when the
 * notice resolved, tripping a libuv assertion on Windows
 * ("!(handle->flags & UV_HANDLE_CLOSING)"). Only a real subprocess can show
 * that, so this test spawns the built CLI the way a user would.
 *
 * Lives in its own file, apart from headless.e2e.test.ts: that file's
 * CLI-spawn tests are environment-sensitive on Windows, and this check is
 * platform-independent (it reads no config and touches no $HOME), so it must
 * not be quarantined alongside them.
 */
test("--version prints exactly the version on stdout and exits 0", async () => {
  const { stdout, stderr } = await execFileAsync(process.execPath, [distIndex, "--version"], {
    // Generous: over a network/virtual filesystem (\\wsl.localhost, Docker
    // Desktop mounts) resolving this module graph can take most of a minute,
    // and a timeout here would report a false failure, not a real one.
    timeout: 120_000,
  });

  // stdout is the contract: one line, the version, and nothing around it.
  // (`console.log` appends the trailing newline, so trim exactly that.)
  assert.equal(
    stdout,
    `${VERSION}\n`,
    `stdout must be exactly the version, got: ${JSON.stringify(stdout)}`
  );
  assert.match(VERSION, /^\d+\.\d+\.\d+/, "sanity: the version must be semver-shaped");

  // The staleness notice is a courtesy, not part of the contract, and is
  // never printed on a pipe (non-TTY). Other stderr output is still allowed:
  // a dependency probing for an optional native binding prints a warning at
  // import time, and that is not this command's concern. What must never
  // happen is contract output landing on stderr, so assert the version is not
  // duplicated there rather than requiring stderr to be empty.
  assert.doesNotMatch(stderr, new RegExp(VERSION.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("-v is an alias for --version", async () => {
  const { stdout } = await execFileAsync(process.execPath, [distIndex, "-v"], { timeout: 120_000 });
  assert.equal(stdout, `${VERSION}\n`);
});
