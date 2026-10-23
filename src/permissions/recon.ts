import { commandTouchesSensitivePath, isSensitivePath } from "../tools/common.js";

/**
 * Recon-pattern tripwire: sequence detection over a session's tool calls.
 *
 * The other guards judge one call at a time — a sensitive filename here, a
 * destructive command there. That misses the slow shape of an agent loop
 * patiently mapping its environment: dump the environment variables, probe
 * the credential files, list the home and system directories, ask the OS
 * who and where it is. Each call looks ordinary; the *pattern* is the tell.
 *
 * This module classifies each call into weighted recon signals and keeps a
 * rolling score over the session's recent calls. Past the threshold the
 * tripwire latches for the rest of the session: any further call carrying a
 * recon signal is blocked by the tool executor, while ordinary work —
 * reads, edits, builds, tests — continues untouched. A new session starts
 * with a clean score.
 *
 * Honest limits, same as the rest of the pattern-matching layer: this sees
 * literal command text and path arguments, so a caller that assembles the
 * same behavior out of pieces no pattern names (an interpreter one-liner
 * that enumerates the environment itself, say) scores nothing. And a slow
 * sequence spread thinner than the rolling window stays under the limit by
 * design — the window exists so a long, legitimate session's incidental
 * probes (one `whoami` while debugging, one look at an env var) decay
 * instead of accumulating into a false trip.
 */

export type ReconKind = "credential-probe" | "env-dump" | "enumeration" | "system-probe";

export interface ReconSignal {
  kind: ReconKind;
  weight: number;
  detail: string;
}

const WEIGHTS: Record<ReconKind, number> = {
  "credential-probe": 5,
  "env-dump": 4,
  enumeration: 2,
  "system-probe": 2,
};

/** Score at or above which the tripwire latches for the rest of the session. */
export const RECON_TRIP_THRESHOLD = 10;

/** How many recent calls the rolling score covers. */
export const RECON_WINDOW_CALLS = 20;

function signal(kind: ReconKind, detail: string): ReconSignal {
  return { kind, weight: WEIGHTS[kind], detail };
}

interface CommandPattern {
  re: RegExp;
  detail: string;
}

/**
 * Whole-environment dumps. Only the bare forms score: `env FOO=1 cmd` runs a
 * command with one variable set and `printenv PATH` reads one variable —
 * both ordinary. Dumping *everything* is the recon move.
 */
const ENV_DUMP_PATTERNS: CommandPattern[] = [
  { re: /(^|[|;&]\s*)(env|printenv)(\s*$|\s*[|;&])/, detail: "bare env/printenv dump" },
  { re: /\bexport\s+-p\b/, detail: "export -p dump" },
  { re: /\bdeclare\s+-x\b/, detail: "declare -x dump" },
  { re: /\bcompgen\s+-e\b/, detail: "compgen -e env listing" },
  { re: /\/proc\/(\d+|self)\/environ\b/, detail: "reads /proc environ" },
  { re: /\b(dir|ls|gci|Get-ChildItem)\s+env:/i, detail: "PowerShell env: drive listing" },
];

/** Identity and network-shape questions — cheap to ask, classic to ask first. */
const SYSTEM_PROBE_PATTERNS: CommandPattern[] = [
  { re: /\bwhoami\b/, detail: "whoami" },
  { re: /\bhostname\b/, detail: "hostname" },
  { re: /\buname\b/, detail: "uname" },
  { re: /\bsysteminfo\b/, detail: "systeminfo" },
  { re: /(^|[|;&]\s*)id\s*($|[|;&])/, detail: "bare id" },
  { re: /\bnetstat\b/, detail: "netstat" },
  { re: /\bifconfig\b/, detail: "ifconfig" },
  { re: /\bipconfig\b/, detail: "ipconfig" },
  { re: /\bip\s+(addr|address|link|route)\b/, detail: "ip addr/link/route" },
  { re: /\barp\s+-a\b/, detail: "arp -a" },
  { re: /\bps\s+(aux|ef|-ef|-aux)\b/, detail: "full process listing" },
];

/**
 * Listing the places a person keeps things, rather than the project: home,
 * the filesystem root, /etc, other users' folders. A listing of the
 * workspace itself (relative paths, /tmp, project dirs) scores nothing.
 */
