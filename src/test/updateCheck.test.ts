import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  UPDATE_CHECK_DISABLED_ENV,
  checkForUpdate,
  compareVersions,
  isOutdated,
  newestVersion,
  updateNotice,
  updateNoticeForUser,
} from "../update/check.js";

/** A fetch stand-in that resolves to one canned packument. */
function stubFetch(payload: unknown, init: { ok?: boolean; status?: number } = {}) {
  return (async () => ({
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: async () => payload,
  })) as unknown as typeof fetch;
}

const throwingFetch = (async () => {
  throw new Error("getaddrinfo ENOTFOUND");
}) as unknown as typeof fetch;

async function tempCacheFile(): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "kritya-update-"));
  return path.join(dir, "update-check.json");
}

// ---------------------------------------------------------------------------
// Version comparison
// ---------------------------------------------------------------------------

test("compareVersions orders by core version numerically, not lexically", () => {
  assert.equal(compareVersions("0.8.28-beta", "0.8.27-beta"), 1);
  assert.equal(compareVersions("0.8.27-beta", "0.8.28-beta"), -1);
  assert.equal(compareVersions("0.8.27-beta", "0.8.27-beta"), 0);
  // 0.9.0 > 0.8.99 — the trap a string comparison would fall into.
  assert.equal(compareVersions("0.9.0", "0.8.99"), 1);
  assert.equal(compareVersions("1.0.0", "0.99.99"), 1);
});

test("compareVersions ranks a release above its own prereleases", () => {
  assert.equal(compareVersions("0.9.0", "0.9.0-beta"), 1);
  assert.equal(compareVersions("0.9.0-beta", "0.9.0"), -1);
  // But a prerelease still outranks the previous core.
  assert.equal(compareVersions("0.9.0-beta", "0.8.99"), 1);
});

test("compareVersions compares prerelease identifiers per semver", () => {
  // Numeric identifiers rank below alphanumeric ones.
  assert.equal(compareVersions("1.0.0-1", "1.0.0-alpha"), -1);
  assert.equal(compareVersions("1.0.0-alpha", "1.0.0-1"), 1);
  // Numeric identifiers compare as numbers.
  assert.equal(compareVersions("1.0.0-2", "1.0.0-10"), -1);
  // A shorter set of equal identifiers ranks lower.
  assert.equal(compareVersions("1.0.0-alpha", "1.0.0-alpha.1"), -1);
  assert.equal(compareVersions("1.0.0-beta.2", "1.0.0-beta.11"), -1);
});

test("compareVersions tolerates a leading v and surrounding whitespace", () => {
  assert.equal(compareVersions("v0.9.0", "0.9.0"), 0);
  assert.equal(compareVersions(" 0.9.0 ", "0.9.0"), 0);
});

// ---------------------------------------------------------------------------
// newestVersion / isOutdated / updateNotice
// ---------------------------------------------------------------------------

test("newestVersion takes the maximum across every dist-tag", () => {
  // The real shape of this package's tags: `latest` deliberately lags `beta`.
  assert.equal(newestVersion({ beta: "0.8.27-beta", latest: "0.8.26-beta" }), "0.8.27-beta");
  assert.equal(newestVersion({ latest: "0.9.0", beta: "0.8.27-beta" }), "0.9.0");
  assert.equal(newestVersion({ only: "1.2.3" }), "1.2.3");
});

test("newestVersion returns null when there is nothing to compare", () => {
  assert.equal(newestVersion(undefined), null);
  assert.equal(newestVersion({}), null);
  assert.equal(newestVersion({ beta: "" }), null);
});

test("isOutdated only fires for a strictly newer version", () => {
  assert.equal(isOutdated("0.8.27-beta", "0.8.28-beta"), true);
  assert.equal(isOutdated("0.8.27-beta", "0.8.27-beta"), false);
  assert.equal(isOutdated("0.8.27-beta", "0.8.26-beta"), false);
  assert.equal(isOutdated("0.8.27-beta", null), false);
});

test("updateNotice is silent when up to date or when the answer is unknown", () => {
  assert.equal(updateNotice("0.8.27-beta", "0.8.27-beta"), null);
  assert.equal(updateNotice("0.8.27-beta", "0.8.26-beta"), null);
  assert.equal(updateNotice("0.8.27-beta", null), null);
});

test("updateNotice names both versions and the install command when stale", () => {
  const notice = updateNotice("0.8.27-beta", "0.8.28-beta");

  assert.ok(notice);
  assert.match(notice, /0\.8\.27-beta → 0\.8\.28-beta/);
  assert.match(notice, /npm install -g kritya@0\.8\.28-beta/);
});

// ---------------------------------------------------------------------------
// checkForUpdate — registry, caching, and every failure mode
// ---------------------------------------------------------------------------

test("checkForUpdate reads dist-tags from the registry", async () => {
  const status = await checkForUpdate({
    cacheFile: await tempCacheFile(),
    fetchImpl: stubFetch({ "dist-tags": { beta: "0.9.0-beta", latest: "0.8.0" } }),
  });

  assert.equal(status.source, "registry");
  assert.equal(status.latest, "0.9.0-beta");
  assert.equal(status.outdated, true);
});

