import assert from "node:assert/strict";
import { test } from "node:test";
import { createMeter, NOOP_METER, DEFAULT_LATENCY_BOUNDS_MS } from "../telemetry/metrics.js";

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

test("KRITYA_OTEL_ENDPOINT unset yields the no-op meter", () => {
  withEnv({ KRITYA_OTEL_ENDPOINT: undefined }, () => {
    assert.equal(createMeter("s"), NOOP_METER);
  });
  NOOP_METER.counter("x").add(1);
  NOOP_METER.histogram("y").record(1);
  NOOP_METER.flush();
  NOOP_METER.stop();
});

test("counter and histogram aggregate cumulatively and flush an OTLP snapshot", () => {
  const calls: any[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: any) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return new Response("", { status: 200 });
  }) as typeof fetch;

  let meter: ReturnType<typeof createMeter>;
  try {
    withEnv({ KRITYA_OTEL_ENDPOINT: "http://localhost:4318" }, () => {
      meter = createMeter("sess-metrics", undefined, 1_000_000 /* never auto-fire in the test */);
      const calls_ = meter.counter("kritya.tool.calls");
      calls_.add(1, { "kritya.tool": "write_file", "kritya.outcome": "ok" });
      calls_.add(1, { "kritya.tool": "write_file", "kritya.outcome": "ok" });
      const dur = meter.histogram("kritya.tool.duration_ms", DEFAULT_LATENCY_BOUNDS_MS);
      dur.record(5, { "kritya.tool": "write_file" });
      dur.record(75, { "kritya.tool": "write_file" });
      meter.flush();
    });
  } finally {
    globalThis.fetch = realFetch;
    meter!.stop();
  }

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://localhost:4318/v1/metrics");
  const metrics = calls[0].body.resourceMetrics[0].scopeMetrics[0].metrics;
  const sumMetric = metrics.find((m: any) => m.name === "kritya.tool.calls");
  assert.equal(sumMetric.sum.dataPoints[0].asDouble, 2);
  const histMetric = metrics.find((m: any) => m.name === "kritya.tool.duration_ms");
  assert.equal(histMetric.histogram.dataPoints[0].count, "2");
  assert.equal(histMetric.histogram.dataPoints[0].sum, 80);
  // bounds [10,50,100,...] -> 5 falls in bucket 0 (<=10), 75 falls in bucket 2 (<=100)
  assert.deepEqual(histMetric.histogram.dataPoints[0].bucketCounts.slice(0, 3), ["1", "0", "1"]);
});
