import { spawn, type ChildProcess } from "node:child_process";
import os from "node:os";
import { scrubbedShellEnv } from "../config/config.js";

const MAX_BUFFER_CHARS = 50_000;

interface BgProcess {
  proc: ChildProcess;
  command: string;
  buffer: string;
  exitCode: number | null;
  running: boolean;
}

/**
 * Registry of long-running processes the agent started with shell
 * background:true (dev servers, watchers). Captures a rolling tail of
 * interleaved stdout/stderr; everything is killed when kritya exits.
 */
class BackgroundManager {
  private procs = new Map<string, BgProcess>();
  private counter = 0;

  start(command: string, cwd: string): { id: string } {
    const id = `bg_${++this.counter}`;
    const isWindows = os.platform() === "win32";
    // detached on POSIX puts the command in its own process group, so kill()
    // can signal the whole tree (sh + whatever it spawned), not just sh.
    // scrubbedShellEnv: background commands must not inherit provider API keys.
    const proc = isWindows
      ? spawn("cmd", ["/c", command], { cwd, env: scrubbedShellEnv(), windowsHide: true })
      : spawn("sh", ["-c", command], { cwd, env: scrubbedShellEnv(), detached: true });
    const entry: BgProcess = { proc, command, buffer: "", exitCode: null, running: true };

    const append = (chunk: Buffer) => {
      entry.buffer += chunk.toString();
      if (entry.buffer.length > MAX_BUFFER_CHARS) {
        entry.buffer = entry.buffer.slice(-MAX_BUFFER_CHARS);
      }
    };
    proc.stdout?.on("data", append);
    proc.stderr?.on("data", append);
    // "exit" (not "close"): grandchildren may inherit the pipes and keep them
    // open after the direct child dies; exit still fires then.
    proc.on("exit", (code) => {
      entry.running = false;
      entry.exitCode = code;
      proc.stdout?.destroy();
      proc.stderr?.destroy();
    });
    proc.on("error", (err) => {
      entry.running = false;
      entry.buffer += `\n[failed to start: ${err.message}]`;
    });

    this.procs.set(id, entry);
    return { id };
  }

  private signal(entry: BgProcess, sig: NodeJS.Signals): boolean {
    try {
      if (os.platform() !== "win32" && entry.proc.pid) {
        process.kill(-entry.proc.pid, sig); // whole process group
      } else {
        entry.proc.kill(sig);
      }
      return true;
    } catch {
      return false;
    }
  }

  read(
    id: string
  ): { output: string; running: boolean; exitCode: number | null; command: string } | null {
    const entry = this.procs.get(id);
    if (!entry) return null;
    return {
      output: entry.buffer,
      running: entry.running,
      exitCode: entry.exitCode,
      command: entry.command,
    };
  }

  kill(id: string): boolean {
    const entry = this.procs.get(id);
    if (!entry || !entry.running) return false;
    return this.signal(entry, "SIGTERM");
  }

  list(): { id: string; command: string; running: boolean }[] {
    return [...this.procs.entries()].map(([id, e]) => ({
      id,
      command: e.command,
      running: e.running,
    }));
  }

  killAll(): void {
    for (const entry of this.procs.values()) {
      if (entry.running) this.signal(entry, "SIGKILL");
    }
  }
}

export const backgroundManager = new BackgroundManager();