const ENUMERATION_PATTERNS: CommandPattern[] = [
  {
    re: /(?:^|[|;&]\s*)(?:ls|dir|find|tree)\b[^|;&]*?\s(?:~|\$HOME|\/etc|\/home|[A-Za-z]:\\Users)(?=[\s|;&]|$)/,
    detail: "lists home/system directories",
  },
  {
    re: /(?:^|[|;&]\s*)(?:ls|dir|find|tree)\b[^|;&]*?\s\/(?=[\s|;&]|$)/,
    detail: "lists the filesystem root",
  },
];

/** Tools whose path/pattern arguments can aim at a credential file or a system directory. */
const PATH_ARG_TOOLS = new Set([
  "read_file",
  "read_document",
  "read_notebook",
  "edit_file",
  "write_file",
  "grep",
  "glob",
  "list_dir",
]);

/**
 * Classify one tool call into recon signals — at most one signal per kind,
 * so a single busy command can't trip the wire on repetition alone; it
 * takes either one heavy call (a credential probe plus a dump) or a genuine
 * sequence across calls.
 */
export function classifyReconCall(toolName: string, args: Record<string, unknown>): ReconSignal[] {
  const byKind = new Map<ReconKind, ReconSignal>();
  const add = (s: ReconSignal): void => {
    if (!byKind.has(s.kind)) byKind.set(s.kind, s);
  };

  if (toolName === "shell") {
    const command = String(args.command ?? "");
    if (command) {
      const sensitive = commandTouchesSensitivePath(command);
      if (sensitive) add(signal("credential-probe", `command references "${sensitive}"`));
      for (const { re, detail } of ENV_DUMP_PATTERNS) {
        if (re.test(command)) {
          add(signal("env-dump", detail));
          break;
        }
      }
      for (const { re, detail } of ENUMERATION_PATTERNS) {
        if (re.test(command)) {
          add(signal("enumeration", detail));
          break;
        }
      }
      for (const { re, detail } of SYSTEM_PROBE_PATTERNS) {
        if (re.test(command)) {
          add(signal("system-probe", detail));
          break;
        }
      }
    }
  } else if (PATH_ARG_TOOLS.has(toolName)) {
    for (const key of ["path", "pattern"] as const) {
      const value = args[key];
      if (typeof value !== "string" || !value) continue;
      if (isSensitivePath(value)) {
        add(signal("credential-probe", `${toolName} targets "${value}"`));
      }
      if (
        (toolName === "list_dir" || toolName === "glob") &&
        /^(~|\$HOME|\/|\/etc|\/home)([\\/]|$)/.test(value)
      ) {
        add(signal("enumeration", `${toolName} targets "${value}"`));
      }
    }
  }

  return [...byKind.values()];
}

/**
 * The rolling score and the latch. One instance per agent session (the
 * tool executor owns it). Blocked calls are recorded too — the executor
 * records before it blocks — so continued probing keeps the score pinned
 * above the threshold instead of decaying while the caller retries.
 */
export class ReconTripwire {
  private window: { score: number; kinds: ReconKind[] }[] = [];
  private latchedKinds: ReconKind[] | null = null;

  get tripped(): boolean {
    return this.latchedKinds !== null;
  }

  /** The signal kinds that contributed to the trip, for the block message. */
  get tripKinds(): ReconKind[] {
    return this.latchedKinds ?? [];
  }

  private windowScore(): number {
    return this.window.reduce((acc, w) => acc + w.score, 0);
  }

  /**
   * Record one call's signals. Returns whether this call must be blocked:
   * the call that pushes the score to the threshold, and — once latched —
   * every later call that carries any recon signal. Signal-free calls are
   * never blocked, tripped or not.
   */
  record(signals: ReconSignal[]): { blocked: boolean; score: number } {
    const score = signals.reduce((acc, s) => acc + s.weight, 0);
    this.window.push({ score, kinds: signals.map((s) => s.kind) });
    if (this.window.length > RECON_WINDOW_CALLS) this.window.shift();

    const total = this.windowScore();
    if (this.latchedKinds) {
      return { blocked: signals.length > 0, score: total };
    }
    if (total >= RECON_TRIP_THRESHOLD) {
      this.latchedKinds = [...new Set(this.window.flatMap((w) => w.kinds))];
      return { blocked: signals.length > 0, score: total };
    }
    return { blocked: false, score: total };
  }
}
