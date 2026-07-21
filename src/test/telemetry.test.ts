import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createTracer, NOOP_TRACER, type SpanExport } from "../telemetry/tracer.js";

function withEnv(env: Record<string, string | undefined>, fn: () => void): void {
  const prev: Record<string, string | undefined> = {};
  for (const k of Object.keys(env)) prev[k] = process.env[k];
  try {
    for (const [k, v] of Object.entries(env)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

function readSpans(file: string): SpanExport[] {
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as SpanExport);
}

test("KRITYA_OTEL unset yields the no-op tracer", () => {
  withEnv({ KRITYA_OTEL: undefined }, () => {
    assert.equal(createTracer("s"), NOOP_TRACER);
  });
  // The no-op span accepts calls without emitting or throwing.
  const span = NOOP_TRACER.startSpan("x");
  span.setAttribute("k", 1).addEvent("e").setStatus("OK").end();
});

test("file exporter writes OTel-shaped spans with parent nesting", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "kritya-otel-")), "t.otel.jsonl");
  withEnv({ KRITYA_OTEL: "file", KRITYA_OTEL_FILE: file }, () => {
    const tracer = createTracer("sess");
    const turn = tracer.startSpan("agent.turn", { attributes: { "kritya.model": "m" } });
    const tool = tracer.startSpan("tool.write_file", { parent: turn });
    tool.setAttribute("kritya.tool", "write_file").setStatus("OK").end();
    turn.setStatus("OK").end();
  });

  const spans = readSpans(file);
  assert.equal(spans.length, 2);
  const tool = spans.find((s) => s.name === "tool.write_file")!;
  const turn = spans.find((s) => s.name === "agent.turn")!;
  assert.ok(tool && turn);
  // Child inherits the trace, and links to the parent span.
  assert.equal(tool.traceId, turn.traceId);
  assert.equal(tool.parentSpanId, turn.spanId);
  assert.equal(turn.parentSpanId, undefined);
  // OTel-shaped fields are present.
  assert.match(tool.traceId, /^[0-9a-f]{32}$/);
  assert.match(tool.spanId, /^[0-9a-f]{16}$/);
  assert.ok(BigInt(tool.endTimeUnixNano) >= BigInt(tool.startTimeUnixNano));
  assert.equal(tool.status.code, "OK");
  assert.equal(tool.attributes["kritya.tool"], "write_file");
});

test("ERROR status and events are recorded", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "kritya-otel-")), "e.otel.jsonl");
  withEnv({ KRITYA_OTEL: "file", KRITYA_OTEL_FILE: file }, () => {
    const tracer = createTracer("sess");
    const span = tracer.startSpan("tool.shell");
    span.addEvent("denied", { source: "deny-rule" }).setStatus("ERROR", "blocked").end();
  });
  const [span] = readSpans(file);
  assert.equal(span.status.code, "ERROR");
  assert.equal(span.status.message, "blocked");
  assert.equal(span.events[0].name, "denied");
});

test("end() is idempotent — a span is emitted at most once", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "kritya-otel-")), "i.otel.jsonl");
  withEnv({ KRITYA_OTEL: "file", KRITYA_OTEL_FILE: file }, () => {
    const span = createTracer("sess").startSpan("tool.x");
    span.end();
    span.end();
  });
  assert.equal(readSpans(file).length, 1);
});
