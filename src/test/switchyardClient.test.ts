import assert from "node:assert/strict";
import { test } from "node:test";
import { ProviderClient, RetryExhaustedError } from "../provider/client.js";
import { SwitchyardProviderClient } from "../provider/switchyardClient.js";
import { SWITCHYARD_FALLBACK_MODELS } from "../provider/switchyardSidecar.js";

const noopCallbacks = { onTextDelta() {}, onReasoningDelta() {} };

interface FakeChunk {
  model?: string;
  choices?: [{ delta: Record<string, unknown> }];
}

/** Same technique as clientResilience.test.ts: swap the SDK instance a
 *  ProviderClient wraps for one whose `create` runs `impl`, so `chat()`
 *  exercises the real streaming/retry logic against a scripted response. */
function withCreate(client: ProviderClient, impl: () => unknown): ProviderClient {
  (client as unknown as { client: { chat: { completions: { create: unknown } } } }).client = {
    chat: { completions: { create: async () => impl() } },
  };
  return client;
}

/** A create() that always fails in a way `chat()` cannot retry past — the
 *  same status the real ProviderClient.chat() throws once its own 4-attempt
 *  budget is exhausted. Using this directly (rather than replaying real
 *  retryable failures through the real backoff loop) is what keeps these
 *  tests from actually waiting out multiple seconds of exponential backoff. */
function alwaysRetryExhausted(): never {
  throw new RetryExhaustedError(new Error("boom"), 4);
}

function succeedsWith(text: string, model: string) {
  return async function* (): AsyncGenerator<FakeChunk> {
    yield { model, choices: [{ delta: { content: text } }] };
  };
}

function fallbackClients(swClient: SwitchyardProviderClient) {
  return (swClient as unknown as { fallbacks: { model: string; client: ProviderClient }[] })
    .fallbacks;
}

test("SwitchyardProviderClient returns the primary response directly when switchyard succeeds", async () => {
  const swClient = new SwitchyardProviderClient("http://127.0.0.1:1/v1", "nvidia-key");
  withCreate(swClient, succeedsWith("primary answer", "nvidia/nemotron-3.5-lightning-30b-a3b"));

  let fallbackCalled = false;
  for (const fb of fallbackClients(swClient)) {
    withCreate(fb.client, () => {
      fallbackCalled = true;
      throw new Error("fallback should never be reached");
    });
  }

  const result = await swClient.chat("switchyard", [], [], noopCallbacks);

  assert.equal(result.text, "primary answer");
  assert.equal(result.model, "nvidia/nemotron-3.5-lightning-30b-a3b");
  assert.equal(fallbackCalled, false, "switchyard succeeded, so no fallback should have run");
});

test("SwitchyardProviderClient falls back through the model pool in order, stopping at the first success", async () => {
  const swClient = new SwitchyardProviderClient("http://127.0.0.1:1/v1", "nvidia-key");
  withCreate(swClient, alwaysRetryExhausted);

  const fallbacks = fallbackClients(swClient);
  assert.deepEqual(
    fallbacks.map((f) => f.model),
    SWITCHYARD_FALLBACK_MODELS,
    "fallback pool matches the documented order: Muse Glimmer, Inkling, GLM 5.2"
  );

  withCreate(fallbacks[0].client, alwaysRetryExhausted); // Muse Glimmer also fails
  withCreate(fallbacks[1].client, succeedsWith("inkling answer", fallbacks[1].model)); // Inkling succeeds
  let thirdCalled = false;
  withCreate(fallbacks[2].client, () => {
    thirdCalled = true;
    throw new Error("GLM 5.2 should never be reached once Inkling succeeds");
  });

  const result = await swClient.chat("switchyard", [], [], noopCallbacks);

  assert.equal(result.text, "inkling answer");
  assert.equal(result.model, fallbacks[1].model);
  assert.equal(thirdCalled, false, "stops at the first fallback that succeeds");
});

test("SwitchyardProviderClient does not fall back for an ordinary (non-retry-exhausted) failure", async () => {
  const swClient = new SwitchyardProviderClient("http://127.0.0.1:1/v1", "nvidia-key");
  const hardError = Object.assign(new Error("bad request"), { status: 400 });
  withCreate(swClient, () => {
    throw hardError;
  });

  let fallbackCalled = false;
  for (const fb of fallbackClients(swClient)) {
    withCreate(fb.client, () => {
      fallbackCalled = true;
      throw new Error("fallback should never run for a hard 400");
    });
  }

  await assert.rejects(() => swClient.chat("switchyard", [], [], noopCallbacks), /bad request/);
  assert.equal(fallbackCalled, false);
});

test("SwitchyardProviderClient throws the last fallback's error when every target is exhausted", async () => {
  const swClient = new SwitchyardProviderClient("http://127.0.0.1:1/v1", "nvidia-key");
  withCreate(swClient, alwaysRetryExhausted);

  const fallbacks = fallbackClients(swClient);
  withCreate(fallbacks[0].client, alwaysRetryExhausted);
  withCreate(fallbacks[1].client, alwaysRetryExhausted);
  const lastErr = new RetryExhaustedError(new Error("glm also down"), 4);
  withCreate(fallbacks[2].client, () => {
    throw lastErr;
  });

  await assert.rejects(
    () => swClient.chat("switchyard", [], [], noopCallbacks),
    (err: unknown) => err === lastErr
  );
});
