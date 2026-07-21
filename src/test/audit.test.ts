import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { AuditLog } from "../audit/audit.js";

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

  assert.equal(AuditLog.verify(file), -1, "intact chain verifies");

  // Tamper with the middle line's payload; the chain must break at that index.
  const lines = fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim());
  const rec = JSON.parse(lines[1]) as Record<string, unknown>;
  rec.summary = "run: rm -rf /"; // rewrite history
  lines[1] = JSON.stringify(rec);
  fs.writeFileSync(file, lines.join("\n") + "\n");

  assert.equal(AuditLog.verify(file), 1, "tampered line is detected");
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

  assert.equal(AuditLog.verify(file), 1, "gap in the chain is detected");
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