test("checkForUpdate caches its answer and does not ask twice", async () => {
  const cacheFile = await tempCacheFile();
  let calls = 0;
  const counting = (async () => {
    calls += 1;
    return { ok: true, status: 200, json: async () => ({ "dist-tags": { beta: "0.9.0-beta" } }) };
  }) as unknown as typeof fetch;

  const first = await checkForUpdate({ cacheFile, fetchImpl: counting, now: 1_000 });
  const second = await checkForUpdate({ cacheFile, fetchImpl: counting, now: 2_000 });

  assert.equal(calls, 1);
  assert.equal(first.source, "registry");
  assert.equal(second.source, "cache");
  assert.equal(second.latest, "0.9.0-beta");
});

test("checkForUpdate asks again once the cached answer is a day old", async () => {
  const cacheFile = await tempCacheFile();
  let calls = 0;
  const counting = (async () => {
    calls += 1;
    return { ok: true, status: 200, json: async () => ({ "dist-tags": { beta: "0.9.0-beta" } }) };
  }) as unknown as typeof fetch;

  await checkForUpdate({ cacheFile, fetchImpl: counting, now: 0 });
  // 24h + 1ms later the entry is stale.
  await checkForUpdate({ cacheFile, fetchImpl: counting, now: 24 * 60 * 60 * 1000 + 1 });

  assert.equal(calls, 2);
});

test("checkForUpdate force ignores a fresh cache", async () => {
  const cacheFile = await tempCacheFile();
  let calls = 0;
  const counting = (async () => {
    calls += 1;
    return { ok: true, status: 200, json: async () => ({ "dist-tags": { beta: "0.9.0-beta" } }) };
  }) as unknown as typeof fetch;

  await checkForUpdate({ cacheFile, fetchImpl: counting, now: 1_000 });
  await checkForUpdate({ cacheFile, fetchImpl: counting, now: 1_001, force: true });

  assert.equal(calls, 2);
});

test("checkForUpdate survives an HTTP error without throwing", async () => {
  const status = await checkForUpdate({
    cacheFile: await tempCacheFile(),
    fetchImpl: stubFetch({}, { ok: false, status: 503 }),
  });

  assert.equal(status.source, "unavailable");
  assert.equal(status.outdated, false);
  assert.match(status.reason ?? "", /HTTP 503/);
});

test("checkForUpdate survives an unreachable registry without throwing", async () => {
  const status = await checkForUpdate({
    cacheFile: await tempCacheFile(),
    fetchImpl: throwingFetch,
  });

  assert.equal(status.source, "unavailable");
  assert.match(status.reason ?? "", /ENOTFOUND/);
});

test("checkForUpdate treats a packument with no dist-tags as unavailable", async () => {
  const status = await checkForUpdate({
    cacheFile: await tempCacheFile(),
    fetchImpl: stubFetch({ versions: {} }),
  });

  assert.equal(status.source, "unavailable");
  assert.match(status.reason ?? "", /no dist-tags/);
});

test("checkForUpdate does not cache a failed lookup", async () => {
  const cacheFile = await tempCacheFile();
  await checkForUpdate({ cacheFile, fetchImpl: stubFetch({}, { ok: false, status: 500 }) });

  // A second call must try again rather than serve a cached failure.
  let calls = 0;
  const counting = (async () => {
    calls += 1;
    return { ok: true, status: 200, json: async () => ({ "dist-tags": { beta: "0.9.0-beta" } }) };
  }) as unknown as typeof fetch;
  const second = await checkForUpdate({ cacheFile, fetchImpl: counting });

  assert.equal(calls, 1);
  assert.equal(second.source, "registry");
});

test("checkForUpdate ignores a corrupt cache file rather than failing", async () => {
  const cacheFile = await tempCacheFile();
  await fsp.writeFile(cacheFile, "{ not json");

  const status = await checkForUpdate({
    cacheFile,
    fetchImpl: stubFetch({ "dist-tags": { beta: "0.9.0-beta" } }),
  });

  assert.equal(status.source, "registry");
  assert.equal(status.latest, "0.9.0-beta");
});

test("checkForUpdate is disabled by KRITYA_NO_UPDATE_CHECK and makes no request", async () => {
  const previous = process.env[UPDATE_CHECK_DISABLED_ENV];
  process.env[UPDATE_CHECK_DISABLED_ENV] = "1";
  try {
    let calls = 0;
    const counting = (async () => {
      calls += 1;
      return { ok: true, status: 200, json: async () => ({}) };
    }) as unknown as typeof fetch;

    const status = await checkForUpdate({ cacheFile: await tempCacheFile(), fetchImpl: counting });

    assert.equal(status.source, "disabled");
    assert.equal(status.outdated, false);
    assert.equal(calls, 0);
  } finally {
    if (previous === undefined) delete process.env[UPDATE_CHECK_DISABLED_ENV];
    else process.env[UPDATE_CHECK_DISABLED_ENV] = previous;
  }
});

test("updateNoticeForUser collapses the status into the printable line", async () => {
  const stale = await updateNoticeForUser({
    cacheFile: await tempCacheFile(),
    fetchImpl: stubFetch({ "dist-tags": { beta: "99.0.0" } }),
  });
  assert.match(stale ?? "", /99\.0\.0/);

  const current = await updateNoticeForUser({
    cacheFile: await tempCacheFile(),
    fetchImpl: stubFetch({ "dist-tags": { beta: "0.0.1" } }),
  });
  assert.equal(current, null);
});
