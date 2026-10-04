/**
 * Hand-written declarations for scripts/check-package.mjs and
 * scripts/npmExec.mjs — see check-release.d.mts for why these exist.
 */

/** The subset of npm's `pack --json` output this script relies on. */
export interface PackManifest {
  files: { path: string }[];
  unpackedSize: number;
}

export function inspectManifest(
  /** The parsed package.json — only `bin` is read, but callers pass the whole object. */
  pkg: { bin?: Record<string, string>; [key: string]: unknown },
  manifest: PackManifest
): string[];
