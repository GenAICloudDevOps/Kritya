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

/**
 * Same as postOtlp, but awaits the request instead of firing-and-forgetting.
 * Used by shutdown paths that want to give the last export a chance to
 * actually complete before the process exits — callers are expected to race
 * this against a short timeout themselves (a hung network call must never
 * block process shutdown indefinitely).
 */
export async function postOtlpAndWait(
  endpoint: string,
  path: "/v1/traces" | "/v1/metrics",
  body: unknown,
  headers?: Record<string, string>
): Promise<void> {
  try {
    await fetch(`${endpoint.replace(/\/+$/, "")}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(headers ?? {}) },
      body: JSON.stringify(body),
    });
  } catch (err) {
    debugLog(`postOtlpAndWait(${path})`, err);
  }
}
