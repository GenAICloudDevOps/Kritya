/**
 * Hand-written declarations for scripts/check-release.mjs.
 *
 * The scripts live outside `src`, so tsc never typechecks them (rootDir is
 * "src") — but the test suite in src/test/ imports them, and without this tsc
 * cannot resolve a `.mjs` import and fails the build. The runtime import
 * resolves the real .mjs; only the types come from here.
 */
export interface ReleaseCheckResult {
  /** package.json's version, or null if package.json could not be parsed. */
  version: string | null;
  /** The tag as checked, with any `refs/tags/` prefix stripped. */
  tag: string;
  /** Empty when the release is sound. */
  failures: string[];
}

export function checkRelease(options: { root: string; tag: string }): ReleaseCheckResult;
