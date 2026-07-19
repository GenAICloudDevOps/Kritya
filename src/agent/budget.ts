import type { CliConfig } from "../config/config.js";
import type { Usage } from "../types.js";

export interface ModelPricing {
  input: number;
  output: number;
  /** Discounted USD/1M rate for prompt tokens served from the provider's cache. */
  cachedInput?: number;
}

/** Estimated cost in USD, pricing cached prompt tokens at cachedInput when configured. */
export function costFor(u: Usage, p: ModelPricing): number {
  const cached = u.cachedPromptTokens ?? 0;
  return (
    ((u.promptTokens - cached) / 1e6) * p.input +
    (cached / 1e6) * (p.cachedInput ?? p.input) +
    (u.completionTokens / 1e6) * p.output
  );
}

/** What cached tokens would have cost at the full input rate, minus what they did cost. */
export function cacheSavingsFor(u: Usage, p: ModelPricing): number {
  if (p.cachedInput === undefined) return 0;
  return ((u.cachedPromptTokens ?? 0) / 1e6) * (p.input - p.cachedInput);
}

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
