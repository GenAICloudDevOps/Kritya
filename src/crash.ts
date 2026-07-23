/**
 * Last-resort handlers for an error that escaped every other guard.
 *
 * Without these, an unhandled rejection anywhere — an Ink render error, an MCP
 * callback, a filesystem watcher edge case — terminates the process *without*
 * firing the "exit" event, which is where every cleanup path in kritya hangs
 * off. The visible cost is orphaned children: background dev servers, MCP
 * stdio processes, and LSP servers all outlive the session that started them.
 * The less visible cost is the terminal, which Ink leaves in raw mode with the
 * cursor hidden, so the shell the user drops back into is unusable until they
 * blind-type `reset`.
 *
 * A crash handler cannot make the crash not have happened. What it can do is
 * make it survivable: release the machine's resources, hand the terminal back
 * in a usable state, and tell the user where the transcript is so the session
 * can be resumed rather than retyped.
 */

export interface CrashHandlerOptions {
  /** Release processes/handles. Must be safe to call twice and must not throw. */
  cleanup(): void;
  /** Extra lines printed after the error, e.g. how to resume. Must not throw. */
  details?(): string[];
  /** Restore the TTY before printing — for the Ink UI, not headless. */
  restoreTerminal?: boolean;
  /** Tear down the Ink app, if one is mounted. */
  unmountUi?(): void;
}

let installed = false;
let handling = false;

/**
 * Put the terminal back the way we found it: raw mode off (or the shell reads
 * keystrokes one at a time), cursor visible again (Ink hides it while
 * rendering), and any alternate screen exited.
 */
function restoreTerminal(): void {
  try {
    if (process.stdin.isTTY && process.stdin.setRawMode) process.stdin.setRawMode(false);
  } catch {
    // Nothing to do — we're already on the failure path.
  }
  try {
    if (process.stdout.isTTY) process.stdout.write("\x1b[?25h\x1b[?1049l\x1b[0m");
  } catch {
    // ditto
  }
}

function describe(err: unknown): string {
  if (err instanceof Error) return err.stack || `${err.name}: ${err.message}`;
  return String(err);
}

/**
 * Install `uncaughtException` / `unhandledRejection` handlers. Idempotent, and
 * re-entrancy-safe: a second crash raised *while* handling the first exits
 * immediately rather than recursing through cleanup again.
 */
export function installCrashHandlers(opts: CrashHandlerOptions): void {
  if (installed) return;
  installed = true;

  const onCrash = (err: unknown, kind: string): void => {
    if (handling) {
      // Something in the crash path itself threw. Take the exit and go.
      process.exit(1);
    }
    handling = true;

    try {
      opts.unmountUi?.();
    } catch {
      // The UI is what crashed, quite possibly.
    }
    if (opts.restoreTerminal) restoreTerminal();
    try {
      opts.cleanup();
    } catch {
      // Best-effort by definition — we're exiting either way.
    }

    const lines = [
      "",
      `kritya crashed (${kind}). Background processes and MCP servers were shut down.`,
      describe(err),
    ];
    try {
      lines.push(...(opts.details?.() ?? []));
    } catch {
      // A details() that throws must not cost us the error report above.
    }
    lines.push("", "This is a bug in kritya — the trace above is what a report needs.");
    try {
      process.stderr.write(lines.join("\n") + "\n");
    } catch {
      // stderr is gone; nothing further to try.
    }
    process.exit(1);
  };

  process.on("uncaughtException", (err) => onCrash(err, "uncaught exception"));
  process.on("unhandledRejection", (reason) => onCrash(reason, "unhandled rejection"));
}

/** Test seam: forget that handlers were installed. */
export function resetCrashHandlersForTest(): void {
  installed = false;
  handling = false;
}
