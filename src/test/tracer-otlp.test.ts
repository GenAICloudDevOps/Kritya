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

test("KRITYA_OTEL_HEADERS parses Key=Value pairs and skips malformed ones", async () => {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: any) => {
    calls.push({ url, headers: init.headers });
    return new Response("", { status: 200 });
  }) as typeof fetch;

  try {
    await withEnv(
      {
        KRITYA_OTEL: undefined,
        KRITYA_OTEL_ENDPOINT: "http://localhost:4318",
        KRITYA_OTEL_HEADERS: "Authorization=Bearer abc, X-Foo = bar,malformed-no-equals,Empty=",
      },
      () => {
        const tracer = createTracer("sess-otlp-headers");
        tracer.startSpan("x").end();
      }
    );
    await new Promise((r) => setTimeout(r, 0));
  } finally {
    globalThis.fetch = realFetch;
  }

  assert.equal(calls.length, 1);
  assert.equal(calls[0].headers.Authorization, "Bearer abc");
  assert.equal(calls[0].headers["X-Foo"], "bar");
  assert.equal(calls[0].headers.Empty, "");
  assert.equal(calls[0].headers["malformed-no-equals"], undefined);
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
