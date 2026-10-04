/**
 * Hand-written declarations for scripts/npmExec.mjs — see
 * check-release.d.mts for why these exist.
 */

export interface NpmLaunch {
  /** Executable to run: node itself, or the npm shim on the fallback path. */
  file: string;
  args: string[];
  /** True only on the Windows fallback, where the shim needs a shell. */
  shell: boolean;
}

export function npmLaunch(args: string[]): NpmLaunch;

/**
 * `execFileSync`, but for npm. The return type is the same union
 * `execFileSync` gives: a string when the caller passed an encoding, a Buffer
 * otherwise.
 */
export function npmExecFile(args: string[], options?: Record<string, unknown>): string | Buffer;

export const NPM_LAUNCH_HINT: string;
