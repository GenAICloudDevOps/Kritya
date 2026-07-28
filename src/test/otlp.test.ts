import assert from "node:assert/strict";
import { test } from "node:test";
import { encodeSpan, encodeMetricsSnapshot, type MetricPoint } from "../telemetry/otlp.js";
import type { SpanExport } from "../telemetry/tracer.js";

const RESOURCE = { attributes: { "service.name": "kritya", "service.version": "0.5.0" } };

function sampleSpan(overrides: Partial<SpanExport> = {}): SpanExport {
  return {
    traceId: "0102030405060708090a0b0c0d0e0f10",
    spanId: "0102030405060708",
    name: "tool.write_file",
    startTimeUnixNano: "1000000000",
    endTimeUnixNano: "2000000000",
    attributes: { "kritya.tool": "write_file", "kritya.duration_ms": 42, "kritya.ok": true },
    status: { code: "OK" },
    events: [{ name: "retry", timeUnixNano: "1500000000", attributes: { attempt: 2 } }],
    ...overrides,
  };
}

test("encodeSpan wraps a single span in resourceSpans/scopeSpans and hex-encodes ids", () => {
  const body = encodeSpan(sampleSpan(), RESOURCE) as any;
  const span = body.resourceSpans[0].scopeSpans[0].spans[0];
  assert.equal(span.name, "tool.write_file");
  // Trace/span ids are the OTLP JSON spec's one carve-out from base64: they
  // stay hex, matching every other tracing tool's display convention — a
  // collector accepts (200) but silently drops base64-encoded ids instead.
  assert.equal(span.traceId, "0102030405060708090a0b0c0d0e0f10");
  assert.equal(span.spanId, "0102030405060708");
  assert.equal(span.startTimeUnixNano, "1000000000");
  assert.equal(span.status.code, 1); // STATUS_CODE_OK
  const toolAttr = span.attributes.find((a: any) => a.key === "kritya.tool");
  assert.deepEqual(toolAttr.value, { stringValue: "write_file" });
  const durAttr = span.attributes.find((a: any) => a.key === "kritya.duration_ms");
  assert.deepEqual(durAttr.value, { doubleValue: 42 });
  const okAttr = span.attributes.find((a: any) => a.key === "kritya.ok");
  assert.deepEqual(okAttr.value, { boolValue: true });
  assert.equal(span.events[0].name, "retry");
  assert.equal(body.resourceSpans[0].resource.attributes[0].key, "service.name");
});

test("encodeSpan maps ERROR status with a message", () => {
  const body = encodeSpan(
    sampleSpan({ status: { code: "ERROR", message: "boom" } }),
    RESOURCE
  ) as any;
  const span = body.resourceSpans[0].scopeSpans[0].spans[0];
  assert.equal(span.status.code, 2); // STATUS_CODE_ERROR
  assert.equal(span.status.message, "boom");
});

test("encodeMetricsSnapshot emits a sum metric and a histogram metric", () => {
  const points: MetricPoint[] = [
    {
      name: "kritya.tool.calls",
      kind: "sum",
      attributes: { "kritya.tool": "write_file", "kritya.outcome": "ok" },
      startTimeUnixNano: "1000000000",
      timeUnixNano: "2000000000",
      sumValue: 5,
      isMonotonic: true,
    },
    {
      name: "kritya.tool.duration_ms",
      kind: "histogram",
      attributes: { "kritya.tool": "write_file" },
      startTimeUnixNano: "1000000000",
      timeUnixNano: "2000000000",
      histogram: { count: 3, sum: 150, bucketCounts: [1, 1, 1, 0], explicitBounds: [10, 50, 100] },
    },
  ];
  const body = encodeMetricsSnapshot(points, RESOURCE) as any;
  const metrics = body.resourceMetrics[0].scopeMetrics[0].metrics;
  const sumMetric = metrics.find((m: any) => m.name === "kritya.tool.calls");
  assert.equal(sumMetric.sum.dataPoints[0].asDouble, 5);
  assert.equal(sumMetric.sum.isMonotonic, true);
  assert.equal(sumMetric.sum.aggregationTemporality, 2); // CUMULATIVE
  const histMetric = metrics.find((m: any) => m.name === "kritya.tool.duration_ms");
  assert.equal(histMetric.histogram.dataPoints[0].count, "3");
  assert.deepEqual(histMetric.histogram.dataPoints[0].explicitBounds, [10, 50, 100]);
  assert.deepEqual(histMetric.histogram.dataPoints[0].bucketCounts, ["1", "1", "1", "0"]);
});
