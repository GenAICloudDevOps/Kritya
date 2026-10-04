#!/usr/bin/env node
// Inspects the artifact users actually download. Every other job in CI runs
// against the checkout, so nothing would notice a broken `files` field, a `bin`
// entry pointing outside the packed set, or a missing runtime asset — the
// tarball would be wrong and every test would still be green.
//
// `npm pack --dry-run --json` makes npm compute the file list itself, rather
// than reimplementing its ignore rules here (which is exactly how the two drift
// apart), and we assert on that manifest.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { npmExecFile, NPM_LAUNCH_HINT } from "./npmExec.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Files the tarball must contain for the package to be installable at all. */
const REQUIRED_FILES = ["package.json", "README.md", "LICENSE", "dist/index.js"];

/**
 * Directories that must never appear in the tarball, with the reason — the
 * reason is printed, so a failure explains itself.
 */
const UNWANTED_PREFIXES = [
  ["dist/test/", "tests should not ship"],
  ["dist/electron/", "the Electron build is excluded on purpose"],
  ["src/", "only compiled output ships"],
  ["scripts/", "build tooling should not ship"],
];

/** A tarball smaller than this is `files` matching nothing, not a real build. */
const MIN_UNPACKED_BYTES = 100_000;

/**
 * Every reason this tarball is wrong, or `[]` if it's sound.
 *
 * Pure — takes the parsed package.json and npm's pack manifest rather than
 * shelling out — so the test suite can feed it fixtures instead of running a
 * real `npm pack`.
 */
export function inspectManifest(pkg, manifest) {
  const failures = [];
  // npm reports paths relative to the package root, but strip a leading
  // "package/" defensively in case that ever changes — a false failure here
  // would be confusing to debug.
  const normalize = (p) => p.replace(/^package\//, "");
  const packed = new Set((manifest.files ?? []).map((file) => normalize(file.path)));

  for (const required of REQUIRED_FILES) {
    if (!packed.has(required)) failures.push(`"${required}" is missing from the tarball.`);
  }

  // A bin target outside the packed set installs a command pointing at a file
  // that was never shipped — the failure only shows up on a user's machine.
  for (const [name, target] of Object.entries(pkg.bin ?? {})) {
    const rel = normalize(target.replace(/^\.\//, ""));
    if (!packed.has(rel)) {
      failures.push(`bin."${name}" points at "${target}", which is not in the tarball.`);
    }
  }

  for (const [prefix, why] of UNWANTED_PREFIXES) {
    const leaked = [...packed].filter((file) => file.startsWith(prefix));
    if (leaked.length > 0) {
      failures.push(
        `${leaked.length} file(s) under "${prefix}" are packed — ${why} (e.g. ${leaked[0]}).`
      );
    }
  }

  // An empty pack means `files` matched nothing. Every check above would also
  // fire, but this states the cause directly.
  if ((manifest.unpackedSize ?? 0) < MIN_UNPACKED_BYTES) {
    failures.push(
      `the tarball unpacks to only ${manifest.unpackedSize} bytes, which is too small to be ` +
        `the real build.`
    );
  }

  return failures;
}

function main() {
  let manifest;
  try {
    const out = npmExecFile(["pack", "--dry-run", "--json"], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    manifest = JSON.parse(out)[0];
  } catch (err) {
    // Means "can't check here", not "the package is broken" — say so plainly
    // instead of dumping a stack trace.
    console.error("error: could not run `npm pack`, so the tarball was not inspected.");
    const detail = `${err.stderr ?? ""}${err.message ?? ""}`.trim();
    if (detail) console.error(detail.split("\n").slice(0, 3).join("\n"));
    console.error(`\nThis is an environment problem, not a packaging one.\n${NPM_LAUNCH_HINT}`);
    process.exit(1);
  }

  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  const failures = inspectManifest(pkg, manifest);

  if (failures.length > 0) {
    for (const failure of failures) console.error(`error: ${failure}\n`);
    console.error("Refusing to continue: the published package would be incomplete.");
    process.exit(1);
  }

  console.log(
    `Package OK: ${manifest.files.length} files, ${manifest.unpackedSize} bytes unpacked, ` +
      `bin target present.`
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
