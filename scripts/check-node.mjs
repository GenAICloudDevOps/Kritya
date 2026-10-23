#!/usr/bin/env node
// Asserts the running Node satisfies `engines.node` in package.json.
//
// npm only *warns* (EBADENGINE) when a package's engines field isn't met, so a
// CI runner or a laptop can sit on an older Node with the install still green.
// That matters more than usual here: `engines.node` is a security floor, not a
// language-feature floor. Node's bundled Brotli decoder carried an
// out-of-bounds write reachable from any Brotli response kritya decompresses
// (CVE-2026-111497, via fetch_url and the provider client), and the fix only
// exists in 22.23.4 / 24.22.1 / 26.12.1 and later — which is why the floor was
// raised from 22.19.0.
//
// A single `>=` floor cannot express that per-line requirement (24.0.0-24.22.0
// and 26.0.0-26.12.0 are also affected but compare greater than 22.23.4), so
// this check enforces the floor and SECURITY.md documents the per-line
// versions. Run it wherever a build could be trusted: CI, and before publish.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));

const required = pkg.engines?.node;
if (!required) {
  console.error("error: package.json has no engines.node — nothing to check against.");
  process.exit(1);
}

// Only the `>=X.Y.Z` and bare `X.Y.Z` forms are supported, which is all this
// package has ever used. Anything else fails loudly rather than silently
// passing: a range this script can't read is a check that isn't running.
const minimum = required.replace(/^>=\s*/, "");
if (!/^\d+\.\d+\.\d+$/.test(minimum)) {
  console.error(
    `error: engines.node is "${required}" — this check only understands ">=X.Y.Z" or "X.Y.Z".`
  );
  process.exit(1);
}

const parse = (v) => v.split(".").map(Number);
const [reqMajor, reqMinor, reqPatch] = parse(minimum);
const [major, minor, patch] = parse(process.versions.node);

const tooOld =
  major < reqMajor ||
  (major === reqMajor && (minor < reqMinor || (minor === reqMinor && patch < reqPatch)));

if (tooOld) {
  console.error(
    `error: running Node ${process.versions.node}, but this package requires >=${minimum}.\n\n` +
      `engines.node is a security floor: the Brotli decoder fix (CVE-2026-111497) ships in\n` +
      `22.23.4 / 24.22.1 / 26.12.1. Upgrade before building or publishing. See SECURITY.md.\n`
  );
  process.exit(1);
}

console.log(`Node setup OK: ${process.versions.node} satisfies engines.node ${required}`);
