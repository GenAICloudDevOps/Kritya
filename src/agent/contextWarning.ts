/** Percent of the context window at which to warn the user, ahead of auto-compaction. */
export const CONTEXT_WARN_THRESHOLD_PCT = 75;

/** True only on the transition from below the threshold to at-or-above it, so the warning fires once per rise. */
export function crossedContextWarnThreshold(
  prevPct: number,
  nextPct: number,
  threshold = CONTEXT_WARN_THRESHOLD_PCT
): boolean {
  return prevPct < threshold && nextPct >= threshold;
}
