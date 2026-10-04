import fs from "node:fs";
import path from "node:path";
import { CONFIG_DIR } from "../config/config.js";
import { debugLog } from "../config/debug.js";
import { writeFileAtomicSync } from "../atomicWrite.js";
import { VERSION } from "../version.js";

/**
 * "Is a newer kritya out?" — a courtesy notice, so every path here is
 * best-effort by design: it never throws, never blocks for long, and never
 * runs when it would be in the way (see `updateCheckDisabled` and the TTY gate
 * at the call sites). A version check that can break `kritya --version` or
 * stall startup would be a worse bug than the staleness it reports.
 */
export const UPDATE_CHECK_DISABLED_ENV = "KRITYA_NO_UPDATE_CHECK";

const CACHE_FILE = path.join(CONFIG_DIR, "update-check.json");
/** How long a cached answer stays good. One registry hit per day, per machine. */
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
/** Kept short: this is a nicety, and it sits in front of a user's shell prompt. */
const REQUEST_TIMEOUT_MS = 2_000;
const REGISTRY_URL = "https://registry.npmjs.org/kritya";
/** npm's abbreviated packument — a fraction of the full document's size. */
const PACKUMENT_ACCEPT = "application/vnd.npm.install-v1+json";

export function updateCheckDisabled(): boolean {
  const value = process.env[UPDATE_CHECK_DISABLED_ENV];
  return value !== undefined && /^(1|true|yes|on)$/i.test(value.trim());
}

/**
 * Semver precedence: -1 if a < b, 0 if equal, 1 if a > b.
 *
 * Hand-rolled rather than pulled from a dependency because the only shapes
 * this ever sees are our own release tags (`0.8.27-beta`), and a full semver
 * implementation would be more code than it saves. Follows §11 where it
 * matters: a release outranks any prerelease of the same core, and numeric
 * prerelease identifiers rank below alphanumeric ones.
 */
export function compareVersions(a: string, b: string): number {
  const parse = (value: string) => {
    const [core, ...rest] = value.trim().replace(/^v/, "").split("-");
    return { nums: core.split(".").map((n) => Number(n) || 0), pre: rest.join("-") };
  };
  const left = parse(a);
  const right = parse(b);

  for (let i = 0; i < 3; i += 1) {
    const x = left.nums[i] ?? 0;
    const y = right.nums[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }

  if (left.pre === right.pre) return 0;
  if (!left.pre) return 1;
  if (!right.pre) return -1;

  const li = left.pre.split(".");
  const ri = right.pre.split(".");
  for (let i = 0; i < Math.max(li.length, ri.length); i += 1) {
    const x = li[i];
    const y = ri[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xNum = /^\d+$/.test(x);
    const yNum = /^\d+$/.test(y);
    if (xNum && yNum) {
      const dx = Number(x);
      const dy = Number(y);
      if (dx !== dy) return dx < dy ? -1 : 1;
    } else if (xNum !== yNum) {
      return xNum ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

/**
 * The newest version across a packument's dist-tags.
 *
 * Deliberately the maximum of *all* tags rather than a single channel: this
 * package currently only publishes prereleases under `beta`, while `latest`
 * lags behind by design (it is moved by hand — see publish.yml). Reading only
 * `latest` would mean the notice never fires for the people actually running
 * betas.
 */
export function newestVersion(distTags: Record<string, string> | undefined): string | null {
  let newest: string | null = null;
  for (const version of Object.values(distTags ?? {})) {
    if (typeof version !== "string" || !version) continue;
    if (!newest || compareVersions(version, newest) > 0) newest = version;
  }
  return newest;
}

export function isOutdated(current: string, latest: string | null): boolean {
  return latest !== null && compareVersions(latest, current) > 0;
}

/** The user-facing notice, or null when there's nothing worth saying. */
export function updateNotice(current: string, latest: string | null): string | null {
  if (!isOutdated(current, latest)) return null;
  return (
    `A newer version of kritya is available: ${current} → ${latest}\n` +
    `  npm install -g kritya@${latest}`
  );
}

export type UpdateCheckSource = "cache" | "registry" | "disabled" | "unavailable";

export interface UpdateStatus {
  current: string;
  /** Newest published version, or null when the answer is unknown. */
  latest: string | null;
  outdated: boolean;
  /** How this answer was reached — `doctor` reports it, so it can't be silently stale. */
  source: UpdateCheckSource;
  /** Why no answer was available, when `source` is "unavailable". */
  reason?: string;
}

export interface UpdateCheckOptions {
  /** Override the cache location (tests). */
  cacheFile?: string;
  /** Injected for tests. */
  fetchImpl?: typeof fetch;
  /** Fixed "now" in ms, for TTL tests. */
  now?: number;
  /** Ignore a cached result and ask the registry. */
  force?: boolean;
}

interface CacheEntry {
  checkedAt: number;
  latest: string;
}

function readCache(file: string): CacheEntry | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<CacheEntry>;
    if (typeof parsed.checkedAt !== "number" || typeof parsed.latest !== "string") return null;
    return { checkedAt: parsed.checkedAt, latest: parsed.latest };
  } catch (err) {
    // Missing on first run, or corrupt — either way, just check the registry.
    debugLog(`readUpdateCache(${file})`, err);
    return null;
  }
}

function writeCache(file: string, entry: CacheEntry): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    writeFileAtomicSync(file, `${JSON.stringify(entry, null, 2)}\n`, { mode: 0o600 });
  } catch (err) {
    // Not being able to remember the answer only costs one extra request.
    debugLog(`writeUpdateCache(${file})`, err);
  }
}

/**
 * Resolve whether a newer version exists. Never rejects.
 *
 * A cached answer younger than the TTL is returned as-is; otherwise the
 * registry is asked with a hard 2s timeout and the result is cached. Any
 * failure resolves to `source: "unavailable"` — being offline is not an error
 * worth showing anyone.
 */
export async function checkForUpdate(options: UpdateCheckOptions = {}): Promise<UpdateStatus> {
  const current = VERSION;
  if (updateCheckDisabled()) {
    return { current, latest: null, outdated: false, source: "disabled" };
  }

  const now = options.now ?? Date.now();
  const cacheFile = options.cacheFile ?? CACHE_FILE;

  if (!options.force) {
    const cached = readCache(cacheFile);
    if (cached && now - cached.checkedAt < CACHE_TTL_MS) {
      return {
        current,
        latest: cached.latest,
        outdated: isOutdated(current, cached.latest),
        source: "cache",
      };
    }
  }

  try {
    const fetchImpl = options.fetchImpl ?? fetch;
    const response = await fetchImpl(REGISTRY_URL, {
      headers: { accept: PACKUMENT_ACCEPT },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`registry returned HTTP ${response.status}`);
    const doc = (await response.json()) as { "dist-tags"?: Record<string, string> };
    const latest = newestVersion(doc["dist-tags"]);
    if (!latest) throw new Error("registry response contained no dist-tags");

    writeCache(cacheFile, { checkedAt: now, latest });
    return { current, latest, outdated: isOutdated(current, latest), source: "registry" };
  } catch (err) {
    debugLog(`checkForUpdate(${REGISTRY_URL})`, err);
    return {
      current,
      latest: null,
      outdated: false,
      source: "unavailable",
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

/** The notice to print for a user, or null. Never throws. */
export async function updateNoticeForUser(
  options: UpdateCheckOptions = {}
): Promise<string | null> {
  const status = await checkForUpdate(options);
  return updateNotice(status.current, status.latest);
}
