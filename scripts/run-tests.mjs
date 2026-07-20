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

const result = spawnSync(process.execPath, ["--test", ...files], {
  stdio: "inherit",
});

process.exit(result.status ?? 1);
