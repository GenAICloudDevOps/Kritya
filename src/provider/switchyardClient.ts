import type { ChatMessage, ToolDef } from "../types.js";
import { NVIDIA_BASE_URL } from "../config/config.js";
import {
  ProviderClient,
  RetryExhaustedError,
  type ChatResult,
  type SamplingOptions,
  type StreamCallbacks,
  type TimeoutOptions,
  type TraceContext,
} from "./client.js";
import { SWITCHYARD_FALLBACK_MODELS, ensureSwitchyardSidecar } from "./switchyardSidecar.js";

/**
 * Talks to the local switchyard-server sidecar for the smart weak/strong
 * routing decision. Switchyard itself has no cross-model fallback (see
 * docs/reference/toml_schema.md — `max_retries` only retries the same
 * backend), so if the whole switchyard call exhausts its retries, this
 * falls back to calling the remaining curated models directly against
 * NVIDIA, in order, before giving up. The next turn always tries switchyard
 * again first — a fallback here is per-turn, not a permanent downgrade.
 */
export class SwitchyardProviderClient extends ProviderClient {
  private fallbacks: { model: string; client: ProviderClient }[];

  constructor(
    switchyardBaseUrl: string,
    nvidiaApiKey: string,
    sampling: SamplingOptions = {},
    timeouts: TimeoutOptions = {}
  ) {
    super(nvidiaApiKey, switchyardBaseUrl, sampling, timeouts);
    this.fallbacks = SWITCHYARD_FALLBACK_MODELS.map((model) => ({
      model,
      client: new ProviderClient(nvidiaApiKey, NVIDIA_BASE_URL, sampling, timeouts),
    }));
  }

  override async chat(
    model: string,
    messages: ChatMessage[],
    tools: ToolDef[],
    callbacks: StreamCallbacks,
    signal?: AbortSignal,
    trace?: TraceContext
  ): Promise<ChatResult> {
    try {
      return await super.chat(model, messages, tools, callbacks, signal, trace);
    } catch (err) {
      if (!(err instanceof RetryExhaustedError) || signal?.aborted) throw err;
      let lastErr: unknown = err;
      for (const fb of this.fallbacks) {
        try {
          return await fb.client.chat(fb.model, messages, tools, callbacks, signal, trace);
        } catch (fbErr) {
          lastErr = fbErr;
        }
      }
      throw lastErr;
    }
  }
}

/** Ensure the sidecar is up, then build a client pointed at it. */
export async function createSwitchyardClient(
  nvidiaApiKey: string,
  sampling: SamplingOptions = {},
  timeouts: TimeoutOptions = {}
): Promise<SwitchyardProviderClient> {
  const { baseUrl } = await ensureSwitchyardSidecar(nvidiaApiKey, NVIDIA_BASE_URL);
  return new SwitchyardProviderClient(baseUrl, nvidiaApiKey, sampling, timeouts);
}
