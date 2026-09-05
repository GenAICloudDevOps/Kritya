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

/**
 * For best-effort persistence that a user actually needs to know failed
 * (session/audit/telemetry writes) — unlike debugLog, this always prints a
 * short one-line warning to stderr, not just under KRITYA_DEBUG. The full
 * stack trace still only shows up under KRITYA_DEBUG, via the debugLog call
 * this makes internally.
 */
/**
 * Contexts already warned about via warnUser() this process. Some of these
 * (a telemetry sink retried every span, an append() called every turn) would
 * otherwise print the same warning on every single failure — once per
 * context is enough to tell the user something is wrong without flooding
 * the terminal.
 */
const warnedContexts = new Set<string>();

export function warnUser(context: string, err: unknown): void {
  if (warnedContexts.has(context)) {
    debugLog(context, err);
    return;
  }
  warnedContexts.add(context);
  const message = err instanceof Error ? err.message : String(err);
  try {
    process.stderr.write(`[kritya] warning: ${context} failed: ${message}\n`);
  } catch {
    // stderr itself failing isn't something this can do anything about
  }
  debugLog(context, err);
}

export interface PersistenceWarning {
  context: string;
  message: string;
}

/** Contexts currently warning via warnPersistenceFailure, in the order first seen. */
const persistenceWarnings: PersistenceWarning[] = [];
const persistenceListeners = new Set<(warnings: PersistenceWarning[]) => void>();

function notifyPersistenceListeners(): void {
  const snapshot = [...persistenceWarnings];
  for (const listener of persistenceListeners) listener(snapshot);
}

/** Current persistence-failure warnings (session/audit/telemetry writes that failed this process). */
export function activePersistenceWarnings(): PersistenceWarning[] {
  return [...persistenceWarnings];
}

/** Subscribe to persistence-warning changes. Returns an unsubscribe function. */
export function onPersistenceWarning(
  listener: (warnings: PersistenceWarning[]) => void
): () => void {
  persistenceListeners.add(listener);
  return () => persistenceListeners.delete(listener);
}

/**
 * Like warnUser, but for the specific best-effort writes whose failure means
 * silent data loss (session transcripts, audit log, telemetry) — a stderr
 * line alone is easy to miss since Ink's full-screen redraws can immediately
 * paint over it. Recorded once per context, same dedup as warnUser, so the
 * UI badge doesn't grow without bound from a write that fails every turn.
 */
export function warnPersistenceFailure(context: string, err: unknown): void {
  const isNewContext = !warnedContexts.has(context);
  warnUser(context, err);
  if (isNewContext) {
    const message = err instanceof Error ? err.message : String(err);
    persistenceWarnings.push({ context, message });
    notifyPersistenceListeners();
  }
}
