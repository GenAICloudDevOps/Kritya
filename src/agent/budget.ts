import type { CliConfig } from "../config/config.js";

/** Default session token budget (prompt + completion, combined across all models/turns). */
export const DEFAULT_TOKEN_BUDGET = 1_000_000;

/** Percent of the budget at which to warn the user, ahead of the hard stop. */
export const BUDGET_WARN_THRESHOLD_PCT = 80;

/** config.tokenBudget wins if set and positive; otherwise DEFAULT_TOKEN_BUDGET. */
export function tokenBudgetFor(config: CliConfig): number {
  return config.tokenBudget && config.tokenBudget > 0 ? config.tokenBudget : DEFAULT_TOKEN_BUDGET;
}

/** True only on the transition from below the threshold to at-or-above it, so the warning fires once per rise. */
export function crossedBudgetWarnThreshold(
  prevPct: number,
  nextPct: number,
  threshold = BUDGET_WARN_THRESHOLD_PCT
): boolean {
  return prevPct < threshold && nextPct >= threshold;
}
