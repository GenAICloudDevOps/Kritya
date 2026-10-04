#!/usr/bin/env node
// Release guardrail. `publish.yml` publishes whatever `package.json` says,
// under whatever tag was pushed, and never compares the two — so a drifted
// version ships under a tag that disagrees with it, or npm rejects the publish
// outright because that version already exists. The CHANGELOG heading is a
// second silent trap: the workflow extracts the release notes by matching
// `## [<tag minus v>]` with awk, so a heading that doesn't match
// character-for-character produces a GitHub release with an empty body and a
// green check. Both failures are cheap to catch here and expensive to notice
// afterwards, which is why this runs before anything else in the publish job.
//
// Usage: node scripts/check-release.mjs [vX.Y.Z-beta]
// Falls back to $GITHUB_REF_NAME, then to package.json's own version.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(repoRoot, rel), "utf8");

const pkg = JSON.parse(read("package.json"));
const version = pkg.version;
const failures = [];

const rawTag = process.argv[2] ?? process.env.GITHUB_REF_NAME ?? "";
const tag = rawTag.replace(/^refs\/tags\//, "");

if (!tag) {
  failures.push(
    "No tag to check. Pass one (`node scripts/check-release.mjs v0.8.28-beta`) or set " +
      "GITHUB_REF_NAME."
  );
} else if (tag.replace(/^v/, "") !== version) {
  failures.push(
    `tag "${tag}" does not match package.json version "${version}". publish.yml publishes ` +
      `package.json's version, not the tag's, so these must agree — otherwise npm gets a ` +
      `mislabeled release, or fails with a 409 because that version already exists.`
  );
}

// Both lock fields on purpose: `npm ci` does NOT verify them (checked — it exits
// 0 on a mismatch), so a stale lock stays silent until the next `npm install`
// rewrites it into an unrelated diff.
const lock = JSON.parse(read("package-lock.json"));
const lockFields = [
  ["package-lock.json version", lock.version],
  ['package-lock.json packages[""].version', lock.packages?.[""]?.version],
];
for (const [where, found] of lockFields) {
  if (found !== version) {
    failures.push(`${where} is "${found}" but package.json says "${version}".`);
  }
}

// Must match the workflow's awk pattern `^## \[<version>\]` exactly, minus the
// leading v — hence startsWith rather than a regex that tolerates variants.
const heading = `## [${version}]`;
const lines = read("CHANGELOG.md").split("\n");
const start = lines.findIndex((line) => line.startsWith(heading));

if (start === -1) {
  failures.push(
    `CHANGELOG.md has no "${heading}" heading. publish.yml builds the release notes by ` +
      `matching that exactly, so without it the GitHub release is created with an empty body.`
  );
} else {
  const body = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    if (lines[i].startsWith("## [")) break;
    body.push(lines[i]);
  }
  if (body.join("").trim() === "") {
    failures.push(
      `CHANGELOG.md's "${heading}" section is empty — the release notes would be blank.`
    );
  }
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`error: ${failure}\n`);
  console.error("Refusing to continue: this release would ship mismatched, or with empty notes.");
  process.exit(1);
}

console.log(
  `Release checks OK: tag ${tag}, version ${version}, lock in sync, CHANGELOG section present.`
);
