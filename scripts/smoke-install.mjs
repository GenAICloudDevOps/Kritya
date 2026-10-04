#!/usr/bin/env node
// The end-to-end packaging check: pack the tarball, install it the way a user
// would, and run the installed entry point. `check-package.mjs` asserts the
// manifest looks right; this asserts the thing actually starts. Together they
// close the gap where every test passes because tests run against the repo
// tree, while the artifact on npm is broken.
//
// Deliberately heavy — it performs a second full dependency install — which is
// why it gates CI and `npm publish` rather than running on every save.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));

function npm(args, cwd) {
  return execFileSync("npm", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 300_000,
  });
}

/** Run the installed CLI and capture stdout, or throw with stderr attached. */
function runEntry(entry, args) {
  return execFileSync(process.execPath, [entry, ...args], {
    encoding: "utf8",
    timeout: 60_000,
  });
}

let workDir;
try {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), "kritya-smoke-"));

  npm(["pack", "--pack-destination", workDir], repoRoot);
  const tarball = fs.readdirSync(workDir).find((name) => name.endsWith(".tgz"));
  if (!tarball) throw new Error("`npm pack` produced no .tgz");

  fs.writeFileSync(
    path.join(workDir, "package.json"),
    `${JSON.stringify({ name: "kritya-smoke", private: true, version: "1.0.0" }, null, 2)}\n`
  );

  // --ignore-scripts: the goal is to test our packed artifact, not to re-run
  // dependency install scripts that `npm ci` already ran earlier in this job.
  // A registry tarball doesn't run its own `prepare` either, so this matches
  // what a real `npm install -g kritya` does for our own package.
  npm(
    ["install", "--no-save", "--no-audit", "--no-fund", "--ignore-scripts", `./${tarball}`],
    workDir
  );

  const binRel = Object.values(pkg.bin ?? {})[0];
  if (!binRel) throw new Error("package.json declares no bin entry");
  const entry = path.join(workDir, "node_modules", pkg.name, binRel.replace(/^\.\//, ""));
  if (!fs.existsSync(entry)) throw new Error(`packed entry point missing after install: ${entry}`);

  const failures = [];

  const versionOut = runEntry(entry, ["--version"]).trim();
  if (versionOut !== pkg.version) {
    failures.push(
      `\`kritya --version\` printed "${versionOut}" but package.json says "${pkg.version}".`
    );
  }

  // --help exercises the full CLI wiring without needing an API key, so a
  // missing module or a broken import graph surfaces here rather than on a
  // user's first run.
  if (runEntry(entry, ["--help"]).trim() === "") {
    failures.push("`kritya --help` printed nothing.");
  }

  if (failures.length > 0) {
    for (const failure of failures) console.error(`error: ${failure}\n`);
    throw new Error("the installed package does not run correctly");
  }

  console.log(`Smoke OK: installed ${pkg.name}@${versionOut} and ran it from a clean install.`);
} catch (err) {
  console.error(`error: smoke install failed — ${err.message}`);
  const detail = `${err.stderr ?? ""}`.trim();
  if (detail) console.error(detail.split("\n").slice(0, 6).join("\n"));
  console.error(
    "\nIf npm could not run at all, that is an environment problem rather than a packaging\n" +
      "one. Run it from a normal checkout: CI, or WSL on the Linux side. It cannot run\n" +
      "natively on Windows (npm is a .cmd shim there) or over the WSL UNC mount."
  );
  process.exitCode = 1;
} finally {
  if (workDir) {
    try {
      fs.rmSync(workDir, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      // A leftover temp directory is not worth failing the release over.
    }
  }
}
