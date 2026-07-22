import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { AuditLog, summarizeAudit } from "../audit/audit.js";

function tmpFile(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "kritya-audit-")), "session.audit.jsonl");
}

function readRecords(file: string): Record<string, unknown>[] {
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

test("logs permission and tool records as append-only JSONL", () => {
  const file = tmpFile();
  const log = new AuditLog("sess-1", file);

  log.logPermission({
    tool: "shell",
    summary: "run: rm x",
    verdict: "denied",
    source: "deny-rule",
  });
  log.logPermission({
    tool: "write_file",
    summary: "write a.txt",
    verdict: "allowed",
    source: "interactive",
  });
  log.logTool({ tool: "write_file", summary: "write a.txt", outcome: "ok", durationMs: 12 });

  const records = readRecords(file);
  assert.equal(records.length, 3);
  assert.equal(records[0].event, "permission");
  assert.equal(records[0].verdict, "denied");
  assert.equal(records[0].source, "deny-rule");
  assert.equal(records[0].sessionId, "sess-1");
  assert.equal(records[0].seq, 0);
  assert.equal(records[2].event, "tool");
  assert.equal(records[2].outcome, "ok");
  assert.equal(records[2].durationMs, 12);
  // Sequence numbers are monotonic.
  assert.deepEqual(
    records.map((r) => r.seq),
    [0, 1, 2]
  );
});

test("appends rather than truncates across separate writes", () => {
  const file = tmpFile();
  const log = new AuditLog("sess-2", file);
  log.logTool({ tool: "read_file", summary: "read a", outcome: "ok" });
  log.logTool({ tool: "read_file", summary: "read b", outcome: "ok" });
  assert.equal(readRecords(file).length, 2);
});

test("hash chain verifies for an untampered log and detects edits", () => {
  const file = tmpFile();
  const log = new AuditLog("sess-3", file);
  log.logPermission({
    tool: "shell",
    summary: "run: ls",
    verdict: "allowed",
    source: "allow-rule",
  });
  log.logTool({ tool: "shell", summary: "run: ls", outcome: "ok" });
  log.logTool({ tool: "shell", summary: "run: ls", outcome: "ok" });

  const clean = AuditLog.verify(file);
  assert.equal(clean.ok, true, "intact chain verifies");
  assert.equal(clean.ok && clean.records, 3);

  // Tamper with the middle line's payload; the chain must break at that index.
  const lines = fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim());
  const rec = JSON.parse(lines[1]) as Record<string, unknown>;
  rec.summary = "run: rm -rf /"; // rewrite history
  lines[1] = JSON.stringify(rec);
  fs.writeFileSync(file, lines.join("\n") + "\n");

  const tampered = AuditLog.verify(file);
  assert.equal(tampered.ok, false, "tampered line is detected");
  assert.ok(!tampered.ok && tampered.reason === "tampered" && tampered.line === 1);
});

test("deleting a line breaks the chain (truncation is detectable)", () => {
  const file = tmpFile();
  const log = new AuditLog("sess-4", file);
  log.logTool({ tool: "a", summary: "a", outcome: "ok" });
  log.logTool({ tool: "b", summary: "b", outcome: "ok" });
  log.logTool({ tool: "c", summary: "c", outcome: "ok" });

  const lines = fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim());
  lines.splice(1, 1); // remove the middle record
  fs.writeFileSync(file, lines.join("\n") + "\n");

  const result = AuditLog.verify(file);
  assert.equal(result.ok, false, "gap in the chain is detected");
  assert.ok(!result.ok && result.reason === "tampered" && result.line === 1);
});

test("verify reports 'unreadable' rather than 'clean' for a missing file", () => {
  // A deleted or never-written audit log must not look identical to an
  // untampered one — that would be the easiest way to defeat the tamper
  // check: don't edit the log, remove it.
  const file = tmpFile(); // never written
  const result = AuditLog.verify(file);
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.reason, "unreadable");
});

test("readRecords returns every record in order, skipping corrupt lines", () => {
  const file = tmpFile();
  const log = new AuditLog("sess-5", file);
  log.logTool({ tool: "a", summary: "a", outcome: "ok" });
  log.logTool({ tool: "b", summary: "b", outcome: "error" });
  fs.appendFileSync(file, "not json at all\n");

  const records = AuditLog.readRecords(file);
  assert.equal(records.length, 2);
  assert.equal(records[0].tool, "a");
  assert.equal(records[1].tool, "b");
});

