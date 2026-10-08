import { spawn } from "node:child_process";
import os from "node:os";

/**
 * Copies text to the system clipboard.
 *
 * Deliberately shelling out rather than taking a dependency: every OS already
 * ships a clipboard command, and the alternatives (a native module, an OSC 52
 * escape) either add a build step or only work in terminals that opt in. OSC 52
 * was tempting — it needs no subprocess and works over SSH — but it silently
 * does nothing in terminals that refuse it, and this feature is only useful if
 * the paste actually lands.
 *
 * Returns true only when the write completed cleanly, so the caller can say
 * "copied" or "couldn't copy" honestly rather than claiming success blindly.
 */

/** The clipboard command for this platform, or null where there is none. */
function clipboardCommand(): { cmd: string; args: string[] } | null {
  switch (os.platform()) {
    case "darwin":
      return { cmd: "pbcopy", args: [] };
    case "win32":
      // `clip` is present on every Windows install; `clip.exe` is what
      // Git Bash and WSL resolve it to, and CreateProcess finds either.
      return { cmd: "clip", args: [] };
    default:
      // Linux/BSD: Wayland first (wl-copy), then X11 (xclip, then xsel).
      // There is no "just use the right one" — which is available depends on
      // the session — so the caller gets null and reports it as unavailable
      // rather than picking a tool that will exit with ENOENT.
      return null;
  }
}

/**
 * Linux has no single guaranteed clipboard tool, so probe the two common ones.
 * Kept separate from the platform switch so the probe is a plain lookup the
 * tests can reason about.
 */
export function linuxClipboardCandidates(): { cmd: string; args: string[] }[] {
  return [
    { cmd: "wl-copy", args: [] },
    { cmd: "xclip", args: ["-selection", "clipboard"] },
    { cmd: "xsel", args: ["--clipboard", "--input"] },
  ];
}

function writeTo(cmd: string, args: string[], text: string): Promise<boolean> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { stdio: ["pipe", "ignore", "ignore"] });
    } catch {
      resolve(false);
      return;
    }
    // A tool that is not installed fails here; a missing binary is not an
    // error worth surfacing, just "this method didn't work".
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
    try {
      child.stdin.end(text);
    } catch {
      resolve(false);
    }
  });
}

/**
 * Copy `text` to the clipboard. Resolves false (never rejects) when no
 * clipboard method is available, so a keybinding can report the failure in the
 * transcript instead of crashing the session.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  const direct = clipboardCommand();
  if (direct) return writeTo(direct.cmd, direct.args, text);

  if (os.platform() === "linux") {
    for (const candidate of linuxClipboardCandidates()) {
      if (await writeTo(candidate.cmd, candidate.args, text)) return true;
    }
  }
  return false;
}
