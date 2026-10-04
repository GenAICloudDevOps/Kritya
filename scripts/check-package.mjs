#!/usr/bin/env node
// Inspects the artifact users actually download. Every other job in CI runs
// against the checkout, so nothing would notice a broken `files` field, a `bin`
// entry pointing outside the packed set, or a missing runtime asset — the
// tarball would be wrong and every test would still be green.
//
// `npm pack --dry-run --json` makes npm compute the file list itself, rather
// than reimplementing its ignore rules here (which is exactly how the two drift
// apart), and we assert on that manifest.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let manifest;
try {
  const out = execFileSync("npm", ["pack", "--dry-run", "--json"], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  manifest = JSON.parse(out)[0];
} catch (err) {
  // Two environments where npm itself cannot run. Over the WSL UNC mount npm
  // rewrites package.json's path to \\wsl.localhost\Ubuntu\Ubuntu\... and gets
  // ENOENT; natively on Windows npm is an npm.cmd shim, which execFileSync
  // can't launch without a shell. Both mean "can't check here", not "the
  // package is broken", so say so plainly instead of dumping a stack trace.
  console.error("error: could not run `npm pack`, so the tarball was not inspected.");
  const detail = `${err.stderr ?? ""}${err.message ?? ""}`.trim();
  if (detail) console.error(detail.split("\n").slice(0, 3).join("\n"));
  console.error(
    "\nThis is an environment problem, not a packaging one. Run it from a normal checkout:\n" +
      "CI, or WSL on the Linux side. It cannot run natively on Windows (npm is a .cmd shim\n" +
      "there) or over the WSL UNC mount."
  );
  process.exit(1);
}

const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));

// npm reports paths relative to the package root, but strip a leading
// "package/" defensively in case that ever changes — a false failure here would
// be confusing to debug.
const normalize = (p) => p.replace(/^package\//, "");
const packed = new Set(manifest.files.map((file) => normalize(file.path)));
const failures = [];

for (const required of ["package.json", "README.md", "LICENSE", "dist/index.js"]) {
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

const unwanted = [
  ["dist/test/", "tests should not ship"],
  ["dist/electron/", "the Electron build is excluded on purpose"],
  ["src/", "only compiled output ships"],
  ["scripts/", "build tooling should not ship"],
];
for (const [prefix, why] of unwanted) {
  const leaked = [...packed].filter((file) => file.startsWith(prefix));
  if (leaked.length > 0) {
    failures.push(
      `${leaked.length} file(s) under "${prefix}" are packed — ${why} (e.g. ${leaked[0]}).`
    );
  }
}

// An empty pack means `files` matched nothing. Every check above would also
// fire, but this states the cause directly.
if (manifest.unpackedSize < 100_000) {
  failures.push(
    `the tarball unpacks to only ${manifest.unpackedSize} bytes, which is too small to be ` +
      `the real build.`
  );
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`error: ${failure}\n`);
  console.error("Refusing to continue: the published package would be incomplete.");
  process.exit(1);
}

console.log(
  `Package OK: ${manifest.files.length} files, ${manifest.unpackedSize} bytes unpacked, ` +
    `bin target present.`
);