test("forSession honors KRITYA_AUDIT=off", () => {
  const prev = process.env.KRITYA_AUDIT;
  try {
    process.env.KRITYA_AUDIT = "off";
    assert.equal(AuditLog.forSession("x"), undefined);
    process.env.KRITYA_AUDIT = "";
    assert.ok(AuditLog.forSession("x") instanceof AuditLog);
  } finally {
    if (prev === undefined) delete process.env.KRITYA_AUDIT;
    else process.env.KRITYA_AUDIT = prev;
  }
});

test("forSession honors config.json's audit default, but the env var wins over it", () => {
  const prev = process.env.KRITYA_AUDIT;
  try {
    delete process.env.KRITYA_AUDIT;
    assert.equal(AuditLog.forSession("x", "off"), undefined, "config default off disables it");
    assert.ok(AuditLog.forSession("x", "on") instanceof AuditLog);
    assert.ok(AuditLog.forSession("x") instanceof AuditLog, "on by default with no config either");

    process.env.KRITYA_AUDIT = "off";
    assert.equal(
      AuditLog.forSession("x", "on"),
      undefined,
      "env var off overrides a config default of on"
    );
  } finally {
    if (prev === undefined) delete process.env.KRITYA_AUDIT;
    else process.env.KRITYA_AUDIT = prev;
  }
});

test("summarizeAudit counts outcomes/sources and computes latency percentiles", () => {
  const file = tmpFile();
  const log = new AuditLog("sess-6", file);
  log.logPermission({ tool: "read_file", summary: "r", verdict: "allowed", source: "read-only" });
  log.logPermission({
    tool: "write_file",
    summary: "w",
    verdict: "allowed",
    source: "interactive",
  });
  log.logPermission({ tool: "shell", summary: "s", verdict: "denied", source: "deny-rule" });
  const durations = [10, 20, 30, 40, 100];
  for (const d of durations) {
    log.logTool({ tool: "x", summary: "x", outcome: "ok", durationMs: d, waitMs: d * 2 });
  }
  log.logTool({ tool: "y", summary: "y", outcome: "error" });

  const summary = summarizeAudit(AuditLog.readRecords(file));
  assert.equal(summary.totalRecords, 9);
  assert.equal(summary.toolCallsByOutcome.ok, 5);
  assert.equal(summary.toolCallsByOutcome.error, 1);
  assert.equal(summary.permissionsBySource["read-only"], 1);
  assert.equal(summary.permissionsBySource["deny-rule"], 1);
  // p50 of [10,20,30,40,100] (nearest-rank) is the 3rd value.
  assert.equal(summary.durationMsP50, 30);
  assert.equal(summary.durationMsP95, 100);
  assert.equal(summary.waitMsP50, 60);
});

test("cleanupOld deletes audit logs past retentionDays and leaves recent ones", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kritya-audit-cleanup-"));
  const oldFile = path.join(dir, "old.audit.jsonl");
  const newFile = path.join(dir, "new.audit.jsonl");
  fs.writeFileSync(oldFile, "{}\n");
  fs.writeFileSync(newFile, "{}\n");
  const oldTime = Date.now() - 20 * 24 * 60 * 60 * 1000; // 20 days ago
  fs.utimesSync(oldFile, oldTime / 1000, oldTime / 1000);

  const prev = process.env.KRITYA_AUDIT_DIR;
  try {
    process.env.KRITYA_AUDIT_DIR = dir;
    AuditLog.cleanupOld(15);
    assert.ok(!fs.existsSync(oldFile), "old file was pruned");
    assert.ok(fs.existsSync(newFile), "recent file was kept");
  } finally {
    if (prev === undefined) delete process.env.KRITYA_AUDIT_DIR;
    else process.env.KRITYA_AUDIT_DIR = prev;
  }
});

test("cleanupOld(0) keeps everything — 0 or negative means keep forever", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kritya-audit-cleanup-"));
  const oldFile = path.join(dir, "old.audit.jsonl");
  fs.writeFileSync(oldFile, "{}\n");
  const oldTime = Date.now() - 365 * 24 * 60 * 60 * 1000;
  fs.utimesSync(oldFile, oldTime / 1000, oldTime / 1000);

  const prev = process.env.KRITYA_AUDIT_DIR;
  try {
    process.env.KRITYA_AUDIT_DIR = dir;
    AuditLog.cleanupOld(0);
    assert.ok(fs.existsSync(oldFile), "nothing is deleted when retention is disabled");
  } finally {
    if (prev === undefined) delete process.env.KRITYA_AUDIT_DIR;
    else process.env.KRITYA_AUDIT_DIR = prev;
  }
});
