#!/usr/bin/env node
// Asserts the running Node is a patched release for CVE-2026-111497.
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
// `engines.node` (`>=22.23.4`) can only state the lowest of those, so this
// check enforces the per-line minimums itself: 24.0.0-24.22.0 and
// 26.0.0-26.12.0 are also affected but compare greater than 22.23.4, and the
// end-of-life lines between them (23, 25) never received a fix at all. A line
// newer than 26 postdates the fix and is accepted. Run it wherever a build
// could be trusted: CI, and before publish. Kept in step with
// `nodeSecurityProblem` in src/commands/doctor.ts.
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

// The engines floor stays in package.json as the coarse npm signal; if it is
// ever written in a form this script doesn't expect, fail loudly rather than
// silently passing: a range this script can't read is a check that isn't
// running.
const minimum = required.replace(/^>=\s*/, "");
if (!/^\d+\.\d+\.\d+$/.test(minimum)) {
  console.error(
    `error: engines.node is "${required}" — this check only understands ">=X.Y.Z" or "X.Y.Z".`
  );
  process.exit(1);
}

const PATCHED_MINIMUMS = { 22: "22.23.4", 24: "24.22.1", 26: "26.12.1" };

const compare = (a, b) => {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
};

const actual = process.versions.node;
const [major] = actual.split(".").map(Number);
const lines = Object.keys(PATCHED_MINIMUMS)
  .map(Number)
  .sort((a, b) => a - b);
const lineMinimum = PATCHED_MINIMUMS[major];

let problem = null;
if (compare(actual, minimum) < 0) {
  problem = `running Node ${actual}, but this package requires ${required}.`;
} else if (lineMinimum && compare(actual, lineMinimum) < 0) {
  problem =
    `running Node ${actual}, but Node ${major}.x requires >=${lineMinimum} — ` +
    `the engines floor (${required}) cannot express the per-line patched releases.`;
} else if (!lineMinimum && major < lines[lines.length - 1]) {
  problem =
    `running Node ${actual} — Node ${major}.x is end-of-life and has no release ` +
    `with the Brotli decoder fix; use a supported line.`;
}

if (problem) {
  console.error(
    `error: ${problem}\n\n` +
      `engines.node is a security floor: the Brotli decoder fix (CVE-2026-111497) ships in\n` +
      `22.23.4 / 24.22.1 / 26.12.1. Upgrade before building or publishing. See SECURITY.md.\n`
  );
  process.exit(1);
}

console.log(`Node setup OK: ${actual} is a patched release (22.23.4 / 24.22.1 / 26.12.1 per line)`);
