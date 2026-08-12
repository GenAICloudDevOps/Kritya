import assert from "node:assert/strict";
import { test } from "node:test";
import { APIError } from "openai";
import {
  isContextOverflowError,
  isRetryable,
  ProviderClient,
  retryAfterMs,
  StreamIdleError,
} from "../provider/client.js";

interface FakeChunk {
  choices?: [{ delta: Record<string, unknown> }];
}

const noopCallbacks = { onTextDelta() {}, onReasoningDelta() {} };

/** Replace the SDK instance with one whose `create` runs `impl`. */
function withCreate(client: ProviderClient, impl: () => unknown): ProviderClient {
  (client as unknown as { client: { chat: { completions: { create: unknown } } } }).client = {
    chat: { completions: { create: async () => impl() } },
  };
  return client;
}

function errWith(props: Record<string, unknown>, message = "boom"): Error {
  return Object.assign(new Error(message), props);
}

test("isRetryable covers undici and stream-close transport codes", () => {
  assert.equal(isRetryable(errWith({ code: "UND_ERR_SOCKET" })), true);
  assert.equal(isRetryable(errWith({ code: "ERR_STREAM_PREMATURE_CLOSE" })), true);
  assert.equal(isRetryable(errWith({ code: "ECONNREFUSED" })), true);
  assert.equal(isRetryable(errWith({ code: "EPIPE" })), true);
  // undici hides the real code one level down under `cause`.
  assert.equal(isRetryable(errWith({ cause: { code: "UND_ERR_CONNECT_TIMEOUT" } })), true);
  // SDK error classes are recognized by name, having no numeric status.
  assert.equal(isRetryable(errWith({ name: "APIConnectionError" })), true);
  assert.equal(isRetryable(new StreamIdleError(60_000)), true);
});

test("isRetryable still refuses hard failures", () => {
  assert.equal(isRetryable(errWith({ status: 400 })), false);
  assert.equal(isRetryable(errWith({ status: 401 })), false);
  // A 404 that carries a body is a real "no such model" — fail fast.
  assert.equal(isRetryable(errWith({ status: 404 })), false);
  assert.equal(isRetryable(errWith({ code: "ENOENT" })), false);
  assert.equal(isRetryable(new Error("plain")), false);
});

test("isRetryable retries an empty-bodied 404 but not one that reports a reason", () => {
  // NVIDIA's gateway intermittently 404s with nothing in the body for a model
  // that is fine; the same request succeeds on retry.
  assert.equal(isRetryable(errWith({ status: 404 }, "404 status code (no body)")), true);
  // Both real "no such model" shapes carry a body, and must still fail fast:
  // that gateway's plain text, and an OpenAI-compatible JSON error.
  assert.equal(isRetryable(errWith({ status: 404 }, "404 404 page not found")), false);
  assert.equal(isRetryable(errWith({ status: 404 }, "404 The model does not exist")), false);
  // Only 404 gets this treatment — an empty 401 is still a hard failure.
  assert.equal(isRetryable(errWith({ status: 401 }, "401 status code (no body)")), false);
});

test("the empty-body 404 message this keys off is the one the SDK actually produces", () => {
  // isRetryable can only see the message the SDK synthesizes when there was no
  // body to parse. Generating a real error here means an SDK rewording fails
  // this test rather than silently turning the retry back off.
  const err = APIError.generate(404, undefined, undefined, new Headers()) as Error & {
    status?: number;
  };
  assert.equal(err.status, 404);
  assert.equal(err.message, "404 status code (no body)");
  assert.equal(isRetryable(err), true);

  // ...and the same generator with a body still produces a non-retryable error.
  const withBody = APIError.generate(
    404,
    { error: { message: "The model does not exist" } },
    undefined,
    new Headers()
  );
  assert.equal(isRetryable(withBody), false);
});

