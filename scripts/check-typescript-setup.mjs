#!/usr/bin/env node
// Guard for the dual-TypeScript setup. The package *named* "typescript" is
// not the real TypeScript compiler: it is an npm alias for TypeScript 6
// (npm:@typescript/typescript6), kept because typescript-eslint still needs
// the TS6 compiler API. The real compiler, TypeScript 7, is installed under
// "@typescript/native" as an alias for the "typescript" package. This looks
// like a mistake, so someone (or Dependabot) will eventually try to
// "clean it up" — a plain "typescript": "^7.x" breaks eslint, and a plain
// "^6.x" breaks the build. This check fails CI loudly if either alias is
// ever replaced with a plain version range. See CONTRIBUTING.md ("Why are
// there two TypeScript packages?").
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
const devDeps = pkg.devDependencies ?? {};

const failures = [];

const ts = devDeps["typescript"] ?? "";
if (!ts.startsWith("npm:@typescript/typescript6@")) {
  failures.push(
    `devDependencies.typescript is "${ts}" — it must stay an alias like "npm:@typescript/typescript6@^6.0.2". ` +
      `The name "typescript" is intentionally TypeScript 6: typescript-eslint needs the TS6 compiler API, ` +
      `so the real TS7 compiler lives under "@typescript/native". Do not "simplify" this entry.`
  );
}

const native = devDeps["@typescript/native"] ?? "";
if (!native.startsWith("npm:typescript@")) {
  failures.push(
    `devDependencies["@typescript/native"] is "${native}" — it must stay an alias like "npm:typescript@^7.0.2". ` +
      `This is how the real TypeScript 7 compiler is installed; without the alias the build uses the wrong compiler.`
  );
}

if (failures.length > 0) {
  for (const f of failures) console.error(`error: ${f}\n`);
  console.error("Refusing to continue: the dual-TypeScript setup is broken. See CONTRIBUTING.md.");
  process.exit(1);
}

console.log(`TypeScript setup OK: typescript -> ${ts}, @typescript/native -> ${native}`);
