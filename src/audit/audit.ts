import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { CONFIG_DIR } from "../config/config.js";
import { hardenWindowsDir } from "../config/winAcl.js";

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

type AuditRecord = (PermissionRecord | ToolRecord) & { prevHash: string; hash: string };

const GENESIS = "0".repeat(64);

function auditDir(): string {
  return path.join(CONFIG_DIR, "audit");
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
   */
  static forSession(sessionId: string): AuditLog | undefined {
    if ((process.env.KRITYA_AUDIT ?? "").toLowerCase() === "off") return undefined;
    return new AuditLog(sessionId);
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
    } catch {
      // best-effort
    }
  }

  private ensureDir(): void {
    if (this.ready) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    hardenWindowsDir(auditDir());
    this.ready = true;
  }

  /**
   * Re-walk a written audit file and confirm the hash chain is intact. Returns
   * the index of the first tampered/broken line, or -1 if the whole chain
   * verifies. Used by tests and by an eventual `kritya audit --verify`.
   */
  static verify(file: string): number {
    let raw: string;
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch {
      return -1;
    }
    const lines = raw.split("\n").filter((l) => l.trim());
    let prevHash = GENESIS;
    for (let i = 0; i < lines.length; i++) {
      let rec: AuditRecord;
      try {
        rec = JSON.parse(lines[i]) as AuditRecord;
      } catch {
        return i;
      }
      const { hash, prevHash: recPrev, ...base } = rec;
      if (recPrev !== prevHash) return i;
      const expected = crypto
        .createHash("sha256")
        .update(prevHash + JSON.stringify(base))
        .digest("hex");
      if (expected !== hash) return i;
      prevHash = hash;
    }
    return -1;
  }
}
