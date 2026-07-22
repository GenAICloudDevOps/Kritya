/**
 * A session-wide emergency stop.
 *
 * Engaging it aborts whatever is in flight (the model stream, a running shell
 * command, subagents) and refuses to start anything new until it's released.
 * It is deliberately a shared object rather than a boolean on `Agent`:
 * subagents are separate `Agent` instances, so a per-agent flag would stop the
 * main loop while its children kept running — the exact failure a kill switch
 * exists to prevent. One instance is handed to the main agent and to every
 * agent it spawns.
 *
 * Session-only by design: it lives in memory and dies with the process. A
 * restart comes up in the normal state.
 */

/** Thrown when a turn is refused or interrupted because the switch is engaged. */
export class KillSwitchError extends Error {
  constructor(readonly killReason?: string) {
    super(killReason ? `Kill switch active: ${killReason}` : "Kill switch active");
    this.name = "KillSwitchError";
  }
}

export class KillSwitch {
  /** Replaced on release, so a released switch hands out a fresh, un-aborted signal. */
  private controller = new AbortController();
  private engagedAt?: number;
  private engagedReason?: string;
  private listeners = new Set<(active: boolean) => void>();

  get active(): boolean {
    return this.engagedAt !== undefined;
  }

  get reason(): string | undefined {
    return this.engagedReason;
  }

  get activatedAt(): number | undefined {
    return this.engagedAt;
  }

  /** Aborted for as long as the switch is engaged. Link work to it via `linkAbort`. */
  get signal(): AbortSignal {
    return this.controller.signal;
  }

  /** Engage the switch. Returns false if it was already engaged (idempotent). */
  engage(reason?: string): boolean {
    if (this.active) return false;
    this.engagedAt = Date.now();
    this.engagedReason = reason?.trim() || undefined;
    this.controller.abort();
    this.notify(true);
    return true;
  }

  /** Release it and re-arm a fresh signal. Returns false if it wasn't engaged. */
  release(): boolean {
    if (!this.active) return false;
    this.engagedAt = undefined;
    this.engagedReason = undefined;
    this.controller = new AbortController();
    this.notify(false);
    return true;
  }

  /** Subscribe to engage/release. Returns an unsubscribe function. */
  onChange(fn: (active: boolean) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Throw if the switch is engaged — the guard at the top of a turn. */
  assertLive(): void {
    if (this.active) throw new KillSwitchError(this.reason);
  }

  private notify(active: boolean): void {
    for (const listener of this.listeners) {
      // A listener that throws must never stop the switch from taking effect
      // for everyone else — that would defeat the whole point.
      try {
        listener(active);
      } catch {
        // ignore
      }
    }
  }
}

/**
 * Combine the kill switch's signal with a caller's own signal, so work aborts
 * when either fires. (`AbortSignal.any` would do this, but it needs Node 20 and
 * this package supports 18.) Call `dispose()` when the work finishes so the
 * listeners don't accumulate on a long-lived switch.
 */
export function linkAbort(
  kill: KillSwitch,
  signal?: AbortSignal
): { signal: AbortSignal; dispose(): void } {
  if (!signal) return { signal: kill.signal, dispose: () => {} };

  const controller = new AbortController();
  if (kill.signal.aborted || signal.aborted) {
    controller.abort();
    return { signal: controller.signal, dispose: () => {} };
  }

  const abort = (): void => controller.abort();
  const killSignal = kill.signal; // capture: release() swaps in a new one
  killSignal.addEventListener("abort", abort, { once: true });
  signal.addEventListener("abort", abort, { once: true });
  return {
    signal: controller.signal,
    dispose: () => {
      killSignal.removeEventListener("abort", abort);
      signal.removeEventListener("abort", abort);
    },
  };
}
