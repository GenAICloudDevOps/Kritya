import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { CONFIG_DIR } from "../config/config.js";
import { hardenWindowsDir } from "../config/winAcl.js";
import { debugLog } from "../config/debug.js";

/**
 * A minimal, dependency-free tracer for the agent's tool loop, shaped after
 * the OpenTelemetry data model (128-bit trace ids, 64-bit span ids, a parent
 * link, attributes, events, and a status). Spans are emitted as OTLP-style
 * JSON — one span per line — to a local file and/or the console. Nothing is
 * sent off the machine.
 *
 * Why not the @opentelemetry/* SDK? This project is deliberately lean, and the
 * requirement here is local-only visibility, not a wire to a hosted backend.
 * The emitted records use OTel field names (traceId/spanId/parentSpanId/
 * startTimeUnixNano/…), so a real OTLP exporter can be dropped in later
 * without changing the call sites in the loop.
 *
 * Enabled by the KRITYA_OTEL env var: "file" (default path under
 * ~/.kritya/telemetry), "console" (stderr), "both", or unset/"off" (a no-op
 * tracer with zero overhead). KRITYA_OTEL_FILE overrides the file path.
 */

export type SpanStatusCode = "OK" | "ERROR" | "UNSET";
export type AttrValue = string | number | boolean;

export interface SpanExport {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: Record<string, AttrValue>;
  status: { code: SpanStatusCode; message?: string };
  events: { name: string; timeUnixNano: string; attributes?: Record<string, AttrValue> }[];
}

export interface Span {
  readonly traceId: string;
  readonly spanId: string;
  setAttribute(key: string, value: AttrValue): this;
  addEvent(name: string, attributes?: Record<string, AttrValue>): this;
  setStatus(code: SpanStatusCode, message?: string): this;
  end(): void;
}

export interface Tracer {
  /** Start a span. Pass a parent to nest it; omit for a new trace root. */
  startSpan(name: string, opts?: { parent?: Span; attributes?: Record<string, AttrValue> }): Span;
}

function nowUnixNano(): string {
  // ms resolution is all we can portably get; scale to nanoseconds so the
  // field matches the OTel schema consumers expect.
  return (BigInt(Date.now()) * 1_000_000n).toString();
}

const NOOP_SPAN: Span = {
  traceId: "",
  spanId: "",
  setAttribute() {
    return this;
  },
  addEvent() {
    return this;
  },
  setStatus() {
    return this;
  },
  end() {},
};

/** A tracer that does nothing — used when telemetry is disabled. */
export const NOOP_TRACER: Tracer = {
  startSpan() {
    return NOOP_SPAN;
  },
};

type Sink = (span: SpanExport) => void;

class RealSpan implements Span {
  readonly traceId: string;
  readonly spanId: string;
  private readonly parentSpanId?: string;
  private readonly name: string;
  private readonly start: string;
  private readonly attributes: Record<string, AttrValue>;
  private readonly events: SpanExport["events"] = [];
  private status: { code: SpanStatusCode; message?: string } = { code: "UNSET" };
  private ended = false;

  constructor(
    name: string,
    traceId: string,
    parentSpanId: string | undefined,
    attributes: Record<string, AttrValue>,
    private readonly sink: Sink
  ) {
    this.name = name;
    this.traceId = traceId;
    this.spanId = crypto.randomBytes(8).toString("hex");
    this.parentSpanId = parentSpanId;
    this.attributes = { ...attributes };
    this.start = nowUnixNano();
  }

  setAttribute(key: string, value: AttrValue): this {
    this.attributes[key] = value;
    return this;
  }

  addEvent(name: string, attributes?: Record<string, AttrValue>): this {
    this.events.push({ name, timeUnixNano: nowUnixNano(), attributes });
    return this;
  }

  setStatus(code: SpanStatusCode, message?: string): this {
    this.status = { code, message };
    return this;
  }

  end(): void {
    if (this.ended) return; // ending twice would double-emit
    this.ended = true;
    this.sink({
      traceId: this.traceId,
      spanId: this.spanId,
      parentSpanId: this.parentSpanId,
      name: this.name,
      startTimeUnixNano: this.start,
      endTimeUnixNano: nowUnixNano(),
      attributes: this.attributes,
      status: this.status,
      events: this.events,
    });
  }
}

class RealTracer implements Tracer {
  constructor(private readonly sink: Sink) {}

