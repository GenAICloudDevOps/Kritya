// node --test only gained CLI glob-pattern support in Node 22; on Node 18/20
// (still within engines.node >=18) it treats a glob string as a literal path
// and fails to find it. Enumerate files explicitly so this works identically
// on every supported Node version and OS.
import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

const testDir = path.join(process.cwd(), "dist", "test");

const files = readdirSync(testDir)
  .filter((name) => name.endsWith(".test.js"))
  .map((name) => path.join(testDir, name));

if (files.length === 0) {
  console.error(`No test files found in ${testDir}`);
  process.exit(1);
}

// A cap on how long any single thing node:test is timing can run: without
// this, a hung test (a leaked child process, a promise nobody rejects) burns
// the whole CI job's timeout with zero diagnostic output — the run just gets
// killed with no indication of what was stuck. When multiple files are
// passed on the CLI like this, node:test times each FILE's cumulative
// runtime as one unit (not each individual test() call within it) — so this
// has to clear the slowest file's legitimate total duration, not just its
// slowest single test. 5 minutes comfortably clears that (the whole suite,
// every file combined, normally finishes in ~3.5 minutes) while still
// failing well before CI's 15-minute job timeout and naming what hung.
const result = spawnSync(process.execPath, ["--test", "--test-timeout=300000", ...files], {
  stdio: "inherit",
});

process.exit(result.status ?? 1);
