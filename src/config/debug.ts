/**
 * Most best-effort persistence (session/audit/telemetry writes, config and
 * trust-file reads, hook loading, …) deliberately swallows its own errors —
 * a failed log write must never crash a turn. That's the right default, but
 * it also means those failures are normally invisible even when you're
 * trying to track one down. Set KRITYA_DEBUG=1 to print them to stderr
 * instead of silently dropping them; unset (the default) costs nothing.
 */
export function debugLog(context: string, err: unknown): void {
  if ((process.env.KRITYA_DEBUG ?? "").toLowerCase() !== "1" && process.env.KRITYA_DEBUG !== "true")
    return;
  const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
  try {
    process.stderr.write(`[kritya debug] ${context}: ${message}\n`);
  } catch {
    // stderr itself failing isn't something debug logging can do anything about
  }
}
