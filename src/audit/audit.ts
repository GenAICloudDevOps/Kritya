import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { CONFIG_DIR } from "../config/config.js";
import { hardenWindowsDir } from "../config/winAcl.js";
import { debugLog } from "../config/debug.js";

/**
 * An append-only audit trail of permission decisions and tool executions,
 * separate from the session transcript. The transcript records *what was
 * said*; this records *what was allowed to run, by whose authority, and how
 * it turned out* — the thing an enterprise reaches for during an incident
 * review. Written entirely to the local disk under ~/.kritya/audit; no
 * external service is involved.
 *
 * Two properties make it an audit log rather than just another file:
 *  - append-only: entries are only ever appended (fs "a" mode), never
 *    rewritten in place like the session file can be by /rewind or /compact.
 *  - tamper-evident: each line carries a SHA-256 hash chaining it to the one
 *    before (prevHash), so deleting or editing any line breaks the chain and
 *    is detectable by re-walking it. This is not cryptographic non-repudiation
 *    (a local attacker can recompute the whole chain) but it does catch silent
 *    truncation and single-record edits, which is what audit review looks for.
 */

/** Where a permission verdict came from, for the audit record. */
export type PermissionSource =
  | "deny-rule" // blocked by a settings deny rule
  | "allow-rule" // pre-approved by a settings allow rule
  | "always-allow" // approved via an earlier "always" choice this session
  | "accept-edits" // auto-approved by accept-edits mode
  | "interactive" // the user answered a live prompt
  | "plan-mode" // blocked because plan mode is on (read-only)
  | "dry-run-mode" // blocked because the manual dry-run toggle is on (read-only)
  | "kill-switch" // blocked because the session's kill switch is engaged
  | "read-only"; // the tool never needed permission

export type ToolOutcome = "ok" | "error" | "denied" | "blocked";

interface BaseRecord {
  ts: string;
  seq: number;
  sessionId: string;
  tool: string;
  summary: string;
}

export interface PermissionRecord extends BaseRecord {
  event: "permission";
  verdict: "allowed" | "denied";
  source: PermissionSource;
  /** classifyDanger's warning for a destructive shell command, if any. */
  danger?: string;
}

export interface ToolRecord extends BaseRecord {
  event: "tool";
  outcome: ToolOutcome;
  /** Time the tool itself ran. Excludes any wait for a permission answer. */
  durationMs?: number;
  /**
   * Time spent before the tool started — almost entirely a human reading a
   * permission prompt. Kept out of durationMs so tool timings stay a measure
   * of the machine, not of how fast the user reads.
   */
  waitMs?: number;
}

export type AuditRecord = (PermissionRecord | ToolRecord) & { prevHash: string; hash: string };

const GENESIS = "0".repeat(64);

/**
 * Where all audit logs live, across every workspace (not scoped per-project).
 * KRITYA_AUDIT_DIR overrides it — used by tests so cleanupOld's directory
 * scan (and any future directory-wide operation) never touches the real
 * ~/.kritya/audit on a dev machine.
 */
export function auditDir(): string {
  return process.env.KRITYA_AUDIT_DIR || path.join(CONFIG_DIR, "audit");
}

/**
 * Resolve where audit logs are written for this session, honoring an explicit
 * override. Kept separate so tests can point it at a temp dir.
 */
function defaultAuditFile(sessionId: string): string {
  const override = process.env.KRITYA_AUDIT_FILE;
  if (override) return override;
  return path.join(auditDir(), `${sessionId}.audit.jsonl`);
}

export class AuditLog {
  private seq = 0;
  private prevHash = GENESIS;
  private ready = false;

  constructor(
    private readonly sessionId: string,
    private readonly file: string = defaultAuditFile(sessionId)
  ) {}

  /** Where this session's records are written, for callers that report it. */
  get path(): string {
    return this.file;
  }

  /**
   * Off by default only when explicitly disabled; auditing is on otherwise so
   * the trail exists without anyone having to opt in. Returns undefined when
   * disabled so callers can leave `agent.audit` unset.
   *
   * `configDefault` is config.json's persisted `audit` setting, so a user can
   * turn auditing off for good without exporting KRITYA_AUDIT every launch —
   * the env var still wins over it when set, for a one-off override.
   */
  static forSession(sessionId: string, configDefault?: "on" | "off"): AuditLog | undefined {
    const envVal = (process.env.KRITYA_AUDIT ?? "").toLowerCase();
    const disabled = envVal ? envVal === "off" : configDefault === "off";
    if (disabled) return undefined;
    return new AuditLog(sessionId);
  }

  /**
   * Delete audit log files older than `retentionDays`. Best-effort, same
   * pattern as SessionStore.cleanupOldSessions. 0 or negative means "keep
   * forever" — auto-delete is disabled, not an immediate-expiry window.
   */
  static cleanupOld(retentionDays: number): void {
    if (retentionDays <= 0) return;
    const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    let files: string[];
    try {
      files = fs.readdirSync(auditDir()).filter((f) => f.endsWith(".audit.jsonl"));
    } catch {
      return;
    }
    for (const f of files) {
      const file = path.join(auditDir(), f);
      try {
        if (fs.statSync(file).mtimeMs < cutoff) fs.unlinkSync(file);
      } catch (err) {
        debugLog(`AuditLog.cleanupOld(${file})`, err);
      }
    }
  }

  logPermission(
    entry: Omit<PermissionRecord, keyof BaseRecord | "event"> & { tool: string; summary: string }
  ): void {
    this.write({ event: "permission", ...entry });
  }

