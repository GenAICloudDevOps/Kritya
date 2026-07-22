import type { CliConfig } from "./config.js";

/**
 * Default days to keep session transcripts, audit logs, and telemetry
 * before auto-deleting them. Chosen deliberately short: these can carry
 * secrets that passed through tool output, so there's no reason to keep
 * them around by default longer than a couple of work weeks.
 */
export const DEFAULT_RETENTION_DAYS = 15;

/**
 * Resolves the retention window: KRITYA_RETENTION_DAYS env var wins if set,
 * then config.retentionDays, then the 15-day default. 0 or negative means
 * "keep forever" — auto-delete is disabled, not scheduled for "never".
 */
export function retentionDaysFor(config: CliConfig): number {
  const envVal = process.env.KRITYA_RETENTION_DAYS;
  if (envVal !== undefined && envVal.trim() !== "") {
    const n = Number(envVal);
    if (Number.isFinite(n)) return n;
  }
  if (typeof config.retentionDays === "number" && Number.isFinite(config.retentionDays)) {
    return config.retentionDays;
  }
  return DEFAULT_RETENTION_DAYS;
}
