/**
 * Where a warning goes while someone else owns the terminal.
 *
 * Ink owns the terminal for the whole time the UI is up. It keeps its frame in
 * a known place, and anything that reaches the terminal *through* Ink is
 * written between clearing that frame and repainting it — so the text lands
 * above the UI and stays there. A raw `process.stderr.write` bypasses all of
 * that: the bytes land wherever the cursor happened to be, in the middle of
 * the frame, and the next repaint erases and redraws against a line count that
 * no longer matches the screen. The warning comes out garbled and takes the
 * frame with it.
 *
 * Ink patches `console` for exactly this reason, but `console.error` is not
 * available to the plain module functions that raise these warnings — an agent
 * loop, an MCP client, a plugin loader — and a hook (`useStderr`) cannot be
 * called from one. So the UI registers a sink on mount and clears it on
 * unmount, and everything else goes through `writeStderr`, which uses the sink
 * when there is one and raw stderr when there is not: CLI subcommands, headless
 * runs, and anything before the UI mounts or after it is torn down.
 *
 * Deliberately not used by `crash.ts`: by the time a crash handler runs, the
 * UI is being torn down and its frame state is not trustworthy, so the crash
 * report goes straight to stderr.
 */
let sink: ((text: string) => void) | undefined;

/** Installed by the mounted UI. Pass `undefined` on unmount. */
export function setStderrSink(fn: ((text: string) => void) | undefined): void {
  sink = fn;
}

/** Write a warning to stderr, through the UI when one is mounted. */
export function writeStderr(text: string): void {
  if (sink) {
    try {
      sink(text);
      return;
    } catch {
      // A sink that throws must not cost us the warning itself.
    }
  }
  try {
    process.stderr.write(text);
  } catch {
    // stderr is gone; there is nowhere left to put it.
  }
}