  logTool(
    entry: Omit<ToolRecord, keyof BaseRecord | "event"> & { tool: string; summary: string }
  ): void {
    this.write({ event: "tool", ...entry });
  }

  private write(
    partial:
      | Omit<PermissionRecord, "seq" | "ts" | "sessionId">
      | Omit<ToolRecord, "seq" | "ts" | "sessionId">
  ): void {
    // Best-effort, exactly like SessionStore.append: an audit failure must
    // never crash a turn. A dropped record is preferable to a broken agent.
    try {
      this.ensureDir();
      const base = {
        ts: new Date().toISOString(),
        seq: this.seq++,
        sessionId: this.sessionId,
        ...partial,
      };
      const hash = crypto
        .createHash("sha256")
        .update(this.prevHash + JSON.stringify(base))
        .digest("hex");
      const record: AuditRecord = { ...base, prevHash: this.prevHash, hash } as AuditRecord;
      fs.appendFileSync(this.file, JSON.stringify(record) + "\n", { mode: 0o600 });
      this.prevHash = hash;
    } catch (err) {
      // best-effort
      debugLog(`AuditLog.write(${this.file})`, err);
    }
  }

  private ensureDir(): void {
    if (this.ready) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    hardenWindowsDir(auditDir());
    this.ready = true;
  }

  /**
   * Every valid record in a written audit file, in order. Corrupt lines are
   * skipped (mirrors SessionStore's tolerance for a truncated last line), so
   * this is for display purposes — use verify() to confirm the file wasn't
   * silently altered.
   */
  static readRecords(file: string): AuditRecord[] {
    let raw: string;
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch {
      return [];
    }
    const records: AuditRecord[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        records.push(JSON.parse(line) as AuditRecord);
      } catch {
        // skip corrupt lines
      }
    }
    return records;
  }

  /**
   * Re-walk a written audit file and confirm the hash chain is intact.
   *
   * Deliberately distinguishes "the file doesn't exist / can't be read" from
   * "the chain verifies clean" — collapsing those two cases (as an earlier
   * version of this method did, both returning -1) means deleting the whole
   * audit log would report the same as an untampered one, which is the
   * easiest way to defeat a tamper-evident log: don't edit it, remove it.
   */
  static verify(file: string): VerifyResult {
    let raw: string;
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch {
      return { ok: false, reason: "unreadable" };
    }
    const lines = raw.split("\n").filter((l) => l.trim());
    let prevHash = GENESIS;
    for (let i = 0; i < lines.length; i++) {
      let rec: AuditRecord;
      try {
        rec = JSON.parse(lines[i]) as AuditRecord;
      } catch {
        return { ok: false, reason: "tampered", line: i };
      }
      const { hash, prevHash: recPrev, ...base } = rec;
      if (recPrev !== prevHash) return { ok: false, reason: "tampered", line: i };
      const expected = crypto
        .createHash("sha256")
        .update(prevHash + JSON.stringify(base))
        .digest("hex");
      if (expected !== hash) return { ok: false, reason: "tampered", line: i };
      prevHash = hash;
    }
    return { ok: true, records: lines.length };
  }
}

export type VerifyResult =
  | { ok: true; records: number }
  | { ok: false; reason: "unreadable" }
  | { ok: false; reason: "tampered"; line: number };

/** Sorted-array percentile (nearest-rank). Returns 0 for an empty array. */
function percentile(sortedValues: number[], p: number): number {
  if (!sortedValues.length) return 0;
  const idx = Math.min(sortedValues.length - 1, Math.ceil((p / 100) * sortedValues.length) - 1);
  return sortedValues[Math.max(0, idx)];
}

export interface AuditSummary {
  totalRecords: number;
  toolCallsByOutcome: Partial<Record<ToolOutcome, number>>;
  permissionsBySource: Partial<Record<PermissionSource, number>>;
  /** Milliseconds the tool itself ran, over "ok" tool calls only. */
  durationMsP50: number;
  durationMsP95: number;
  /** Milliseconds spent waiting on a permission answer, over tool calls that recorded one. */
  waitMsP50: number;
  waitMsP95: number;
}

/**
 * A one-shot statistical rollup of an audit log — counts and latency
 * percentiles — computed on demand from the existing records rather than
 * persisted as its own record, so there's nothing new to keep in sync with
 * the hash chain. Used by `/audit` and `kritya audit --summary`.
 */
export function summarizeAudit(records: AuditRecord[]): AuditSummary {
  const toolCallsByOutcome: Partial<Record<ToolOutcome, number>> = {};
  const permissionsBySource: Partial<Record<PermissionSource, number>> = {};
  const durations: number[] = [];
  const waits: number[] = [];

  for (const r of records) {
    if (r.event === "tool") {
      toolCallsByOutcome[r.outcome] = (toolCallsByOutcome[r.outcome] ?? 0) + 1;
      if (r.outcome === "ok" && typeof r.durationMs === "number") durations.push(r.durationMs);
      if (typeof r.waitMs === "number") waits.push(r.waitMs);
    } else {
      permissionsBySource[r.source] = (permissionsBySource[r.source] ?? 0) + 1;
    }
  }
  durations.sort((a, b) => a - b);
  waits.sort((a, b) => a - b);

  return {
    totalRecords: records.length,
    toolCallsByOutcome,
    permissionsBySource,
    durationMsP50: percentile(durations, 50),
    durationMsP95: percentile(durations, 95),
    waitMsP50: percentile(waits, 50),
    waitMsP95: percentile(waits, 95),
  };
}