  startSpan(name: string, opts?: { parent?: Span; attributes?: Record<string, AttrValue> }): Span {
    const parent = opts?.parent;
    // Children inherit the parent's trace id; roots mint a new one.
    const traceId =
      parent && parent.traceId ? parent.traceId : crypto.randomBytes(16).toString("hex");
    const parentSpanId = parent && parent.spanId ? parent.spanId : undefined;
    return new RealSpan(name, traceId, parentSpanId, opts?.attributes ?? {}, this.sink);
  }
}

/**
 * KRITYA_TELEMETRY_DIR overrides it — used by tests so cleanupOldTelemetry's
 * directory scan never touches the real ~/.kritya/telemetry on a dev machine.
 */
function telemetryDir(): string {
  return process.env.KRITYA_TELEMETRY_DIR || path.join(CONFIG_DIR, "telemetry");
}

type OtelMode = "off" | "file" | "console" | "both";

/** KRITYA_OTEL if set, else config.json's persisted `otel` default, else "off". */
function resolveOtelMode(configDefault?: OtelMode): string {
  return (process.env.KRITYA_OTEL ?? configDefault ?? "off").toLowerCase();
}

/**
 * Where this session's spans are written, or undefined when no file sink is
 * active. Exported so callers that report results (headless JSON) can point
 * the reader at the trace without duplicating the path logic.
 */
export function telemetryFileFor(sessionId: string, configDefault?: OtelMode): string | undefined {
  const mode = resolveOtelMode(configDefault);
  if (mode === "off" || mode === "" || mode === "false") return undefined;
  // "console" is the only enabled mode with no file behind it.
  if (mode === "console") return undefined;
  return process.env.KRITYA_OTEL_FILE ?? path.join(telemetryDir(), `${sessionId}.otel.jsonl`);
}

/**
 * Delete telemetry span files older than `retentionDays`. Best-effort, same
 * pattern as SessionStore.cleanupOldSessions and AuditLog.cleanupOld. 0 or
 * negative means "keep forever" — auto-delete disabled.
 */
export function cleanupOldTelemetry(retentionDays: number): void {
  if (retentionDays <= 0) return;
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  let files: string[];
  try {
    files = fs.readdirSync(telemetryDir()).filter((f) => f.endsWith(".otel.jsonl"));
  } catch {
    return;
  }
  for (const f of files) {
    const file = path.join(telemetryDir(), f);
    try {
      if (fs.statSync(file).mtimeMs < cutoff) fs.unlinkSync(file);
    } catch (err) {
      debugLog(`cleanupOldTelemetry(${file})`, err);
    }
  }
}

function fileSink(file: string): Sink {
  let ready = false;
  return (span) => {
    try {
      if (!ready) {
        fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
        hardenWindowsDir(telemetryDir());
        ready = true;
      }
      fs.appendFileSync(file, JSON.stringify(span) + "\n", { mode: 0o600 });
    } catch (err) {
      // best-effort: telemetry must never crash a turn
      debugLog(`tracer.fileSink(${file})`, err);
    }
  };
}

function consoleSink(): Sink {
  return (span) => {
    try {
      process.stderr.write(`[otel] ${JSON.stringify(span)}\n`);
    } catch {
      // best-effort
    }
  };
}

/**
 * Build the tracer configured by the environment for this session. Returns the
 * shared no-op tracer when telemetry is off, so callers can always hold a
 * Tracer and call startSpan unconditionally.
 */
export function createTracer(sessionId: string, configDefault?: OtelMode): Tracer {
  const mode = resolveOtelMode(configDefault);
  if (mode === "off" || mode === "" || mode === "false") return NOOP_TRACER;

  const sinks: Sink[] = [];
  if (mode === "file" || mode === "both") {
    sinks.push(fileSink(telemetryFileFor(sessionId, configDefault)!));
  }
  if (mode === "console" || mode === "both") {
    sinks.push(consoleSink());
  }
  if (!sinks.length) {
    // Unrecognized value (e.g. "1", "on"): default to a file, which is the
    // useful local-only behavior, rather than silently doing nothing.
    sinks.push(fileSink(path.join(telemetryDir(), `${sessionId}.otel.jsonl`)));
  }

  const sink: Sink = sinks.length === 1 ? sinks[0] : (span) => sinks.forEach((s) => s(span));
  return new RealTracer(sink);
}
