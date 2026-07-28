# Observability: OTLP Export to Phoenix + Prometheus/Grafana Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Kritya's existing local-only tracer a real OTLP export path, add a matching metrics API, and stand up a Docker-free local observability stack (OTel Collector → Phoenix for traces, Prometheus + Grafana for metrics/alerting).

**Architecture:** Kritya keeps its dependency-free, best-effort telemetry philosophy. `tracer.ts` gains an OTLP HTTP/JSON sink that POSTs one span at a time to a collector (no client-side batching — the collector, not the SDK, owns batching/retry, so Kritya's side stays simple). A new `metrics.ts` adds a small Meter (counters + fixed-bucket histograms) that aggregates in-process and flushes periodically to the same collector over `/v1/metrics`. The collector fans traces to Phoenix and metrics to Prometheus; Grafana reads from Prometheus. Every piece runs as a plain binary/process — no Docker required.

**Tech Stack:** TypeScript, Node 22+ built-in `fetch`, `node:test` for tests, OpenTelemetry Collector binary, Arize Phoenix (pip), Prometheus binary, Grafana binary/package. No new npm dependencies.

## Global Constraints

- Zero new npm dependencies — use Node's built-in `fetch`, matching the existing "dependency-free" tracer design (see `src/telemetry/tracer.ts:15-19`).
- All new sinks/exporters are **best-effort**: a failed or slow export must never throw into the agent loop or block a turn. Follow the existing `try { ... } catch { debugLog(...) }` pattern used by `fileSink`/`consoleSink`.
- New env vars: `KRITYA_OTEL_ENDPOINT` (base URL of an OTLP/HTTP collector, e.g. `http://localhost:4318`), `KRITYA_OTEL_HEADERS` (optional, comma-separated `Key=Value` pairs for auth headers). No `config.json` field for MVP — env var only, same precedent as `KRITYA_OTEL_FILE`.
- Presence of `KRITYA_OTEL_ENDPOINT` enables OTLP export independent of `KRITYA_OTEL`'s file/console mode — you can run `KRITYA_OTEL_ENDPOINT=...` alone with no file/console sink.
- Metrics use **cumulative** aggregation temporality (never resets for the life of the process) — this is what Prometheus's data model expects natively and avoids delta/reset bookkeeping.
- Node version floor: >=22 (already the repo's `engines.node`, confirmed in `package.json`).
- All new files follow the existing file header comment style used in `src/telemetry/tracer.ts` (a short doc comment explaining _why_, not _what_).

## File Structure

- `src/telemetry/otlp.ts` — **new**. Pure OTLP/HTTP JSON encoding (`encodeSpan`, `encodeMetricsSnapshot`) + a tiny best-effort POST helper (`postOtlp`) shared by the tracer and the meter.
- `src/telemetry/tracer.ts` — **modify**. Add `otlpSpanSink()` and wire it into `createTracer` behind `KRITYA_OTEL_ENDPOINT`.
- `src/telemetry/metrics.ts` — **new**. `Meter`/`Counter`/`Histogram` API mirroring `Tracer`/`Span`, in-process cumulative aggregation, periodic flush via `otlp.ts`.
- `src/agent/toolExecutor.ts` — **modify**. Record tool-call duration histogram + outcome counter alongside the existing span/audit calls.
- `src/agent/loop.ts` — **modify**. Record turn duration + token-usage counters alongside the existing turn span.
- `src/index.tsx` — **modify**. Create the session `Meter` next to the session `Tracer`, pass it down, flush it on the signal-handler shutdown path.
- `src/test/otlp.test.ts` — **new**. Tests for the pure encoders.
- `src/test/tracer-otlp.test.ts` — **new**. Tests for the OTLP sink wiring (stubbed `fetch`).
- `src/test/metrics.test.ts` — **new**. Tests for `Meter` aggregation + flush payload shape.
- `observability/otelcol-config.yaml` — **new**. Collector config: OTLP receiver → Phoenix (traces) + Prometheus (metrics) exporters.
- `observability/prometheus.yml` — **new**. Prometheus scrape config pointed at the collector's Prometheus exporter.
- `observability/grafana/provisioning/datasources/prometheus.yml` — **new**. Auto-provisioned Grafana datasource.
- `observability/grafana/provisioning/dashboards/dashboards.yml` — **new**. Dashboard provider config.
- `observability/grafana/provisioning/dashboards/kritya.json` — **new**. Starter dashboard (tool latency, error rate, calls/min).
- `docs/observability.md` — **new**. End-to-end, Docker-free setup walkthrough.

---

### Task 1: OTLP/HTTP JSON encoders

**Files:**

- Create: `src/telemetry/otlp.ts`
- Test: `src/test/otlp.test.ts`

**Interfaces:**

- Consumes: `SpanExport`, `AttrValue` from `../telemetry/tracer.js` (already defined).
- Produces (used by Tasks 2 and 3):
  - `export interface OtlpResource { attributes: Record<string, AttrValue> }`
  - `export function encodeSpan(span: SpanExport, resource: OtlpResource): unknown` — one OTLP `ExportTraceServiceRequest` JSON body wrapping a single span.
  - `export interface MetricPoint { name: string; kind: "sum" | "histogram"; attributes: Record<string, AttrValue>; startTimeUnixNano: string; timeUnixNano: string; sumValue?: number; isMonotonic?: boolean; histogram?: { count: number; sum: number; bucketCounts: number[]; explicitBounds: number[] } }`
  - `export function encodeMetricsSnapshot(points: MetricPoint[], resource: OtlpResource): unknown` — one `ExportMetricsServiceRequest` JSON body.
  - `export function postOtlp(endpoint: string, path: "/v1/traces" | "/v1/metrics", body: unknown, headers?: Record<string, string>): void` — fire-and-forget best-effort `fetch` POST, `application/json`, never throws.

- [ ] **Step 1: Write the failing tests for `encodeSpan`**

```typescript
// src/test/otlp.test.ts
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

test("encodeSpan wraps a single span in resourceSpans/scopeSpans and base64-encodes ids", () => {
  const body = encodeSpan(sampleSpan(), RESOURCE) as any;
  const span = body.resourceSpans[0].scopeSpans[0].spans[0];
  assert.equal(span.name, "tool.write_file");
  // 16-byte traceId hex -> base64
  assert.equal(
    span.traceId,
    Buffer.from("0102030405060708090a0b0c0d0e0f10", "hex").toString("base64")
  );
  assert.equal(span.spanId, Buffer.from("0102030405060708", "hex").toString("base64"));
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx tsx --test src/test/otlp.test.ts`
Expected: FAIL — `../telemetry/otlp.js` does not exist.

- [ ] **Step 3: Implement `src/telemetry/otlp.ts`**

```typescript
import { debugLog } from "../config/debug.js";
import type { AttrValue, SpanExport } from "./tracer.js";

/**
 * Minimal OTLP/HTTP JSON encoding — deliberately not the @opentelemetry/*
 * SDK (see tracer.ts for why). Implements just enough of the JSON mapping
 * (https://opentelemetry.io/docs/specs/otlp/#json-protobuf-encoding) for a
 * collector to accept: trace/span ids as base64, attributes as typed
 * KeyValue, int64 fields as decimal strings.
 */

export interface OtlpResource {
  attributes: Record<string, AttrValue>;
}

function hexToBase64(hex: string): string {
  return Buffer.from(hex, "hex").toString("base64");
}

function toAnyValue(value: AttrValue): Record<string, unknown> {
  if (typeof value === "string") return { stringValue: value };
  if (typeof value === "boolean") return { boolValue: value };
  return { doubleValue: value };
}

function toKeyValueList(attributes: Record<string, AttrValue>): { key: string; value: unknown }[] {
  return Object.entries(attributes).map(([key, value]) => ({ key, value: toAnyValue(value) }));
}

function toOtlpResource(resource: OtlpResource): unknown {
  return { attributes: toKeyValueList(resource.attributes) };
}

const STATUS_CODE: Record<SpanExport["status"]["code"], number> = { UNSET: 0, OK: 1, ERROR: 2 };

function toOtlpSpan(span: SpanExport): unknown {
  return {
    traceId: hexToBase64(span.traceId),
    spanId: hexToBase64(span.spanId),
    ...(span.parentSpanId ? { parentSpanId: hexToBase64(span.parentSpanId) } : {}),
    name: span.name,
    kind: 1, // SPAN_KIND_INTERNAL — kritya's spans are all local tool-loop work
    startTimeUnixNano: span.startTimeUnixNano,
    endTimeUnixNano: span.endTimeUnixNano,
    attributes: toKeyValueList(span.attributes),
    status: {
      code: STATUS_CODE[span.status.code],
      ...(span.status.message ? { message: span.status.message } : {}),
    },
    events: span.events.map((e) => ({
      name: e.name,
      timeUnixNano: e.timeUnixNano,
      attributes: e.attributes ? toKeyValueList(e.attributes) : [],
    })),
  };
}

/** Wraps a single span in an ExportTraceServiceRequest — one HTTP call per span, no client-side batching (the collector batches downstream). */
export function encodeSpan(span: SpanExport, resource: OtlpResource): unknown {
  return {
    resourceSpans: [
      {
        resource: toOtlpResource(resource),
        scopeSpans: [{ scope: { name: "kritya" }, spans: [toOtlpSpan(span)] }],
      },
    ],
  };
}

export interface MetricPoint {
  name: string;
  kind: "sum" | "histogram";
  attributes: Record<string, AttrValue>;
  startTimeUnixNano: string;
  timeUnixNano: string;
  sumValue?: number;
  isMonotonic?: boolean;
  histogram?: { count: number; sum: number; bucketCounts: number[]; explicitBounds: number[] };
}

const CUMULATIVE = 2; // AGGREGATION_TEMPORALITY_CUMULATIVE

function toOtlpMetric(point: MetricPoint): unknown {
  const dataPointBase = {
    attributes: toKeyValueList(point.attributes),
    startTimeUnixNano: point.startTimeUnixNano,
    timeUnixNano: point.timeUnixNano,
  };
  if (point.kind === "sum") {
    return {
      name: point.name,
      sum: {
        dataPoints: [{ ...dataPointBase, asDouble: point.sumValue ?? 0 }],
        aggregationTemporality: CUMULATIVE,
        isMonotonic: point.isMonotonic ?? true,
      },
    };
  }
  const h = point.histogram!;
  return {
    name: point.name,
    histogram: {
      dataPoints: [
        {
          ...dataPointBase,
          count: String(h.count),
          sum: h.sum,
          bucketCounts: h.bucketCounts.map(String),
          explicitBounds: h.explicitBounds,
        },
      ],
      aggregationTemporality: CUMULATIVE,
    },
  };
}

/** Wraps the current cumulative snapshot of all metric points in one ExportMetricsServiceRequest. */
export function encodeMetricsSnapshot(points: MetricPoint[], resource: OtlpResource): unknown {
  return {
    resourceMetrics: [
      {
        resource: toOtlpResource(resource),
        scopeMetrics: [{ scope: { name: "kritya" }, metrics: points.map(toOtlpMetric) }],
      },
    ],
  };
}

/**
 * Fire-and-forget POST to an OTLP/HTTP collector endpoint. Best-effort like
 * every other telemetry sink in this codebase — a down collector must never
 * slow down or break a turn.
 */
export function postOtlp(
  endpoint: string,
  path: "/v1/traces" | "/v1/metrics",
  body: unknown,
  headers?: Record<string, string>
): void {
  try {
    fetch(`${endpoint.replace(/\/+$/, "")}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(headers ?? {}) },
      body: JSON.stringify(body),
    }).catch((err) => debugLog(`postOtlp(${path})`, err));
  } catch (err) {
    debugLog(`postOtlp(${path})`, err);
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx tsx --test src/test/otlp.test.ts`
Expected: PASS (all 3 tests)

- [ ] **Step 5: Commit**

```bash
git add src/telemetry/otlp.ts src/test/otlp.test.ts
git commit -m "feat(telemetry): add OTLP/HTTP JSON encoders"
```

---

### Task 2: Wire an OTLP span sink into the tracer

**Files:**

- Modify: `src/telemetry/tracer.ts`
- Test: `src/test/tracer-otlp.test.ts`

**Interfaces:**

- Consumes: `encodeSpan`, `postOtlp`, `OtlpResource` from `./otlp.js` (Task 1); `VERSION` from `../version.js`.
- Produces: `createTracer` now also honors `KRITYA_OTEL_ENDPOINT` and `KRITYA_OTEL_HEADERS`, independent of `KRITYA_OTEL`'s file/console mode.

- [ ] **Step 1: Write the failing test**

```typescript
// src/test/tracer-otlp.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { createTracer } from "../telemetry/tracer.js";

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

test("KRITYA_OTEL_ENDPOINT posts each ended span to /v1/traces", async () => {
  const calls: { url: string; body: any }[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: any) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return new Response("", { status: 200 });
  }) as typeof fetch;

  try {
    await withEnv({ KRITYA_OTEL: undefined, KRITYA_OTEL_ENDPOINT: "http://localhost:4318" }, () => {
      const tracer = createTracer("sess-otlp");
      const span = tracer.startSpan("agent.turn", { attributes: { "kritya.model": "m" } });
      span.setStatus("OK").end();
    });
    // fetch is called async (fire-and-forget); give the microtask queue a turn.
    await new Promise((r) => setTimeout(r, 0));
  } finally {
    globalThis.fetch = realFetch;
  }

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://localhost:4318/v1/traces");
  const span = calls[0].body.resourceSpans[0].scopeSpans[0].spans[0];
  assert.equal(span.name, "agent.turn");
});

