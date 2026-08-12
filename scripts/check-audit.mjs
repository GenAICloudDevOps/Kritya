#!/usr/bin/env node
// `npm audit` with a reviewed, expiring allowlist — the gate CI runs instead
// of bare `npm audit --audit-level=high`.
//
// npm has no way to suppress one advisory: the only knob is --audit-level,
// which is all-or-nothing per severity. So an unfixable advisory in a code
// path this project never reaches (see scripts/audit-allowlist.json) forces
// the choice between a permanently red CI and lowering the gate for every
// future high-severity finding too. This keeps the gate at full strength and
// suppresses individual advisories by GHSA id, each with a reason and an
// expiry date so a suppression can't quietly become permanent.
//
// Fails closed: if `npm audit` can't be parsed at all, that's a failure, not
// a pass.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Severities at or above this fail the build unless allowlisted. */
const FAIL_AT = "high";
const SEVERITY_ORDER = ["info", "low", "moderate", "high", "critical"];

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const allowlistPath = path.join(repoRoot, "scripts", "audit-allowlist.json");

function atOrAbove(severity, floor) {
  return SEVERITY_ORDER.indexOf(severity) >= SEVERITY_ORDER.indexOf(floor);
}

/** GHSA id out of an advisory URL, e.g. .../advisories/GHSA-xxxx-yyyy-zzzz. */
function ghsaId(url) {
  return /\/(GHSA-[\w-]+)$/.exec(url ?? "")?.[1];
}

function runAudit() {
  // npm audit exits non-zero whenever it finds anything, so the exit code says
  // nothing about whether the run itself worked — the output is what matters.
  //
  // On Windows `npm` is a .cmd shim, and since Node 20.12 spawning a batch
  // file without `shell` fails outright with EINVAL (the CVE-2024-27980
  // fix). The arguments here are constants, so the shell adds no injection
  // surface.
  const isWindows = process.platform === "win32";
  const result = spawnSync(isWindows ? "npm.cmd" : "npm", ["audit", "--json"], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    shell: isWindows,
  });
  if (result.error) {
    console.error(`Could not run \`npm audit\`: ${result.error.message}`);
    process.exit(1);
  }
  let report;
  try {
    report = JSON.parse(result.stdout);
  } catch {
    console.error(
      `\`npm audit\` did not return JSON — treating that as a failure rather than a pass.\n` +
        `Exit code ${result.status}.\n${result.stderr || result.stdout}`
    );
    process.exit(1);
  }
  // npm reports its own failures (a missing lockfile, a registry it couldn't
  // reach) as well-formed JSON with an `error` key and no findings. Parsing
  // that as "no vulnerabilities" is the one way this gate could go green
  // without having checked anything, so both that and a report missing the
  // expected shape are failures.
  if (report?.error) {
    console.error(
      `\`npm audit\` could not run: ${report.error.summary ?? report.error.code ?? "unknown error"}\n` +
        `${report.error.detail ?? ""}`
    );
    process.exit(1);
  }
  if (!report?.auditReportVersion || typeof report.vulnerabilities !== "object") {
    console.error(
      `\`npm audit\` returned JSON in an unrecognized shape — refusing to report a pass ` +
        `from a report this script can't read.\n${result.stdout.slice(0, 500)}`
    );
    process.exit(1);
  }
  return report;
}

/**
 * Every distinct advisory in the report, keyed by GHSA id.
 *
 * A package's `via` holds either advisory objects (the advisory itself) or
 * plain package-name strings (this package is only affected *through* that
 * one). Collapsing to the advisories means a package that is transitively
 * affected needs no separate allowlist entry — suppressing the root advisory
 * covers everything downstream of it, which is the same thing npm's own
 * "fix available" tree is describing.
 */
function collectAdvisories(report) {
  const advisories = new Map();
  for (const vuln of Object.values(report.vulnerabilities ?? {})) {
    for (const via of vuln.via ?? []) {
      if (typeof via === "string") continue;
      const id = ghsaId(via.url);
      if (!id || advisories.has(id)) continue;
      advisories.set(id, {
        id,
        severity: via.severity,
        title: via.title,
        url: via.url,
        package: via.name,
      });
    }
  }
  return [...advisories.values()].sort((a, b) => a.id.localeCompare(b.id));
}

const allowlist = JSON.parse(fs.readFileSync(allowlistPath, "utf8"));
const allowed = new Map((allowlist.allow ?? []).map((entry) => [entry.id, entry]));

const advisories = collectAdvisories(runAudit());
const gating = advisories.filter((a) => atOrAbove(a.severity, FAIL_AT));

console.log(`Advisories at or above "${FAIL_AT}": ${gating.length}`);
for (const a of gating) {
  console.log(`  ${allowed.has(a.id) ? "✓ suppressed" : "✗ blocking"} ${a.id} — ${a.title}`);
}

const unapproved = gating.filter((a) => !allowed.has(a.id));
if (unapproved.length > 0) {
  console.error(
    `\n${unapproved.length} advisory(ies) at "${FAIL_AT}" or above are not allowlisted:\n` +
      unapproved.map((a) => `  - ${a.id} (${a.package}, ${a.severity}) ${a.url}`).join("\n") +
      `\n\nUpgrade the dependency if a patched version exists. Only add an entry to ` +
      `scripts/audit-allowlist.json when there is no fix available AND the vulnerable ` +
      `code path is genuinely unreachable from this project — record why, and set an ` +
      `expiry so it gets looked at again.`
  );
  process.exit(1);
}

// An entry that has outlived its expiry is a failure in its own right: the
// point of the date is to force a re-check, and a suppression nobody revisits
// is indistinguishable from having lowered the gate permanently.
const today = new Date().toISOString().slice(0, 10);
const expired = [...allowed.values()].filter((entry) => entry.expires && entry.expires < today);
if (expired.length > 0) {
  console.error(
    `\n${expired.length} allowlist entry(ies) in scripts/audit-allowlist.json have expired:\n` +
      expired.map((e) => `  - ${e.id} (expired ${e.expires})`).join("\n") +
      `\n\nRe-check whether a patched version has shipped since. If one has, upgrade and ` +
      `delete the entry; if not, confirm the reasoning still holds and extend the date.`
  );
  process.exit(1);
}

// A suppression for something the report no longer mentions has done its job —
// worth saying so, since that's the cue to delete it. Not a failure: the fix
// may have landed in a lockfile update nobody has connected to this file yet.
const stale = [...allowed.keys()].filter((id) => !advisories.some((a) => a.id === id));
for (const id of stale) {
  console.log(`\nNote: ${id} is allowlisted but no longer reported — the entry can be removed.`);
}

console.log(
  gating.length > 0
    ? `\nNo unapproved advisories at "${FAIL_AT}" or above.`
    : `\nNo advisories at "${FAIL_AT}" or above.`
);
