#!/usr/bin/env node
// Socket.dev-style dependency risk check, done locally with no external
// service or API key: kritya pulls in file-parsing packages (pdf-lib,
// mammoth, jszip, pdfjs-dist) that are common targets for a compromised
// transitive dependency, and an npm lifecycle script (preinstall/install/
// postinstall) is the standard way a malicious package executes code the
// moment `npm ci` runs — before any of kritya's own code, tests, or review
// even sees it. This walks the installed tree after `npm ci` and fails CI if
// any package (direct or transitive) not in the allowlist declares one.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const LIFECYCLE_SCRIPTS = ["preinstall", "install", "postinstall"];
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const allowlistPath = path.join(repoRoot, "scripts", "install-script-allowlist.json");
const nodeModules = path.join(repoRoot, "node_modules");

function readPackageJson(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
  } catch {
    return null;
  }
}

function findInstallScripts() {
  const allow = new Set(JSON.parse(fs.readFileSync(allowlistPath, "utf8")).allow);
  const found = [];
  const entries = fs.existsSync(nodeModules) ? fs.readdirSync(nodeModules) : [];
  for (const entry of entries) {
    if (entry.startsWith(".")) continue;
    const dirs =
      entry.startsWith("@") && fs.statSync(path.join(nodeModules, entry)).isDirectory()
        ? fs
            .readdirSync(path.join(nodeModules, entry))
            .map((scoped) => path.join(nodeModules, entry, scoped))
        : [path.join(nodeModules, entry)];
    for (const dir of dirs) {
      const pkg = readPackageJson(dir);
      if (!pkg?.scripts) continue;
      const scripts = LIFECYCLE_SCRIPTS.filter((k) => pkg.scripts[k]);
      if (scripts.length === 0) continue;
      found.push({ name: pkg.name, version: pkg.version, scripts, allowed: allow.has(pkg.name) });
    }
  }
  return found.sort((a, b) => a.name.localeCompare(b.name));
}

const found = findInstallScripts();
const unapproved = found.filter((p) => !p.allowed);

console.log(`Packages with npm lifecycle scripts: ${found.length}`);
for (const p of found) {
  console.log(`  ${p.allowed ? "✓" : "✗"} ${p.name}@${p.version} [${p.scripts.join(", ")}]`);
}

if (unapproved.length > 0) {
  console.error(
    `\n${unapproved.length} package(s) run install-time scripts and are not in ` +
      `scripts/install-script-allowlist.json:\n` +
      unapproved.map((p) => `  - ${p.name}@${p.version}`).join("\n") +
      `\n\nReview what the script does before adding the package name to the allowlist. ` +
      `This is a supply-chain gate, not a lint rule — don't add an entry without reading the script.`
  );
  process.exit(1);
}

console.log("\nAll packages with lifecycle scripts are on the allowlist.");