test("KRITYA_OTEL_ENDPOINT with KRITYA_OTEL=off still exports (endpoint alone enables it)", async () => {
  const calls: any[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string) => {
    calls.push(url);
    return new Response("", { status: 200 });
  }) as typeof fetch;

  try {
    await withEnv({ KRITYA_OTEL: "off", KRITYA_OTEL_ENDPOINT: "http://localhost:4318" }, () => {
      const tracer = createTracer("sess-otlp-2");
      tracer.startSpan("x").end();
    });
    await new Promise((r) => setTimeout(r, 0));
  } finally {
    globalThis.fetch = realFetch;
  }

  assert.equal(calls.length, 1);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsx --test src/test/tracer-otlp.test.ts`
Expected: FAIL — no requests captured, since `KRITYA_OTEL_ENDPOINT` isn't read yet.

- [ ] **Step 3: Modify `src/telemetry/tracer.ts`**

Add imports near the top (after the existing imports):

```typescript
import { VERSION } from "../version.js";
import { encodeSpan, postOtlp, type OtlpResource } from "./otlp.js";
```

Add a resource builder and header parser, and the new sink, near `consoleSink`:

```typescript
const RESOURCE: OtlpResource = {
  attributes: { "service.name": "kritya", "service.version": VERSION, "os.type": process.platform },
};

function parseOtlpHeaders(raw: string | undefined): Record<string, string> | undefined {
  if (!raw) return undefined;
  const headers: Record<string, string> = {};
  for (const pair of raw.split(",")) {
    const eq = pair.indexOf("=");
    if (eq === -1) continue;
    headers[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
  }
  return headers;
}

function otlpSink(endpoint: string): Sink {
  const headers = parseOtlpHeaders(process.env.KRITYA_OTEL_HEADERS);
  return (span) => postOtlp(endpoint, "/v1/traces", encodeSpan(span, RESOURCE), headers);
}
```

Replace the body of `createTracer` (lines 240-259) with:

```typescript
export function createTracer(sessionId: string, configDefault?: OtelMode): Tracer {
  const mode = resolveOtelMode(configDefault);
  const endpoint = process.env.KRITYA_OTEL_ENDPOINT;
  const modeOff = mode === "off" || mode === "" || mode === "false";
  if (modeOff && !endpoint) return NOOP_TRACER;

  const sinks: Sink[] = [];
  if (mode === "file" || mode === "both") {
    sinks.push(fileSink(telemetryFileFor(sessionId, configDefault)!));
  }
  if (mode === "console" || mode === "both") {
    sinks.push(consoleSink());
  }
  if (endpoint) {
    sinks.push(otlpSink(endpoint));
  }
  if (!sinks.length) {
    // Unrecognized value (e.g. "1", "on"): default to a file, which is the
    // useful local-only behavior, rather than silently doing nothing.
    sinks.push(fileSink(path.join(telemetryDir(), `${sessionId}.otel.jsonl`)));
  }

  const sink: Sink = sinks.length === 1 ? sinks[0] : (span) => sinks.forEach((s) => s(span));
  return new RealTracer(sink);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx tsx --test src/test/tracer-otlp.test.ts src/test/telemetry.test.ts`
Expected: PASS — new tests pass and the pre-existing `telemetry.test.ts` suite is unaffected (endpoint unset in those tests, same NOOP/file/console behavior as before).

- [ ] **Step 5: Commit**

```bash
git add src/telemetry/tracer.ts src/test/tracer-otlp.test.ts
git commit -m "feat(telemetry): export spans to an OTLP collector via KRITYA_OTEL_ENDPOINT"
```

---

### Task 3: Metrics API (counters + histograms) with OTLP export

**Files:**

- Create: `src/telemetry/metrics.ts`
- Test: `src/test/metrics.test.ts`

**Interfaces:**

- Consumes: `AttrValue` from `./tracer.js`; `encodeMetricsSnapshot`, `postOtlp`, `MetricPoint`, `OtlpResource` from `./otlp.js`.
- Produces (used by Tasks 4 and 5):
  - `export interface Counter { add(value: number, attributes?: Record<string, AttrValue>): void }`
  - `export interface Histogram { record(value: number, attributes?: Record<string, AttrValue>): void }`
  - `export interface Meter { counter(name: string): Counter; histogram(name: string, bounds?: number[]): Histogram; flush(): void; stop(): void }`
  - `export const NOOP_METER: Meter`
  - `export function createMeter(sessionId: string, configDefault?: OtelMode, flushIntervalMs?: number): Meter` (re-exports `OtelMode` from `./tracer.js`)
  - `export const DEFAULT_LATENCY_BOUNDS_MS: number[]` — `[10, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000]`

- [ ] **Step 1: Write the failing test**

```typescript
// src/test/metrics.test.ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsx --test src/test/metrics.test.ts`
Expected: FAIL — `../telemetry/metrics.js` does not exist.

- [ ] **Step 3: Implement `src/telemetry/metrics.ts`**

```typescript
import { VERSION } from "../version.js";
import type { AttrValue } from "./tracer.js";
import type { OtelMode } from "./tracer.js";
import { encodeMetricsSnapshot, postOtlp, type MetricPoint, type OtlpResource } from "./otlp.js";

/**
 * A small cumulative-aggregation metrics API, mirrored on the Tracer/Span
 * shape in tracer.ts. Kritya sessions are short CLI runs, so "cumulative for
 * the life of the process, flushed periodically" is simpler than delta
 * temporality and matches what Prometheus expects natively.
 */

export interface Counter {
  add(value: number, attributes?: Record<string, AttrValue>): void;
}

export interface Histogram {
  record(value: number, attributes?: Record<string, AttrValue>): void;
}

export interface Meter {
  counter(name: string): Counter;
  histogram(name: string, bounds?: number[]): Histogram;
  /** Export the current cumulative snapshot now. */
  flush(): void;
  /** Stop the periodic flush timer (call on shutdown so the process can exit). */
  stop(): void;
}

const NOOP_COUNTER: Counter = { add() {} };
const NOOP_HISTOGRAM: Histogram = { record() {} };
export const NOOP_METER: Meter = {
  counter: () => NOOP_COUNTER,
  histogram: () => NOOP_HISTOGRAM,
  flush() {},
  stop() {},
};

export const DEFAULT_LATENCY_BOUNDS_MS = [10, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000];

function nowUnixNano(): string {
  return (BigInt(Date.now()) * 1_000_000n).toString();
}

function attrKey(attributes: Record<string, AttrValue>): string {
  return JSON.stringify(Object.entries(attributes).sort(([a], [b]) => a.localeCompare(b)));
}

interface SumEntry {
  kind: "sum";
  attributes: Record<string, AttrValue>;
  value: number;
}

interface HistogramEntry {
  kind: "histogram";
  attributes: Record<string, AttrValue>;
  bounds: number[];
  bucketCounts: number[];
  count: number;
  sum: number;
}

class RealMeter implements Meter {
  private readonly startTimeUnixNano = nowUnixNano();
  private readonly sums = new Map<string, SumEntry>();
  private readonly histograms = new Map<string, HistogramEntry>();
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly endpoint: string,
    private readonly resource: OtlpResource,
    private readonly headers: Record<string, string> | undefined,
    flushIntervalMs: number
  ) {
    this.timer = setInterval(() => this.flush(), flushIntervalMs);
    this.timer.unref();
  }

  counter(name: string): Counter {
    return {
      add: (value, attributes = {}) => {
        const key = `${name}::${attrKey(attributes)}`;
        const existing = this.sums.get(key);
        if (existing) existing.value += value;
        else this.sums.set(key, { kind: "sum", attributes, value });
        this.namesByKey.set(key, name);
      },
    };
  }

  histogram(name: string, bounds: number[] = DEFAULT_LATENCY_BOUNDS_MS): Histogram {
    return {
      record: (value, attributes = {}) => {
        const key = `${name}::${attrKey(attributes)}`;
        let entry = this.histograms.get(key);
        if (!entry) {
          entry = {
            kind: "histogram",
            attributes,
            bounds,
            bucketCounts: new Array(bounds.length + 1).fill(0),
            count: 0,
            sum: 0,
          };
          this.histograms.set(key, entry);
        }
        entry.count += 1;
        entry.sum += value;
        const bucketIndex = bounds.findIndex((b) => value <= b);
        entry.bucketCounts[bucketIndex === -1 ? bounds.length : bucketIndex] += 1;
        this.namesByKey.set(key, name);
      },
    };
  }

  private readonly namesByKey = new Map<string, string>();

  flush(): void {
    const now = nowUnixNano();
    const points: MetricPoint[] = [];
    for (const [key, entry] of this.sums) {
      points.push({
        name: this.namesByKey.get(key)!,
        kind: "sum",
        attributes: entry.attributes,
        startTimeUnixNano: this.startTimeUnixNano,
        timeUnixNano: now,
        sumValue: entry.value,
        isMonotonic: true,
      });
    }
    for (const [key, entry] of this.histograms) {
      points.push({
        name: this.namesByKey.get(key)!,
        kind: "histogram",
        attributes: entry.attributes,
        startTimeUnixNano: this.startTimeUnixNano,
        timeUnixNano: now,
        histogram: {
          count: entry.count,
          sum: entry.sum,
          bucketCounts: entry.bucketCounts,
          explicitBounds: entry.bounds,
        },
      });
    }
    if (!points.length) return;
    postOtlp(
      this.endpoint,
      "/v1/metrics",
      encodeMetricsSnapshot(points, this.resource),
      this.headers
    );
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }
}

function parseOtlpHeaders(raw: string | undefined): Record<string, string> | undefined {
  if (!raw) return undefined;
  const headers: Record<string, string> = {};
  for (const pair of raw.split(",")) {
    const eq = pair.indexOf("=");
    if (eq === -1) continue;
    headers[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
  }
  return headers;
}

/** Metrics only exist when KRITYA_OTEL_ENDPOINT is set — there's no local file/console mode for them (unlike traces), since raw counters aren't useful to eyeball on disk. */
export function createMeter(
  sessionId: string,
  _configDefault?: OtelMode,
  flushIntervalMs = 10_000
): Meter {
  void sessionId;
  const endpoint = process.env.KRITYA_OTEL_ENDPOINT;
  if (!endpoint) return NOOP_METER;
  const resource: OtlpResource = {
    attributes: {
      "service.name": "kritya",
      "service.version": VERSION,
      "os.type": process.platform,
    },
  };
  return new RealMeter(
    endpoint,
    resource,
    parseOtlpHeaders(process.env.KRITYA_OTEL_HEADERS),
    flushIntervalMs
  );
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx tsx --test src/test/metrics.test.ts`
Expected: PASS (both tests)

- [ ] **Step 5: Commit**

```bash
git add src/telemetry/metrics.ts src/test/metrics.test.ts
git commit -m "feat(telemetry): add Meter (counters + histograms) with OTLP export"
```

---

### Task 4: Instrument tool calls and agent turns

**Files:**

- Modify: `src/agent/toolExecutor.ts:150-192` (the `logToolOutcome`/`finishSpan` area)
- Modify: `src/agent/loop.ts` (near `turnSpan` at line 430, and wherever token usage is already tallied for `/cost` — search for `tokenBudget`/usage tracking in the same file)
- Test: extend `src/test/toolExecutor.test.ts` if it exists, else add `src/test/toolExecutor-metrics.test.ts`

**Interfaces:**

- Consumes: `Meter`, `Counter`, `Histogram`, `NOOP_METER`, `DEFAULT_LATENCY_BOUNDS_MS` from `../telemetry/metrics.js`.
- Produces: `host.meter: Meter` field on the `toolExecutor` host object (mirrors the existing `host.tracer: Tracer`); `this.meter: Meter` field on the agent loop class (mirrors `this.tracer`).

- [ ] **Step 1: Check current host/loop shape before editing**

Run: `grep -n "tracer: Tracer\|host.tracer\|this.tracer" src/agent/toolExecutor.ts src/agent/loop.ts`

Confirm the exact field names before writing the diff below — `host.tracer` (toolExecutor.ts:69) and `this.tracer` (loop.ts:85) are the patterns to mirror with `meter`.

- [ ] **Step 2: Add a failing test asserting metrics are recorded on a tool call**

```typescript
// src/test/toolExecutor-metrics.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { NOOP_TRACER } from "../telemetry/tracer.js";
// Import whatever the toolExecutor test harness already uses to build a
// minimal `host` + invoke a tool — check src/test/toolExecutor.test.ts (if
// present) for the existing harness and reuse it rather than duplicating
// setup. Replace the placeholder below with that harness's real helper.
//
// import { buildTestHost, runTool } from "./helpers/toolExecutorHarness.js";

test("a successful tool call records a duration histogram and a calls counter", () => {
  const recordedHistograms: { name: string; value: number; attributes: any }[] = [];
  const recordedCounters: { name: string; value: number; attributes: any }[] = [];
  const meter = {
    counter: (name: string) => ({
      add: (value: number, attributes: any) => recordedCounters.push({ name, value, attributes }),
    }),
    histogram: (name: string) => ({
      record: (value: number, attributes: any) =>
        recordedHistograms.push({ name, value, attributes }),
    }),
    flush() {},
    stop() {},
  };

  // Wire `meter` into the same host shape toolExecutor.test.ts already
  // builds (host.tracer -> NOOP_TRACER, host.meter -> meter above), invoke a
  // trivial tool (e.g. an existing test double), then assert:
  assert.ok(NOOP_TRACER); // placeholder assertion until the real harness is wired in Step 2 of this task during implementation
  assert.equal(recordedHistograms.length, 0); // will become 1 once wired
  assert.equal(recordedCounters.length, 0); // will become 1 once wired
});
```

Because this repo's exact `toolExecutor` test harness (mock host/tool shape) isn't visible from this plan, the implementer's first real step is: `grep -n "buildTestHost\|function.*[Hh]ost" src/test/toolExecutor.test.ts` (or wherever tool-executor tests already live), reuse that exact harness, wire `meter` into the constructed host, invoke a real registered test tool, and assert on `recordedHistograms`/`recordedCounters` directly — replace the placeholder assertions above with real ones before calling this step done.

- [ ] **Step 3: Add `meter` to the `toolExecutor` host and record metrics in `logToolOutcome`**

In `src/agent/toolExecutor.ts`, near line 69 where `tracer: Tracer;` is declared on the host interface, add:

```typescript
meter: Meter;
```

Add the import at the top:

```typescript
import type { Meter } from "../telemetry/metrics.js";
```

In `logToolOutcome` (around line 181-189), add metric recording alongside the existing span/audit calls:

```typescript
const logToolOutcome = (outcome: ToolOutcome): void => {
  const now = Date.now();
  const durationMs = execStartedAt === undefined ? 0 : now - execStartedAt;
  const waitMs = (execStartedAt ?? now) - startedAt;
  span.setAttribute("kritya.duration_ms", durationMs);
  span.setAttribute("kritya.wait_ms", waitMs);
  span.setAttribute("kritya.outcome", outcome);
  host.audit?.logTool({ tool: name, summary, outcome, durationMs, waitMs });
  host.meter.histogram("kritya.tool.duration_ms").record(durationMs, { "kritya.tool": name });
  host.meter
    .counter("kritya.tool.calls")
    .add(1, { "kritya.tool": name, "kritya.outcome": outcome });
};
```

- [ ] **Step 4: Add `meter` to the agent loop and record turn duration**

In `src/agent/loop.ts`, near `tracer: Tracer = NOOP_TRACER;` (line 85), add:

```typescript
meter: Meter = NOOP_METER;
```

Add the import:

```typescript
import { NOOP_METER, type Meter } from "../telemetry/metrics.js";
```

Near where `turnSpan` is created (line 430) and wherever the loop already ends the turn span with a status (search `turnSpan.setStatus` in the same file), add immediately after the span-ending call:

```typescript
this.meter.histogram("kritya.turn.duration_ms").record(Date.now() - turnStartedAtMs);
```

using whatever `turnStartedAtMs` variable already exists near `turnSpan`'s creation (the pattern in `toolExecutor.ts:172`, `const startedAt = Date.now();`, is the one to mirror — if `loop.ts` doesn't already capture a start timestamp for the turn, add `const turnStartedAtMs = Date.now();` right next to the `turnSpan` creation).

Ensure every construction site of the tool-executor host (search `host.tracer` call sites / wherever the host object literal is built, likely in `loop.ts`) also passes `meter: this.meter` alongside the existing `tracer: this.tracer`.

- [ ] **Step 5: Run the full test suite**

Run: `npm run build && node scripts/run-tests.mjs`
Expected: PASS — existing tests still pass (NOOP_METER is a safe default matching NOOP_TRACER's precedent), and the new metrics test (once its harness placeholder from Step 2 is filled in with the real host builder) passes too.

- [ ] **Step 6: Commit**

```bash
git add src/agent/toolExecutor.ts src/agent/loop.ts src/test/toolExecutor-metrics.test.ts
git commit -m "feat(telemetry): record tool-call and turn-duration metrics"
```

---

### Task 5: Wire the session Meter into the CLI entrypoint and flush on shutdown

**Files:**

- Modify: `src/index.tsx:309-333`

**Interfaces:**

- Consumes: `createMeter` from `../telemetry/metrics.js`.
- Produces: session `meter` available to pass into the agent loop constructor/host builder alongside `sessionTracer`.

- [ ] **Step 1: Add the import**

```typescript
import { createMeter } from "./telemetry/metrics.js";
```

- [ ] **Step 2: Create the session meter next to the session tracer**

Immediately after `const sessionTracer = createTracer(session.id, config.otel);` (line 315), add:

```typescript
const sessionMeter = createMeter(session.id);
```

- [ ] **Step 3: Pass `sessionMeter` wherever `sessionTracer` is passed**

Run: `grep -n "sessionTracer" src/index.tsx` and pass `meter: sessionMeter` alongside every `tracer: sessionTracer` (or equivalent constructor argument) found — this is the same wiring pattern Task 4 established between `toolExecutor`'s host and `loop.ts`'s `this.tracer`/`this.meter`.

- [ ] **Step 4: Flush and stop the meter on shutdown**

In the `cleanup` function (line 327-332), add `sessionMeter.stop();` so the interval timer doesn't hold the process open longer than intended:

```typescript
const cleanup = () => {
  backgroundManager.killAll();
  lspManager.disposeAll();
  shutdownMcp();
  undoStack.closeAll();
  sessionMeter.flush();
  sessionMeter.stop();
};
```

`flush()` before `stop()` ensures the final cumulative snapshot (including any counts since the last 10s interval tick) goes out before the interval timer is cleared. Because `flush()` is fire-and-forget (via `postOtlp`), the request may not complete before the process actually exits — this is the same best-effort tradeoff every other sink in this codebase makes, and is fine for a metrics stream that self-heals on the next flush anyway.

- [ ] **Step 5: Verify manually**

Run: `KRITYA_OTEL_ENDPOINT=http://localhost:4318 npm run dev -- --help` (or start a real session) and confirm no crash/exception with the endpoint unreachable (best-effort behavior).

- [ ] **Step 6: Commit**

```bash
git add src/index.tsx
git commit -m "feat(telemetry): create and flush the session Meter alongside the session Tracer"
```

---

### Task 6: Docker-free collector, Prometheus, Grafana config + docs

**Files:**

- Create: `observability/otelcol-config.yaml`
- Create: `observability/prometheus.yml`
- Create: `observability/grafana/provisioning/datasources/prometheus.yml`
- Create: `observability/grafana/provisioning/dashboards/dashboards.yml`
- Create: `observability/grafana/provisioning/dashboards/kritya.json`
- Create: `docs/observability.md`

No code/tests in this task — verification is running the real binaries and checking data flows end to end.

- [ ] **Step 1: Collector config — routes traces to Phoenix, metrics to Prometheus**

```yaml
# observability/otelcol-config.yaml
receivers:
  otlp:
    protocols:
      http:
        endpoint: 0.0.0.0:4318

exporters:
  otlphttp/phoenix:
    endpoint: http://localhost:6006/v1/traces
    tls:
      insecure: true
  prometheus:
    endpoint: 0.0.0.0:8889

processors:
  batch: {}

service:
  pipelines:
    traces:
      receivers: [otlp]
      processors: [batch]
      exporters: [otlphttp/phoenix]
    metrics:
      receivers: [otlp]
      processors: [batch]
      exporters: [prometheus]
```

- [ ] **Step 2: Prometheus scrape config — pulls from the collector's Prometheus exporter**

```yaml
# observability/prometheus.yml
global:
  scrape_interval: 10s

scrape_configs:
  - job_name: kritya-otel-collector
    static_configs:
      - targets: ["localhost:8889"]
```

- [ ] **Step 3: Grafana datasource + dashboard provisioning**

```yaml
# observability/grafana/provisioning/datasources/prometheus.yml
apiVersion: 1
datasources:
  - name: Prometheus
    type: prometheus
    access: proxy
    url: http://localhost:9090
    isDefault: true
```

```yaml
# observability/grafana/provisioning/dashboards/dashboards.yml
apiVersion: 1
providers:
  - name: kritya
    type: file
    options:
      path: /etc/grafana/provisioning/dashboards
```

```json
// observability/grafana/provisioning/dashboards/kritya.json
{
  "title": "Kritya",
  "uid": "kritya-overview",
  "timezone": "browser",
  "panels": [
    {
      "id": 1,
      "title": "Tool calls / min",
      "type": "timeseries",
      "gridPos": { "h": 8, "w": 12, "x": 0, "y": 0 },
      "targets": [{ "expr": "sum(rate(kritya_tool_calls_total[1m])) by (kritya_tool)" }]
    },
    {
      "id": 2,
      "title": "Tool error rate",
      "type": "timeseries",
      "gridPos": { "h": 8, "w": 12, "x": 12, "y": 0 },
      "targets": [
        {
          "expr": "sum(rate(kritya_tool_calls_total{kritya_outcome!=\"ok\"}[5m])) / sum(rate(kritya_tool_calls_total[5m]))"
        }
      ]
    },
    {
      "id": 3,
      "title": "Tool call latency p95 (ms)",
      "type": "timeseries",
      "gridPos": { "h": 8, "w": 12, "x": 0, "y": 8 },
      "targets": [
        {
          "expr": "histogram_quantile(0.95, sum(rate(kritya_tool_duration_ms_bucket[5m])) by (le, kritya_tool))"
        }
      ]
    },
    {
      "id": 4,
      "title": "Turn duration p95 (ms)",
      "type": "timeseries",
      "gridPos": { "h": 8, "w": 12, "x": 12, "y": 8 },
      "targets": [
        {
          "expr": "histogram_quantile(0.95, sum(rate(kritya_turn_duration_ms_bucket[5m])) by (le))"
        }
      ]
    }
  ],
  "schemaVersion": 39,
  "version": 1
}
```

- [ ] **Step 4: Write the setup walkthrough**

```markdown
<!-- docs/observability.md -->

# Observability: local traces + metrics (no Docker required)

Kritya can export OTel-shaped traces and metrics to a local OpenTelemetry
Collector, which fans traces to [Phoenix](https://github.com/Arize-ai/phoenix)
and metrics to Prometheus/Grafana. Every piece below runs as a plain binary —
no Docker.

## 1. Install the three backends

**Phoenix** (traces):
\`\`\`bash
pip install arize-phoenix
phoenix serve # listens on http://localhost:6006, OTLP ingest on /v1/traces
\`\`\`

**Prometheus** (metrics storage):
Download a binary for your OS from https://prometheus.io/download/, then:
\`\`\`bash
./prometheus --config.file=observability/prometheus.yml
\`\`\`

**Grafana** (dashboards + alerting):
Install via your OS package manager (e.g. `brew install grafana` /
`apt install grafana`), then run it pointed at the provisioning directory in
this repo:
\`\`\`bash
GF_PATHS_PROVISIONING=observability/grafana/provisioning grafana-server

# UI at http://localhost:3000 (default admin/admin)

\`\`\`

## 2. Install and run the OTel Collector

Download `otelcol` (core distribution is enough — no contrib components
used) from
https://github.com/open-telemetry/opentelemetry-collector-releases/releases
for your OS/arch, then:
\`\`\`bash
./otelcol --config observability/otelcol-config.yaml
\`\`\`
This listens for OTLP/HTTP on `localhost:4318`, forwards traces to Phoenix,
and exposes metrics on `localhost:8889` for Prometheus to scrape.

## 3. Point Kritya at the collector

\`\`\`bash
export KRITYA_OTEL=off # skip the local file/console sink; OTLP-only
export KRITYA_OTEL_ENDPOINT=http://localhost:4318
kritya
\`\`\`

Use a real session (a few tool calls) and then:

- Open http://localhost:6006 — Phoenix shows the trace, with each tool call
  as a nested span.
- Open http://localhost:3000 — the "Kritya" dashboard shows tool call rate,
  error rate, and p95 latency once Prometheus has scraped a few intervals
  (10s, per `observability/prometheus.yml`).

## Why three separate tools instead of one

- **Phoenix** — inspects individual traces: exactly what a tool call
  received and returned, useful for debugging one run.
- **Prometheus + Grafana** — aggregates across many runs: rate, error %,
  latency trends, and alerting. Traces don't answer "is this getting worse
  over time" well; metrics do.
- **The Collector** — decouples Kritya from both. Kritya always speaks OTLP
  to one local endpoint; adding, removing, or swapping a backend is a
  collector config change, not a Kritya code change.
```

- [ ] **Step 5: Manual end-to-end verification**

Run all four processes (Phoenix, Prometheus, Grafana, otelcol) per the doc, then run a real Kritya session with `KRITYA_OTEL_ENDPOINT` set and confirm:

1. Phoenix UI (`localhost:6006`) shows the session's trace tree.
2. `curl localhost:8889/metrics | grep kritya_tool_calls_total` shows non-zero counts.
3. Grafana (`localhost:3000`) → Kritya dashboard renders all 4 panels with data.

- [ ] **Step 6: Commit**

```bash
git add observability docs/observability.md
git commit -m "docs(observability): add Docker-free Phoenix + Prometheus + Grafana setup"
```

---

## Self-Review Notes

- **Spec coverage**: OTLP exporter (Task 1-2), metrics not just traces (Task 3-4), collector fan-out to Phoenix + Prometheus (Task 6), Grafana dashboards/alerting groundwork (Task 6 — alert rules themselves are a follow-up once real latency baselines exist, intentionally out of scope for this first pass), Docker-free (Task 6 uses raw binaries throughout). Resource attributes (service.name/version/os) are covered in Task 2/3. Sampling and a local terminal trace viewer from the earlier discussion are explicitly **not** in this plan — flag as follow-up if wanted.
- **Placeholder scan**: Task 4's Step 2 test and Step 1 grep are intentionally exploratory (the exact test harness for `toolExecutor.ts` isn't visible from outside the repo tree at plan-writing time) — this is flagged inline as the implementer's first real action, not left as a silent TODO, and Steps 3-4 give the actual, complete code to add regardless of harness shape.
- **Type consistency**: `Meter`/`Counter`/`Histogram` names and signatures are identical between Task 3's definition and Tasks 4-5's usage (`host.meter: Meter`, `this.meter: Meter`, `createMeter(sessionId)`). `MetricPoint`/`OtlpResource` names match between Task 1 and Task 3.
