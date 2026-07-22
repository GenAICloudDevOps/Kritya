import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Windows command resolution for stdio MCP servers.
 *
 * `npx` on Windows is really `npx.cmd`, and Node stopped applying PATHEXT to
 * non-shell spawns in the CVE-2024-27980 fix — so `spawn("npx", args)` ENOENTs
 * on the exact example `/mcp` prints. Worse, that same fix makes Node *refuse*
 * to spawn a `.cmd`/`.bat` directly (EINVAL): batch files can only be launched
 * through cmd.exe.
 *
 * The tempting fix, `shell: true`, hands every `args` entry to cmd.exe as
 * shell text — and MCP server definitions come from a repo's `.mcp.json`, so
 * an arg like `x & calc` would be a command-injection vector. Instead we do
 * what cross-spawn does: find the real file ourselves, and when it turns out
 * to be a batch file, invoke cmd.exe with a command line we quote and
 * caret-escape by hand, passed verbatim so Node doesn't re-quote it.
 */

/** How a resolved command should be handed to `child_process.spawn`. */
export interface SpawnPlan {
  command: string;
  args: string[];
  /** Set when we built the cmd.exe command line ourselves; Node must not re-quote it. */
  windowsVerbatimArguments?: boolean;
}

function pathExtensions(): string[] {
  return (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((e) => e.trim())
    .filter(Boolean);
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * Find the concrete file a bare command name refers to, applying PATHEXT the
 * way a shell would. Returns undefined when nothing matches, so the caller can
 * fall through to a plain spawn and let the OS produce the usual ENOENT rather
 * than a substitute error that points at the wrong thing.
 */
export function resolveWindowsCommand(command: string): string | undefined {
  const exts = pathExtensions();
  const hasExt = exts.some((e) => command.toLowerCase().endsWith(e.toLowerCase()));
  const isPath = command.includes("/") || command.includes("\\") || path.isAbsolute(command);

  // An explicit path with an explicit extension is already unambiguous.
  if (hasExt && isPath) return isFile(command) ? command : undefined;

  const bases = isPath
    ? [command]
    : (process.env.PATH ?? "")
        .split(path.delimiter)
        .filter(Boolean)
        .map((dir) => path.join(dir, command));

  for (const base of bases) {
    if (hasExt) {
      if (isFile(base)) return base;
      continue;
    }
    for (const ext of exts) {
      if (isFile(base + ext)) return base + ext;
    }
  }
  return undefined;
}

/**
 * Quote one argument so cmd.exe passes it through unchanged.
 *
 * Two layers: the standard Windows double-quote rules (so the child's own
 * argv parsing sees the original string), then a caret escape of every
 * character cmd.exe would still act on before the child ever runs.
 */
function escapeForCmd(arg: string): string {
  // Escape backslashes that precede a quote, and any trailing run of them,
  // then wrap in quotes — the CommandLineToArgvW rules.
  const quoted = `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, "$1$1")}"`;
  return quoted.replace(/[()[\]{}^=;!'+,`~%!&|<>"]/g, "^$&");
}

/**
 * Decide how to spawn `command` with `args` on this platform. On non-Windows,
 * and for ordinary .exe files on Windows, this is a passthrough; only batch
 * files need the cmd.exe detour.
 */
export function planSpawn(command: string, args: string[]): SpawnPlan {
  if (os.platform() !== "win32") return { command, args };

  const resolved = resolveWindowsCommand(command);
  if (!resolved) return { command, args };

  const ext = path.extname(resolved).toLowerCase();
  if (ext !== ".cmd" && ext !== ".bat") return { command: resolved, args };

  const comSpec = process.env.ComSpec ?? process.env.COMSPEC ?? "cmd.exe";
  const line = [resolved, ...args].map(escapeForCmd).join(" ");
  return {
    // /d skips AutoRun commands from the registry, /s keeps our outer quotes
    // intact, /c runs and exits.
    command: comSpec,
    args: ["/d", "/s", "/c", `"${line}"`],
    windowsVerbatimArguments: true,
  };
}
