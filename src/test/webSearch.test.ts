import assert from "node:assert/strict";
import { test, afterEach } from "node:test";
import { parseMaxResults, tavilyRaw } from "../tools/webSearch.js";

test("parseMaxResults defaults to 5 when max_results is omitted", () => {
  assert.equal(parseMaxResults(undefined), 5);
});

test("parseMaxResults preserves an explicit 0 instead of defaulting", () => {
  assert.equal(parseMaxResults(0), 0);
});

test("parseMaxResults passes through explicit positive values", () => {
  assert.equal(parseMaxResults(3), 3);
});

const realFetch = globalThis.fetch;
const realKey = process.env.TAVILY_API_KEY;

/** Capture the request body Tavily would receive, without making a real call. */
function stubFetch(): { body: () => Record<string, unknown> } {
  let captured: Record<string, unknown> = {};
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    captured = JSON.parse(String(init?.body ?? "{}"));
    return {
      ok: true,
      json: async () => ({ answer: "ok", results: [] }),
    } as unknown as Response;
  }) as typeof fetch;
  return { body: () => captured };
}

afterEach(() => {
  globalThis.fetch = realFetch;
  if (realKey === undefined) delete process.env.TAVILY_API_KEY;
  else process.env.TAVILY_API_KEY = realKey;
});

test("tavilyRaw applies a recency window as news topic + days", async () => {
  process.env.TAVILY_API_KEY = "test-key";
  const stub = stubFetch();
  await tavilyRaw("anthropic news", 5, { days: 7 });
  const body = stub.body();
  assert.equal(body.topic, "news");
  assert.equal(body.days, 7);
});

test("tavilyRaw floors and clamps a fractional/zero recency window", async () => {
  process.env.TAVILY_API_KEY = "test-key";
  const stub = stubFetch();
  await tavilyRaw("q", 5, { days: 0.9 });
  assert.equal(stub.body().days, 1);
});

test("tavilyRaw omits recency params for a timeless query", async () => {
  process.env.TAVILY_API_KEY = "test-key";
  const stub = stubFetch();
  await tavilyRaw("how does tcp work", 5);
  const body = stub.body();
  assert.equal("days" in body, false);
  assert.equal("topic" in body, false);
});

test("tavilyRaw throws a clear error when the API key is missing", async () => {
  delete process.env.TAVILY_API_KEY;
  await assert.rejects(() => tavilyRaw("q"), /TAVILY_API_KEY is not set/);
});
