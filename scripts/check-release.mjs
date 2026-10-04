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
// Falls back to $GITHUB_REF_NAME, then fails — there is no safe guess for
// "which tag is this release for".
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Every reason this release would be wrong, or `[]` if it's sound.
 *
 * Pure and root-injectable so the test suite can point it at a fixture tree
 * rather than the real repo — the guardrail that protects releases is itself
 * worth testing, and it can only be tested if the root isn't baked in.
 */
export function checkRelease({ root, tag }) {
  const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");
  const failures = [];
  // Git passes a fully-qualified ref to some tools; accept either spelling.
  const cleanTag = (tag ?? "").replace(/^refs\/tags\//, "");

  let pkg;
  try {
    pkg = JSON.parse(read("package.json"));
  } catch (err) {
    // Unparseable rather than merely wrong — say so instead of throwing a
    // stack trace at whoever is trying to cut a release.
    return {
      version: null,
      tag: cleanTag,
      failures: [`package.json could not be read or parsed: ${err.message}`],
    };
  }
  const version = pkg.version;

  if (!cleanTag) {
    failures.push(
      "No tag to check. Pass one (`node scripts/check-release.mjs v0.8.28-beta`) or set " +
        "GITHUB_REF_NAME."
    );
  } else if (cleanTag.replace(/^v/, "") !== version) {
    failures.push(
      `tag "${cleanTag}" does not match package.json version "${version}". publish.yml publishes ` +
        `package.json's version, not the tag's, so these must agree — otherwise npm gets a ` +
        `mislabeled release, or fails with a 409 because that version already exists.`
    );
  }

  // Both lock fields on purpose: `npm ci` does NOT verify them (checked — it
  // exits 0 on a mismatch), so a stale lock stays silent until the next
  // `npm install` rewrites it into an unrelated diff.
  let lock;
  try {
    lock = JSON.parse(read("package-lock.json"));
  } catch (err) {
    failures.push(`package-lock.json could not be read or parsed: ${err.message}`);
    lock = null;
  }
  if (lock) {
    const lockFields = [
      ["package-lock.json version", lock.version],
      ['package-lock.json packages[""].version', lock.packages?.[""]?.version],
    ];
    for (const [where, found] of lockFields) {
      if (found !== version) {
        failures.push(`${where} is "${found}" but package.json says "${version}".`);
      }
    }
  }

  // Must match the workflow's awk pattern `^## \[<version>\]` exactly, minus
  // the leading v — hence startsWith rather than a regex that tolerates
  // variants. Split on /\r?\n/ rather than "\n": a CRLF checkout (Windows
  // without the .gitattributes rule) would otherwise leave "\r" inside every
  // heading and the awk pattern would never match.
  const heading = `## [${version}]`;
  let lines;
  try {
    lines = read("CHANGELOG.md").split(/\r?\n/);
  } catch (err) {
    failures.push(`CHANGELOG.md could not be read: ${err.message}`);
    lines = [];
  }
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

  return { version, tag: cleanTag, failures };
}

function main() {
  const tag = process.argv[2] ?? process.env.GITHUB_REF_NAME ?? "";
  const checked = checkRelease({ root: repoRoot, tag });
  const { version, failures } = checked;

  if (failures.length > 0) {
    for (const failure of failures) console.error(`error: ${failure}\n`);
    console.error("Refusing to continue: this release would ship mismatched, or with empty notes.");
    process.exit(1);
  }

  console.log(
    `Release checks OK: tag ${checked.tag}, version ${version}, lock in sync, CHANGELOG section present.`
  );
}

// Only run when invoked as a script — the test suite imports checkRelease from
// here, and must not trigger the CLI (or its process.exit) on import.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
