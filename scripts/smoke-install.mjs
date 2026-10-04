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
import { npmExecFile, NPM_LAUNCH_HINT } from "./npmExec.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Every reason the installed CLI misbehaved, or `[]` if it's fine.
 *
 * Split out from the npm work so the assertions themselves are testable
 * without a registry round-trip.
 */
export function inspectInstalledRun(pkg, { version, help }) {
  const failures = [];
  if (version !== pkg.version) {
    failures.push(
      `\`kritya --version\` printed "${version}" but package.json says "${pkg.version}".`
    );
  }
  // --help exercises the full CLI wiring without needing an API key, so a
  // missing module or a broken import graph surfaces here rather than on a
  // user's first run.
  if (help.trim() === "") failures.push("`kritya --help` printed nothing.");
  return failures;
}

/** Run the installed CLI and capture stdout, or throw with stderr attached. */
function runEntry(entry, args) {
  return execFileSync(process.execPath, [entry, ...args], {
    encoding: "utf8",
    timeout: 60_000,
  });
}

function main() {
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  let workDir;

  try {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), "kritya-smoke-"));

    npmExecFile(["pack", "--pack-destination", workDir], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 300_000,
    });
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
    npmExecFile(
      ["install", "--no-save", "--no-audit", "--no-fund", "--ignore-scripts", `./${tarball}`],
      {
        cwd: workDir,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 300_000,
      }
    );

    const binRel = Object.values(pkg.bin ?? {})[0];
    if (!binRel) throw new Error("package.json declares no bin entry");
    const entry = path.join(workDir, "node_modules", pkg.name, binRel.replace(/^\.\//, ""));
    if (!fs.existsSync(entry))
      throw new Error(`packed entry point missing after install: ${entry}`);

    const failures = inspectInstalledRun(pkg, {
      version: runEntry(entry, ["--version"]).trim(),
      help: runEntry(entry, ["--help"]),
    });

    if (failures.length > 0) {
      for (const failure of failures) console.error(`error: ${failure}\n`);
      throw new Error("the installed package does not run correctly");
    }

    console.log(`Smoke OK: installed ${pkg.name}@${pkg.version} and ran it from a clean install.`);
  } catch (err) {
    console.error(`error: smoke install failed — ${err.message}`);
    const detail = `${err.stderr ?? ""}`.trim();
    if (detail) console.error(detail.split("\n").slice(0, 6).join("\n"));
    console.error(`\n${NPM_LAUNCH_HINT}`);
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
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
