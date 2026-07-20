import assert from "node:assert/strict";
import { test } from "node:test";
import { ProviderClient, RetryExhaustedError } from "../provider/client.js";
import type { ChatMessage } from "../types.js";

/** Minimal shape of an OpenAI streaming chunk, as consumed by chatOnce. */
interface FakeChunk {
  choices?: [{ delta: Record<string, unknown> }];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    prompt_tokens_details?: { cached_tokens?: number };
  };
}

async function* fakeStream(chunks: FakeChunk[]): AsyncGenerator<FakeChunk> {
  for (const chunk of chunks) yield chunk;
}

/** Builds a ProviderClient whose underlying OpenAI stream is replaced with `chunks`. */
function clientWithStream(chunks: FakeChunk[]): ProviderClient {
  const client = new ProviderClient("fake-key");
  // The OpenAI SDK instance is a private field at compile time only;
  // swap its `create` method to avoid any real network call.
  (client as unknown as { client: { chat: { completions: { create: unknown } } } }).client = {
    chat: { completions: { create: async () => fakeStream(chunks) } },
  };
  return client;
}

const noopCallbacks = { onTextDelta() {}, onReasoningDelta() {} };

test("chatOnce assembles tool call arguments split across chunks", async () => {
  const client = clientWithStream([
    {
      choices: [
        {
          delta: {
            tool_calls: [
              { index: 0, id: "call_1", function: { name: "read_", arguments: '{"pa' } },
            ],
          },
        },
      ],
    },
    {
      choices: [
        {
          delta: {
            tool_calls: [{ index: 0, function: { name: "file", arguments: 'th":"a.ts"}' } }],
          },
        },
      ],
    },
  ]);

  const result = await client.chat("m", [], [], noopCallbacks);

  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.toolCalls[0].id, "call_1");
  assert.equal(result.toolCalls[0].name, "read_file");
  assert.deepEqual(JSON.parse(result.toolCalls[0].argsJson), { path: "a.ts" });
});

test("chatOnce orders tool calls by index even if chunks arrive out of order", async () => {
  const client = clientWithStream([
    {
      choices: [
        {
          delta: {
            tool_calls: [{ index: 1, id: "call_b", function: { name: "second", arguments: "{}" } }],
          },
        },
      ],
    },
    {
      choices: [
        {
          delta: {
            tool_calls: [{ index: 0, id: "call_a", function: { name: "first", arguments: "{}" } }],
          },
        },
      ],
    },
  ]);

  const result = await client.chat("m", [], [], noopCallbacks);

  assert.deepEqual(
    result.toolCalls.map((c) => c.name),
    ["first", "second"]
  );
});

test("chatOnce leaves usage undefined when the provider never sends it", async () => {
  const client = clientWithStream([{ choices: [{ delta: { content: "hi" } }] }]);

  const result = await client.chat("m", [], [], noopCallbacks);

  assert.equal(result.usage, undefined);
  assert.equal(result.text, "hi");
});

test("chatOnce captures usage when present on any chunk", async () => {
  const client = clientWithStream([
    { choices: [{ delta: { content: "hi" } }] },
    { usage: { prompt_tokens: 10, completion_tokens: 5 }, choices: [{ delta: {} }] },
  ]);

  const result = await client.chat("m", [], [], noopCallbacks);

  assert.deepEqual(result.usage, { promptTokens: 10, completionTokens: 5, cachedPromptTokens: 0 });
});

test("chatOnce captures cached prompt tokens from prompt_tokens_details", async () => {
  const client = clientWithStream([
    {
      usage: {
        prompt_tokens: 100,
        completion_tokens: 5,
        prompt_tokens_details: { cached_tokens: 75 },
      },
      choices: [{ delta: { content: "hi" } }],
    },
  ]);

  const result = await client.chat("m", [], [], noopCallbacks);

  assert.deepEqual(result.usage, {
    promptTokens: 100,
    completionTokens: 5,
    cachedPromptTokens: 75,
  });
});

test("chat retries a 429 with backoff, then throws RetryExhaustedError once attempts are exhausted", async () => {
  let calls = 0;
  const client = new ProviderClient("fake-key");
  (client as unknown as { client: { chat: { completions: { create: unknown } } } }).client = {
    chat: {
      completions: {
        create: async () => {
          calls++;
          const err = new Error("rate limited") as Error & { status: number };
          err.status = 429;
          throw err;
        },
      },
    },
  };

  const retryAttempts: number[] = [];
  const promise = client.chat("m", [], [], {
    ...noopCallbacks,
    onRetry: (attempt) => retryAttempts.push(attempt),
  });

  await assert.rejects(promise, RetryExhaustedError);
  assert.equal(calls, 4); // MAX_ATTEMPTS
  assert.deepEqual(retryAttempts, [1, 2, 3]); // one onRetry per retry, not the final failed attempt
});

test("chat does not retry a non-retryable (e.g. 400) error", async () => {
  const client = new ProviderClient("fake-key");
  let calls = 0;
  (client as unknown as { client: { chat: { completions: { create: unknown } } } }).client = {
    chat: {
      completions: {
        create: async () => {
          calls++;
          const err = new Error("bad request") as Error & { status: number };
          err.status = 400;
          throw err;
        },
      },
    },
  };

  await assert.rejects(client.chat("m", [], [], noopCallbacks), /bad request/);
  assert.equal(calls, 1);
});

test("chatOnce forwards text and reasoning deltas via callbacks", async () => {
  const client = clientWithStream([
    { choices: [{ delta: { reasoning_content: "thinking..." } }] },
    { choices: [{ delta: { content: "hello " } }] },
    { choices: [{ delta: { content: "world" } }] },
  ]);

  const text: string[] = [];
  const reasoning: string[] = [];
  const result = await client.chat("m", [], [], {
    onTextDelta: (d) => text.push(d),
    onReasoningDelta: (d) => reasoning.push(d),
  });

  assert.deepEqual(text, ["hello ", "world"]);
  assert.deepEqual(reasoning, ["thinking..."]);
  assert.equal(result.text, "hello world");
  assert.equal((result.message as ChatMessage & { content: string }).content, "hello world");
});