test("isRetryable treats 408 like the other transient statuses", () => {
  assert.equal(isRetryable(errWith({ status: 408 })), true);
  assert.equal(isRetryable(errWith({ status: 429 })), true);
  assert.equal(isRetryable(errWith({ status: 503 })), true);
});

test("retryAfterMs reads delay-seconds and HTTP-date forms, from either header shape", () => {
  assert.equal(retryAfterMs(errWith({ headers: { "retry-after": "2" } })), 2000);
  // Header names are case-insensitive on a plain object too.
  assert.equal(retryAfterMs(errWith({ headers: { "Retry-After": "2" } })), 2000);
  // A Headers-like object with .get().
  const headers = { get: (k: string) => (k === "retry-after" ? "3" : null) };
  assert.equal(retryAfterMs(errWith({ headers })), 3000);

  const date = new Date(Date.now() + 5000).toUTCString();
  const fromDate = retryAfterMs(errWith({ headers: { "retry-after": date } }));
  assert.ok(fromDate && fromDate > 3000 && fromDate <= 5000, `got ${fromDate}`);
});

test("retryAfterMs ignores absent, past, and unparseable values, and caps very long waits", () => {
  assert.equal(retryAfterMs(errWith({})), undefined);
  assert.equal(retryAfterMs(errWith({ headers: {} })), undefined);
  assert.equal(retryAfterMs(errWith({ headers: { "retry-after": "later" } })), undefined);
  assert.equal(retryAfterMs(errWith({ headers: { "retry-after": "0" } })), undefined);
  assert.equal(retryAfterMs(errWith({ headers: { "retry-after": "-5" } })), undefined);
  // A provider asking for an hour doesn't get one.
  assert.equal(retryAfterMs(errWith({ headers: { "retry-after": "3600" } })), 60_000);
});

test("isContextOverflowError separates a too-long prompt from other 400s", () => {
  assert.equal(
    isContextOverflowError(errWith({ status: 400, code: "context_length_exceeded" })),
    true
  );
  assert.equal(
    isContextOverflowError(
      errWith({ status: 400 }, "This model's maximum context length is 128000 tokens")
    ),
    true
  );
  assert.equal(isContextOverflowError(errWith({ status: 413 }, "prompt is too long")), true);
  assert.equal(isContextOverflowError(errWith({ status: 400 }, "invalid tool schema")), false);
  assert.equal(isContextOverflowError(errWith({ status: 401 }, "context length")), false);
});

test("an empty-bodied 404 mid-conversation is retried instead of killing the turn", async () => {
  let attempts = 0;
  async function* healthy(): AsyncGenerator<FakeChunk> {
    yield { choices: [{ delta: { content: "recovered" } }] };
  }
  const client = withCreate(new ProviderClient("fake-key"), () => {
    if (++attempts === 1) throw APIError.generate(404, undefined, undefined, new Headers());
    return healthy();
  });

  const retries: number[] = [];
  const result = await client.chat("m", [], [], {
    ...noopCallbacks,
    onRetry: (attempt) => retries.push(attempt),
  });

  assert.equal(attempts, 2, "the blip was re-issued rather than surfaced");
  assert.equal(retries.length, 1, "the retry was reported to the caller");
  assert.equal(result.text, "recovered");
});

test("a 404 that names a reason still fails the turn immediately", async () => {
  let attempts = 0;
  const client = withCreate(new ProviderClient("fake-key"), () => {
    attempts++;
    throw APIError.generate(
      404,
      { error: { message: "The model does not exist" } },
      undefined,
      new Headers()
    );
  });

  await assert.rejects(() => client.chat("m", [], [], noopCallbacks));
  assert.equal(attempts, 1, "a genuine bad model is not retried four times");
});

