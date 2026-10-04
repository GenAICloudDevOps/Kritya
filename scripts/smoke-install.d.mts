/**
 * Hand-written declarations for scripts/smoke-install.mjs — see
 * check-release.d.mts for why these exist.
 */

export function inspectInstalledRun(
  pkg: { version: string },
  actual: { version: string; help: string }
): string[];
