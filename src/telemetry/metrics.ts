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
  private readonly namesByKey = new Map<string, string>();
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

  flush(): void {
    // Best-effort like every other telemetry path: a bad snapshot or a down
    // collector must never throw into the caller (setInterval callback here
    // has no caller to catch it, so an uncaught error would crash the process).
    try {
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
    } catch {
      // best-effort: metrics must never crash the process
    }
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

export type { OtelMode };

/**
 * Build the meter configured by the environment for this session. Metrics
 * only exist when KRITYA_OTEL_ENDPOINT is set — there's no local file/console
 * mode for them (unlike traces), since raw counters aren't useful to eyeball
 * on disk the way a span log is. Returns the shared no-op meter otherwise, so
 * callers can always hold a Meter and call counter()/histogram() unconditionally.
 */
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
