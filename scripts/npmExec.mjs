// Launching npm from a Node script, portably.
//
// `execFileSync("npm", ...)` only works where npm is a real executable. On
// Windows npm is an `npm.cmd` shim, and Node refuses to execFile a .cmd/.bat
// without a shell (documented behaviour, not a bug) — so the same call that
// works on Linux/macOS throws ENOENT there. Falling back to `shell: true` is
// not a good fix on its own: it requires shell-quoting every argument, and the
// paths involved here (temp dirs under the user's home) can contain spaces.
//
// The portable form is to run npm's own JS entry point with the current Node
// binary — no shell, no quoting, identical on every OS. `npm_execpath` is set
// by npm itself whenever we're invoked through an npm script, which is how
// both CI and `prepublishOnly` reach these checks.
import { execFileSync } from "node:child_process";
import fs from "node:fs";

/**
 * How to invoke npm, as a command line. Pure — no process is spawned — so the
 * choice itself is unit-testable on every platform.
 */
export function npmLaunch(args) {
  const cli = process.env.npm_execpath;
  if (cli && fs.existsSync(cli)) {
    return { file: process.execPath, args: [cli, ...args], shell: false };
  }
  // Reached only when these scripts are run directly (`node scripts/…`) rather
  // than through an npm script, so there's no npm_execpath to use. The PATH
  // shim is the only option left, and on Windows it needs a shell — which
  // means arguments are joined unquoted, so this path is best-effort.
  return { file: "npm", args, shell: process.platform === "win32" };
}

/**
 * `execFileSync`, but for npm. Throws the same way, so callers keep their
 * existing error handling.
 */
export function npmExecFile(args, options = {}) {
  const launch = npmLaunch(args);
  return execFileSync(launch.file, launch.args, { ...options, shell: launch.shell });
}

/** What to tell someone whose environment can't run npm at all. */
export const NPM_LAUNCH_HINT =
  "Run it from a normal checkout: CI, or WSL on the Linux side. It cannot run over\n" +
  "the WSL UNC mount (npm mangles the package path there), and running it directly\n" +
  "on Windows needs npm on PATH — invoke it via `npm run …` instead.";
