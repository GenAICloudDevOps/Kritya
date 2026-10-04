import assert from "node:assert/strict";
import { test } from "node:test";
import { inspectManifest } from "../../scripts/check-package.mjs";

const PKG = { name: "kritya", version: "0.9.0-beta", bin: { kritya: "dist/index.js" } };

/** A tarball that passes every check, as a base for the failure cases. */
const GOOD_FILES = [
  "package.json",
  "README.md",
  "LICENSE",
  "dist/index.js",
  "dist/agent/loop.js",
  "dist/ui/App.js",
];

const manifest = (files: string[] = GOOD_FILES, unpackedSize = 5_000_000) => ({
  files: files.map((p) => ({ path: p })),
  unpackedSize,
});

test("inspectManifest accepts a complete tarball", () => {
  assert.deepEqual(inspectManifest(PKG, manifest()), []);
});

test("inspectManifest strips npm's package/ path prefix", () => {
  const prefixed = manifest(GOOD_FILES.map((f) => `package/${f}`));

  assert.deepEqual(inspectManifest(PKG, prefixed), []);
});

test("inspectManifest flags a missing entry point", () => {
  const failures = inspectManifest(PKG, manifest(GOOD_FILES.filter((f) => f !== "dist/index.js")));

  assert.ok(failures.some((f) => /"dist\/index\.js" is missing/.test(f)));
  // The bin target is the same file, so that fires too — both are true.
  assert.ok(failures.some((f) => /bin\."kritya" points at/.test(f)));
});

test("inspectManifest flags a bin target that is not in the packed set", () => {
  const pkg = { ...PKG, bin: { kritya: "dist/cli.js" } };

  const failures = inspectManifest(pkg, manifest());

  assert.equal(failures.length, 1);
  assert.match(failures[0], /bin\."kritya" points at "dist\/cli\.js"/);
});

test("inspectManifest flags shipped tests", () => {
  const failures = inspectManifest(PKG, manifest([...GOOD_FILES, "dist/test/loop.test.js"]));

  assert.equal(failures.length, 1);
  assert.match(failures[0], /"dist\/test\/" are packed — tests should not ship/);
});

test("inspectManifest flags leaked source and build tooling", () => {
  const failures = inspectManifest(
    PKG,
    manifest([...GOOD_FILES, "src/index.tsx", "scripts/check-release.mjs"])
  );

  assert.equal(failures.length, 2);
  assert.ok(failures.some((f) => /"src\/"/.test(f)));
  assert.ok(failures.some((f) => /"scripts\/"/.test(f)));
});

test("inspectManifest flags a tarball too small to be the real build", () => {
  const failures = inspectManifest(PKG, manifest(GOOD_FILES, 4_096));

  assert.equal(failures.length, 1);
  assert.match(failures[0], /too small to be the real build/);
});

test("inspectManifest flags an entirely empty pack once, per cause", () => {
  const failures = inspectManifest(PKG, manifest([], 0));

  // Four required files + the bin target + the size floor.
  assert.equal(failures.length, 6);
});

test("inspectManifest tolerates a package with no bin entry", () => {
  const failures = inspectManifest({ name: "kritya" }, manifest());

  assert.deepEqual(failures, []);
});
