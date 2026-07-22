import fs from "node:fs";
import path from "node:path";
import { AuditLog, auditDir } from "./audit.js";

export const AUDIT_USAGE = `kritya audit — inspect the local, tamper-evident audit log

Usage:
  kritya audit --list                list recent audit log files, newest first
  kritya audit --verify [file]       check a log's hash chain is intact
                                      (defaults to the most recent log)
  kritya audit --show [file]         print a log's records, one JSON line each
                                      (defaults to the most recent log)

Audit logs live under ~/.kritya/audit/<session>.audit.jsonl — see the
"Audit log & telemetry" section of the README for what gets recorded.`;

function listAuditFiles(): string[] {
  let names: string[];
  try {
    names = fs.readdirSync(auditDir()).filter((f) => f.endsWith(".audit.jsonl"));
  } catch {
    return [];
  }
  return names
    .map((f) => path.join(auditDir(), f))
    .sort((a, b) => statMtime(b) - statMtime(a));
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

  console.log(AUDIT_USAGE);
  return 0;
}
