import { spawn } from "node:child_process";
import type { useApp } from "ink";

type SuspendTerminal = ReturnType<typeof useApp>["suspendTerminal"];

/**
 * Opens a file in the user's editor, handing the terminal over while it runs.
 *
 * Ink's `suspendTerminal` stops rendering, stops consuming input, and puts
 * the terminal back in the mode an interactive child expects (raw mode off,
 * cursor visible, bracketed paste off). When the editor exits, Ink reapplies
 * its own terminal state and repaints the whole UI from scratch, so the
 * session continues exactly where it left off.
 *
 * If the user changed the file, the undo stack's existing file watcher
 * reports it through `onExternalEdit` like any other outside edit — no
 * extra change detection needed here.
 */
export async function openInEditor(
  suspendTerminal: SuspendTerminal,
  absPath: string,
): Promise<void> {
  await suspendTerminal(async () => {
    const editor = process.env.VISUAL || process.env.EDITOR || "vi";
    await new Promise<void>((resolve) => {
      let child;
      try {
        child = spawn(editor, [absPath], { stdio: "inherit" });
      } catch {
        // Bad editor path — resolve instead of hanging the session.
        resolve();
        return;
      }
      // 'error' fires when the binary can't be launched at all.
      child.on("error", () => resolve());
      child.on("exit", () => resolve());
    });
  });
  // Ink has restored the terminal and repainted by the time this resolves.
}