test("a stream that opens and then goes silent is abandoned and retried, not hung", async () => {
  let attempts = 0;
  const aborted: boolean[] = [];

  // First attempt yields one chunk and then stalls forever; second succeeds.
  const stalling = (): AsyncIterable<FakeChunk> & { controller: AbortController } => {
    const controller = new AbortController();
    controller.signal.addEventListener("abort", () => aborted.push(true));
    return {
      controller,
      async *[Symbol.asyncIterator]() {
        yield { choices: [{ delta: { content: "partial" } }] };
        // Unref'd so a stalled attempt can never keep the process alive.
        await new Promise((resolve) => setTimeout(resolve, 60_000).unref());
        yield { choices: [{ delta: { content: "never arrives" } }] };
      },
    };
  };

  async function* healthy(): AsyncGenerator<FakeChunk> {
    yield { choices: [{ delta: { content: "recovered" } }] };
  }

  // 250ms rather than something tighter: a loaded CI runner can stall the
  // event loop for tens of milliseconds, and this test must fail only when the
  // watchdog is broken — never because the machine was busy.
  const client = withCreate(
    new ProviderClient("fake-key", undefined, {}, { streamIdleTimeoutMs: 250 }),
    () => (++attempts === 1 ? stalling() : healthy())
  );

  const retries: number[] = [];
  const result = await client.chat("m", [], [], {
    ...noopCallbacks,
    onRetry: (attempt) => retries.push(attempt),
  });

  // The guarantee is behavioral, so the assertions are too: the stall was
  // given up on, something was retried, the dead stream was aborted, and the
  // answer came from the healthy attempt. Exactly how many attempts that took
  // is the runner's business, not the watchdog's.
  assert.ok(attempts >= 2, `the stalled attempt was abandoned and re-issued (got ${attempts})`);
  assert.ok(retries.length >= 1, "the retry was reported to the caller");
  assert.equal(result.text, "recovered", "the retry's text replaces the partial one");
  assert.ok(aborted.length >= 1, "the abandoned stream was aborted, not left in flight");
});

test("a stream that keeps producing is never cut off by the idle timeout", async () => {
  async function* slowButAlive(): AsyncGenerator<FakeChunk> {
    for (const word of ["a", "b", "c", "d"]) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      yield { choices: [{ delta: { content: word } }] };
    }
  }
  // A wide margin between the per-chunk gap (10ms) and the idle timeout (1s):
  // the point being tested is that the watchdog measures the gap between
  // chunks and not the total duration, which needs no tight timing to show.
  const client = withCreate(
    new ProviderClient("fake-key", undefined, {}, { streamIdleTimeoutMs: 1000 }),
    slowButAlive
  );

  const retries: number[] = [];
  const result = await client.chat("m", [], [], {
    ...noopCallbacks,
    onRetry: (attempt) => retries.push(attempt),
  });

  assert.equal(result.text, "abcd");
  assert.deepEqual(retries, [], "a healthy stream is never abandoned mid-answer");
});

test("complete returns the assistant text from a non-streaming completion", async () => {
  const client = new ProviderClient("test-key", "https://example.test/v1");
  let seenArgs: unknown;
  (client as unknown as { client: { chat: { completions: { create: unknown } } } }).client = {
    chat: {
      completions: {
        create: async (args: unknown) => {
          seenArgs = args;
          return {
            model: "test-model",
            choices: [{ message: { content: "hello from the model" }, finish_reason: "stop" }],
          };
        },
      },
    },
  };

  const result = await client.complete("test-model", [{ role: "user", content: "hi" }]);

  assert.deepEqual(result, {
    text: "hello from the model",
    model: "test-model",
    stopReason: "stop",
  });
  assert.equal((seenArgs as { model: string }).model, "test-model");
  assert.equal((seenArgs as { stream: boolean }).stream, false);
});

test("complete throws when the provider returns no choices", async () => {
  const client = new ProviderClient("test-key", "https://example.test/v1");
  (client as unknown as { client: { chat: { completions: { create: unknown } } } }).client = {
    chat: { completions: { create: async () => ({ model: "m", choices: [] }) } },
  };

  await assert.rejects(
    () => client.complete("m", [{ role: "user", content: "hi" }]),
    /provider returned no completion/i
  );
});
