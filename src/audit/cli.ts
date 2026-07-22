import fs from "node:fs";
import path from "node:path";
import { AuditLog, auditDir, summarizeAudit } from "./audit.js";
import { loadConfig } from "../config/config.js";
import { retentionDaysFor, DEFAULT_RETENTION_DAYS } from "../config/retention.js";

export const AUDIT_USAGE = `kritya audit — inspect the local, tamper-evident audit log

Usage:
  kritya audit --list                list recent audit log files, newest first
  kritya audit --verify [file]       check a log's hash chain is intact
                                      (defaults to the most recent log)
  kritya audit --show [file]         print a log's records, one JSON line each
                                      (defaults to the most recent log)
  kritya audit --summary [file]      counts and latency percentiles for a log
                                      (defaults to the most recent log)
  kritya audit --prune [days]        delete audit logs older than [days]
                                      (defaults to your configured retention,
                                      currently ${DEFAULT_RETENTION_DAYS} unless set in config.json)

Audit logs live under ~/.kritya/audit/<session>.audit.jsonl — see the
"Audit log & telemetry" section of the README for what gets recorded, and for
how to set retentionDays / audit / otel in ~/.kritya/config.json.`;

function listAuditFiles(): string[] {
  let names: string[];
  try {
    names = fs.readdirSync(auditDir()).filter((f) => f.endsWith(".audit.jsonl"));
  } catch {
    return [];
  }
  return names.map((f) => path.join(auditDir(), f)).sort((a, b) => statMtime(b) - statMtime(a));
}

function statMtime(file: string): number {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

/** Resolves a --verify/--show argument (bare filename, absolute path, or omitted) to a full path. */
function resolveFile(arg: string | undefined): string | undefined {
  if (!arg) return listAuditFiles()[0];
  return path.isAbsolute(arg) ? arg : path.join(auditDir(), arg);
}

function describeVerify(file: string): string {
  const result = AuditLog.verify(file);
  if (result.ok) return `${result.records} record(s), chain intact`;
  if (result.reason === "unreadable") return "FAILED — file could not be read";
  return `FAILED — chain broken at record ${result.line}`;
}

/** Handles `kritya audit ...`. Returns the process exit code. */
export function runAuditCli(argv: string[]): number {
  if (argv.includes("--list")) {
    const files = listAuditFiles();
    if (!files.length) {
      console.log(`No audit logs found under ${auditDir()}`);
      return 0;
    }
    for (const file of files) {
      console.log(`${path.basename(file)}  —  ${describeVerify(file)}`);
    }
    return 0;
  }

  const verifyIdx = argv.indexOf("--verify");
  if (verifyIdx !== -1) {
    const next = argv[verifyIdx + 1];
    const file = resolveFile(next && !next.startsWith("--") ? next : undefined);
    if (!file) {
      console.error(`No audit log found under ${auditDir()}`);
      return 1;
    }
    const result = AuditLog.verify(file);
    console.log(`${file}\n${describeVerify(file)}`);
    return result.ok ? 0 : 1;
  }

  const showIdx = argv.indexOf("--show");
  if (showIdx !== -1) {
    const next = argv[showIdx + 1];
    const file = resolveFile(next && !next.startsWith("--") ? next : undefined);
    if (!file) {
      console.error(`No audit log found under ${auditDir()}`);
      return 1;
    }
    for (const record of AuditLog.readRecords(file)) {
      console.log(JSON.stringify(record));
    }
    return 0;
  }

  const summaryIdx = argv.indexOf("--summary");
  if (summaryIdx !== -1) {
    const next = argv[summaryIdx + 1];
    const file = resolveFile(next && !next.startsWith("--") ? next : undefined);
    if (!file) {
      console.error(`No audit log found under ${auditDir()}`);
      return 1;
    }
    const s = summarizeAudit(AuditLog.readRecords(file));
    console.log(`${file}`);
    console.log(`${s.totalRecords} record(s)`);
    console.log(`Permission decisions by source: ${fmtCounts(s.permissionsBySource)}`);
    console.log(`Tool outcomes: ${fmtCounts(s.toolCallsByOutcome)}`);
    console.log(`Tool latency: p50 ${s.durationMsP50}ms / p95 ${s.durationMsP95}ms`);
    console.log(`Permission wait: p50 ${s.waitMsP50}ms / p95 ${s.waitMsP95}ms`);
    return 0;
  }

  if (argv.includes("--prune")) {
    const idx = argv.indexOf("--prune");
    const next = argv[idx + 1];
    const explicitDays = next && !next.startsWith("--") ? Number(next) : undefined;
    const days =
      explicitDays !== undefined && Number.isFinite(explicitDays)
        ? explicitDays
        : retentionDaysFor(loadConfig());
    if (days <= 0) {
      console.log(
        "Retention is disabled (0 or negative) — nothing pruned. Pass a positive number of days."
      );
      return 0;
    }
    const before = listAuditFiles().length;
    AuditLog.cleanupOld(days);
    const after = listAuditFiles().length;
    console.log(`Pruned ${before - after} audit log(s) older than ${days} day(s).`);
    return 0;
  }

  console.log(AUDIT_USAGE);
  return 0;
}

function fmtCounts(m: Partial<Record<string, number>>): string {
  return (
    Object.entries(m)
      .sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))
      .map(([k, v]) => `${k}: ${v}`)
      .join(", ") || "(none)"
  );
}
