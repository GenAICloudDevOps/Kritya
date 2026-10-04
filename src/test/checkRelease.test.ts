import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { checkRelease } from "../../scripts/check-release.mjs";

const VERSION = "0.9.0-beta";

interface Fixture {
  version?: string;
  /** `version` at the root of package-lock.json. */
  lockVersion?: string;
  /** `packages[""].version` in package-lock.json. */
  lockRootVersion?: string;
  changelog?: string;
  /** Write no package-lock.json at all. */
  omitLock?: boolean;
  /** Write package.json with this raw text instead of generated JSON. */
  rawPackageJson?: string;
}

/** A minimal but internally consistent repo tree for checkRelease to inspect. */
async function makeRepo(overrides: Fixture = {}): Promise<string> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "kritya-release-"));
  const version = overrides.version ?? VERSION;

  await fsp.writeFile(
    path.join(root, "package.json"),
    overrides.rawPackageJson ?? `${JSON.stringify({ name: "kritya", version }, null, 2)}\n`
  );

  if (!overrides.omitLock) {
    await fsp.writeFile(
      path.join(root, "package-lock.json"),
      `${JSON.stringify(
        {
          name: "kritya",
          version: overrides.lockVersion ?? version,
          packages: {
            "": { name: "kritya", version: overrides.lockRootVersion ?? version },
          },
        },
        null,
        2
      )}\n`
    );
  }

  await fsp.writeFile(
    path.join(root, "CHANGELOG.md"),
    overrides.changelog ??
      `# Changelog\n\n## [${version}] — 2026-10-04\n\n### Added\n\n- something new\n\n` +
        `## [0.8.0-beta] — 2026-09-01\n\n- older\n`
  );

  return root;
}

const run = async (overrides: Fixture = {}, tag = `v${VERSION}`) =>
  checkRelease({ root: await makeRepo(overrides), tag });

test("checkRelease accepts a tag, lock, and changelog that all agree", async () => {
  const result = await run();

  assert.deepEqual(result.failures, []);
  assert.equal(result.version, VERSION);
  assert.equal(result.tag, `v${VERSION}`);
});

test("checkRelease strips a fully-qualified refs/tags/ prefix", async () => {
  const result = await run({}, `refs/tags/v${VERSION}`);

  assert.deepEqual(result.failures, []);
  assert.equal(result.tag, `v${VERSION}`);
});

test("checkRelease rejects a tag that disagrees with package.json", async () => {
  const result = await run({}, "v0.9.1-beta");

  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0], /does not match package\.json version/);
  assert.match(result.failures[0], /0\.9\.1-beta/);
  assert.match(result.failures[0], /0\.9\.0-beta/);
});

test("checkRelease requires a tag rather than guessing one", async () => {
  const result = await run({}, "");

  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0], /No tag to check/);
});

test("checkRelease rejects a stale root lock version", async () => {
  const result = await run({ lockVersion: "0.9.0" });

  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0], /package-lock\.json version is "0\.9\.0"/);
});

test('checkRelease rejects a stale packages[""] lock version', async () => {
  const result = await run({ lockRootVersion: "0.8.26-beta" });

  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0], /packages\[""\]\.version is "0\.8\.26-beta"/);
});

test("checkRelease reports both lock fields when both have drifted", async () => {
  const result = await run({ lockVersion: "0.9.0", lockRootVersion: "0.8.26-beta" });

  assert.equal(result.failures.length, 2);
});

test("checkRelease rejects a missing CHANGELOG heading", async () => {
  const result = await run({
    changelog: `# Changelog\n\n## [0.8.0-beta] — 2026-09-01\n\n- older\n`,
  });

  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0], /has no "## \[0\.9\.0-beta\]" heading/);
});

test("checkRelease tolerates a decorated heading, matching the workflow's awk pattern", async () => {
  // publish.yml matches `^## \[<version>\]` with awk's `~`, a substring match —
  // so a heading carrying a suffix is found there too. Asserted deliberately:
  // if these two ever diverge, the workflow emits blank release notes while
  // this guard stays green, which is the exact failure it exists to prevent.
  const result = await run({
    changelog: `# Changelog\n\n## [${VERSION}] (unreleased)\n\n- something\n`,
  });

  assert.deepEqual(result.failures, []);
});

test("checkRelease rejects a heading for a different version", async () => {
  const result = await run({
    changelog: `# Changelog\n\n## [0.9.0]\n\n- something\n`,
  });

  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0], /has no "## \[0\.9\.0-beta\]" heading/);
});

test("checkRelease rejects an empty CHANGELOG section", async () => {
  const result = await run({
    changelog: `# Changelog\n\n## [${VERSION}] — 2026-10-04\n\n## [0.8.0-beta] — 2026-09-01\n\n- older\n`,
  });

  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0], /section is empty/);
});

test("checkRelease reads a CRLF changelog", async () => {
  const result = await run({
    changelog: `# Changelog\r\n\r\n## [${VERSION}] — 2026-10-04\r\n\r\n### Added\r\n\r\n- something\r\n`,
  });

  assert.deepEqual(result.failures, []);
});

test("checkRelease reports an unparseable package.json instead of throwing", async () => {
  const result = await run({ rawPackageJson: "{ not json" });

  assert.equal(result.version, null);
  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0], /package\.json could not be read or parsed/);
});

test("checkRelease reports a missing package-lock.json instead of throwing", async () => {
  const result = await run({ omitLock: true });

  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0], /package-lock\.json could not be read or parsed/);
});

test("checkRelease collects every problem at once rather than stopping at the first", async () => {
  const result = await run(
    { lockVersion: "0.9.0", changelog: `# Changelog\n\n## [0.8.0-beta]\n\n- older\n` },
    "v0.9.1-beta"
  );

  // tag mismatch + stale lock version + missing heading
  assert.equal(result.failures.length, 3);
});
