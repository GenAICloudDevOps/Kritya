import OpenAI from "openai";
import { NVIDIA_BASE_URL } from "../config/config.js";
import { NOOP_TRACER, type Span, type Tracer } from "../telemetry/tracer.js";
import type { ChatMessage, ToolDef, Usage } from "../types.js";
import { recoverToolCalls } from "./textToolCalls.js";

export interface ParsedToolCall {
  id: string;
  name: string;
  /** Raw JSON string of arguments as emitted by the model. */
  argsJson: string;
}

export interface ChatResult {
  /** The assistant message to append to history (content + tool_calls). */
  message: ChatMessage;
  text: string;
  toolCalls: ParsedToolCall[];
  usage?: Usage;
  /**
   * The model that actually served the request, as reported on the streamed
   * chunks. Usually identical to the `model` requested, except behind a
   * router (e.g. switchyard) that dispatches a named route to a different
   * underlying model — there this is the real one, and `model` is the route.
   */
  model?: string;
}

export interface StreamCallbacks {
  onTextDelta(delta: string): void;
  onReasoningDelta(delta: string): void;
  /** Called before a retry after a transient provider error. */
  onRetry?(attempt: number, status?: number): void;
}

/** Retry transient provider failures (429 / 5xx / network) with backoff. */
const MAX_ATTEMPTS = 4;

/**
 * Thrown when a stream that opened successfully then goes quiet for longer
 * than the idle timeout. This is its own error because it is invisible to
 * every other guard: the request succeeded, nothing threw, and the socket is
 * still open — the turn simply hangs forever with a spinner on it. Treated as
 * retryable, since a provider that stalls mid-answer is the same class of
 * transient failure as one that resets the connection.
 */
export class StreamIdleError extends Error {
  readonly idleMs: number;

  constructor(idleMs: number) {
    super(`Provider stopped sending data for ${Math.round(idleMs / 1000)}s`);
    this.name = "StreamIdleError";
    this.idleMs = idleMs;
  }
}

/**
 * Transport-level error codes that mean "try again", beyond the four obvious
 * ones. The UND_ERR_* family comes from undici (Node's fetch, which the OpenAI
 * SDK uses) and shows up on exactly the flaky-network conditions retries exist
 * for; ERR_STREAM_PREMATURE_CLOSE is what a cut response stream surfaces as.
 */
const RETRYABLE_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EPIPE",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENETRESET",
  "ERR_STREAM_PREMATURE_CLOSE",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
]);

/** OpenAI SDK error classes that always mean a transport failure, not a bad request. */
const RETRYABLE_ERROR_NAMES = new Set([
  "APIConnectionError",
  "APIConnectionTimeoutError",
  "StreamIdleError",
]);

/**
 * A 404 whose response body was completely empty.
 *
 * NVIDIA's gateway returns these intermittently for a model that is working
 * fine — the identical request succeeds on an immediate retry. A real "no
 * such model" always carries a body (that gateway sends the text "404 page
 * not found"; OpenAI-compatible providers send a JSON error), so an empty
 * one is a transport-level blip rather than a verdict on the request.
 *
 * The SDK doesn't expose the raw body, so this keys off the message it
 * synthesizes when there was nothing to parse (APIError.makeMessage).
 * Rebuilding that string from the status rather than substring-matching
 * keeps a genuine body that happens to contain the phrase from qualifying;
 * client.test.ts pins the wording so an SDK change fails there instead of
 * silently disabling this.
 */
function isEmptyBodyNotFound(err: unknown): boolean {
  const status = (err as { status?: number })?.status;
  if (status !== 404) return false;
  return (err as { message?: string })?.message === `${status} status code (no body)`;
}

/** Exported for tests; the retry loop below is the only real caller. */
export function isRetryable(err: unknown): boolean {
  if (err instanceof StreamIdleError) return true;
  const status = (err as { status?: number })?.status;
  // 408 Request Timeout joins 429/5xx: the request never got a verdict, so
  // re-sending it is safe and is usually the thing that works.
  if (status === 429 || status === 408 || (typeof status === "number" && status >= 500))
    return true;
  // A 404 normally means "no such model" and must fail fast; an empty-bodied
  // one is a gateway blip. See isEmptyBodyNotFound.
  if (isEmptyBodyNotFound(err)) return true;
  const name = (err as { name?: string })?.name;
  if (name && RETRYABLE_ERROR_NAMES.has(name)) return true;
  const code = (err as { code?: string })?.code;
  if (code && RETRYABLE_CODES.has(code)) return true;
  // undici nests the real cause one level down (fetch failed → cause).
  const cause = (err as { cause?: unknown })?.cause;
  if (cause && cause !== err) {
    const causeCode = (cause as { code?: string })?.code;
    if (causeCode && RETRYABLE_CODES.has(causeCode)) return true;
  }
  return false;
}

/** Read one header case-insensitively from whatever shape the SDK attached. */
function headerValue(err: unknown, name: string): string | undefined {
  const headers = (err as { headers?: unknown })?.headers;
  if (!headers) return undefined;
  const get = (headers as { get?: (k: string) => string | null }).get;
  if (typeof get === "function") return get.call(headers, name) ?? undefined;
  for (const [k, v] of Object.entries(headers as Record<string, unknown>)) {
    if (k.toLowerCase() === name) return typeof v === "string" ? v : String(v);
  }
  return undefined;
}

/** Longest Retry-After we'll honor. Beyond this, our own backoff and the
 *  user's patience are the better answer than sleeping for minutes. */
const MAX_RETRY_AFTER_MS = 60_000;

/**
 * The provider's own `Retry-After`, in milliseconds, when it sent one. Backing
 * off for less than a rate limiter asked for just burns another attempt
 * against the same closed window — which is exactly how a four-attempt budget
 * evaporates in two seconds on a free tier. Both header forms are accepted:
 * delay-seconds and an HTTP-date. Exported for tests.
 */
export function retryAfterMs(err: unknown): number | undefined {
  const raw = headerValue(err, "retry-after")?.trim();
  if (!raw) return undefined;
  const seconds = Number(raw);
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(raw) - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return undefined;
  return Math.min(ms, MAX_RETRY_AFTER_MS);
}

/** Message fragments providers use when the prompt exceeds the context window. */
const CONTEXT_OVERFLOW_RE =
  /context[ _-]?length|context[ _-]?window|maximum context|too many tokens|reduce the length|prompt is too long|input is too long/i;

/**
 * Whether a failure means "this prompt does not fit", as opposed to any other
 * bad request. It is worth separating because it is the one 400 with an
 * automatic remedy — compact the history and the same turn can continue —
 * whereas every other 400 is a genuine hard failure. Providers disagree on the
 * wording and on the error `code`, so both are checked.
 */
export function isContextOverflowError(err: unknown): boolean {
  const status = (err as { status?: number })?.status;
  if (typeof status === "number" && status !== 400 && status !== 413) return false;
  const code = (err as { code?: string })?.code ?? "";
  if (code === "context_length_exceeded" || code === "string_above_max_length") return true;
  const message = err instanceof Error ? err.message : String(err ?? "");
  return CONTEXT_OVERFLOW_RE.test(message);
}

/**
 * Thrown when a transient provider failure (429 / 5xx / network) survives
 * every retry attempt. Distinguishing this from a hard failure (bad request,
 * auth error, etc.) lets callers offer a targeted next step — e.g. "try
 * another provider" — rather than a generic error message.
 */
export class RetryExhaustedError extends Error {
  readonly status?: number;
  readonly attempts: number;
  readonly cause: unknown;

  constructor(cause: unknown, attempts: number) {
    const status = (cause as { status?: number })?.status;
    const causeMsg = cause instanceof Error ? cause.message : String(cause);
    super(
      `Provider request failed after ${attempts} attempt(s)` +
        (status ? ` (last status ${status})` : "") +
        `: ${causeMsg}`
    );
    this.name = "RetryExhaustedError";
    this.status = status;
    this.attempts = attempts;
    this.cause = cause;
  }
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      reject(new DOMException("Aborted", "AbortError"));
    });
  });

export interface SamplingOptions {
  /** Default 0.2. Pass null to omit temperature entirely (some reasoning models reject it). */
  temperature?: number | null;
  /** Default 0.95. Pass null to omit top_p entirely. */
  topP?: number | null;
  /** Default 8192. Pass null to omit max_tokens and let the provider's own default apply. */
  maxTokens?: number | null;
}

const DEFAULT_TEMPERATURE = 0.2;
const DEFAULT_TOP_P = 0.95;
const DEFAULT_MAX_TOKENS = 8192;

/**
 * Deadlines for a single request attempt.
 *
 * Two are needed, because they catch different failures. `requestTimeoutMs`
 * bounds the whole call and is the SDK's own knob. `streamIdleTimeoutMs`
 * bounds the gap *between chunks* — the case the first one handles badly: a
 * long, healthy answer and a provider that accepted the connection and then
 * went silent look identical to an overall timer, so setting that timer tight
 * enough to catch the stall would cut off legitimate long answers.
 */
export interface TimeoutOptions {
  /** Whole-request ceiling handed to the SDK. Default 10 minutes. */
  requestTimeoutMs?: number;
  /** Max gap between streamed chunks before the attempt is abandoned. Default 60s. */
  streamIdleTimeoutMs?: number;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 600_000;
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 60_000;

/**
 * Where to hang this request's span. Passed in rather than held on the client
 * because one client serves many turns, and each request belongs under the
 * turn that issued it.
 */
export interface TraceContext {
  tracer: Tracer;
  parent?: Span;
}

export class ProviderClient {
  private client: OpenAI;
  private temperature?: number;
  private topP?: number;
  private maxTokens?: number;
  private streamIdleTimeoutMs: number;

  constructor(
    apiKey: string,
    baseURL: string = NVIDIA_BASE_URL,
    sampling: SamplingOptions = {},
    timeouts: TimeoutOptions = {}
  ) {
    // We do our own streaming-aware retry loop, so disable the SDK's.
    this.client = new OpenAI({
      apiKey,
      baseURL,
      maxRetries: 0,
      timeout: timeouts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    });
    this.streamIdleTimeoutMs = timeouts.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS;
    this.temperature =
      sampling.temperature === null ? undefined : (sampling.temperature ?? DEFAULT_TEMPERATURE);
    this.topP = sampling.topP === null ? undefined : (sampling.topP ?? DEFAULT_TOP_P);
    this.maxTokens =
      sampling.maxTokens === null ? undefined : (sampling.maxTokens ?? DEFAULT_MAX_TOKENS);
  }

  /**
   * One `llm.chat` span covers the whole request *including* its retries and
   * backoff, so the span's duration is the wall-clock cost the user actually
   * paid. Each retry is recorded as an event on it, which is what turns "the
   * turn felt slow" into "we were rate-limited three times".
   */
  async chat(
    model: string,
    messages: ChatMessage[],
    tools: ToolDef[],
    callbacks: StreamCallbacks,
    signal?: AbortSignal,
    trace?: TraceContext
  ): Promise<ChatResult> {
    const span = (trace?.tracer ?? NOOP_TRACER).startSpan("llm.chat", {
      parent: trace?.parent,
      attributes: {
        "kritya.model": model,
        "kritya.message_count": messages.length,
        "kritya.tool_count": tools.length,
      },
    });
    let lastErr: unknown;
    try {
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        try {
          const result = await this.chatOnce(model, messages, tools, callbacks, signal);
          span.setAttribute("kritya.attempts", attempt + 1);
          span.setAttribute("kritya.tool_call_count", result.toolCalls.length);
          if (result.usage) {
            span.setAttribute("kritya.prompt_tokens", result.usage.promptTokens);
            span.setAttribute("kritya.completion_tokens", result.usage.completionTokens);
            span.setAttribute("kritya.cached_tokens", result.usage.cachedPromptTokens ?? 0);
          } else {
            // The caller will fall back to estimating; say so on the span
            // rather than leaving the token attributes silently absent.
            span.setAttribute("kritya.usage_reported", false);
          }
          span.setStatus("OK");
          return result;
        } catch (err) {
          if (signal?.aborted || (err as Error)?.name === "AbortError") throw err;
          lastErr = err;
          if (!isRetryable(err)) throw err;
          if (attempt === MAX_ATTEMPTS - 1) throw new RetryExhaustedError(err, MAX_ATTEMPTS);
          const status = (err as { status?: number })?.status;
          // The provider's own Retry-After wins when it asks for longer than
          // our schedule — under-waiting a rate limit just spends the next
          // attempt on the same closed window.
          const ownBackoffMs = Math.min(1000 * 2 ** attempt, 8000) + Math.random() * 250;
          const serverBackoffMs = retryAfterMs(err);
          const backoffMs = Math.max(ownBackoffMs, serverBackoffMs ?? 0);
          span.addEvent("retry", {
            "kritya.attempt": attempt + 1,
            "kritya.backoff_ms": Math.round(backoffMs),
            ...(serverBackoffMs !== undefined
              ? { "kritya.retry_after_ms": Math.round(serverBackoffMs) }
              : {}),
            ...(status !== undefined ? { "kritya.status": status } : {}),
          });
          callbacks.onRetry?.(attempt + 1, status);
          await sleep(backoffMs, signal);
        }
      }
      throw lastErr;
    } catch (err) {
      span.setStatus("ERROR", err instanceof Error ? err.message : String(err));
      throw err;
    } finally {
      span.end();
    }
  }

  /**
   * A single non-streaming completion, no tools, no retry loop — for
   * server-initiated MCP sampling requests, which want one answer back, not
   * a full agentic turn.
   */
  async complete(
    model: string,
    messages: ChatMessage[],
    maxTokens?: number,
    signal?: AbortSignal
  ): Promise<{ text: string; model: string; stopReason: string }> {
    const response = await this.client.chat.completions.create(
      {
        model,
        messages,
        stream: false,
        max_tokens: maxTokens ?? this.maxTokens,
        temperature: this.temperature,
        top_p: this.topP,
      },
      { signal }
    );
    const choice = response.choices[0];
    if (!choice) throw new Error("provider returned no completion");
    return {
      text: choice.message.content ?? "",
      model: response.model,
      stopReason: choice.finish_reason ?? "stop",
    };
  }

  private async chatOnce(
    model: string,
    messages: ChatMessage[],
    tools: ToolDef[],
    callbacks: StreamCallbacks,
    signal?: AbortSignal
  ): Promise<ChatResult> {
    const stream = await this.client.chat.completions.create(
      {
        model,
        messages,
        tools: tools.length
          ? tools.map((t) => ({
              type: "function" as const,
              function: {
                name: t.name,
                description: t.description,
                parameters: t.parameters,
              },
            }))
          : undefined,
        ...(this.temperature !== undefined ? { temperature: this.temperature } : {}),
        ...(this.topP !== undefined ? { top_p: this.topP } : {}),
        ...(this.maxTokens !== undefined ? { max_tokens: this.maxTokens } : {}),
        stream: true,
        stream_options: { include_usage: true },
      },
      { signal }
    );

    let text = "";
    const calls = new Map<number, { id: string; name: string; argsJson: string }>();
    let usage: Usage | undefined;
    let servedModel: string | undefined;

    for await (const chunk of this.withIdleWatchdog(stream)) {
      if (chunk.usage) {
        usage = {
          promptTokens: chunk.usage.prompt_tokens ?? 0,
          completionTokens: chunk.usage.completion_tokens ?? 0,
          cachedPromptTokens: chunk.usage.prompt_tokens_details?.cached_tokens ?? 0,
        };
      }
      // Behind a router the chunk's own `model` is the real one that served
      // it, not the route name that was requested — grab it once, from
      // whichever chunk happens to carry it first.
      if (!servedModel && chunk.model) servedModel = chunk.model;
      const delta = chunk.choices?.[0]?.delta;
      if (!delta) continue;

      // Some NVIDIA-hosted models (DeepSeek R1, Nemotron reasoning modes) stream
      // thinking on `reasoning_content`; OpenRouter and others use `reasoning`.
      const reasoning =
        (delta as { reasoning_content?: string; reasoning?: string }).reasoning_content ??
        (delta as { reasoning_content?: string; reasoning?: string }).reasoning;
      if (reasoning) callbacks.onReasoningDelta(reasoning);

      if (delta.content) {
        text += delta.content;
        callbacks.onTextDelta(delta.content);
      }
      for (const tc of delta.tool_calls ?? []) {
        const entry = calls.get(tc.index) ?? { id: "", name: "", argsJson: "" };
        if (tc.id) entry.id = tc.id;
        if (tc.function?.name) entry.name += tc.function.name;
        if (tc.function?.arguments) entry.argsJson += tc.function.arguments;
        calls.set(tc.index, entry);
      }
    }

    let toolCalls: ParsedToolCall[] = [...calls.entries()]
      .sort(([a], [b]) => a - b)
      .map(([i, c]) => ({
        id: c.id || `call_${i}`,
        name: c.name,
        argsJson: c.argsJson || "{}",
      }));

    // A model that writes its tool call into the text channel instead would
    // otherwise end the turn here: no tool call, so the loop treats the JSON as
    // the final answer, prints it, and the action never runs. Recovering it is
    // narrow enough to be safe (see textToolCalls.ts) — and when it fires, the
    // text *was* the call, so it must not also be shown as an answer.
    let visibleText = text;
    if (toolCalls.length === 0 && text.trim()) {
      const recovered = recoverToolCalls(text, new Set(tools.map((t) => t.name)));
      if (recovered.length) {
        toolCalls = recovered;
        visibleText = "";
      }
    }

    const message = {
      role: "assistant",
      content: visibleText || null,
      ...(toolCalls.length
        ? {
            tool_calls: toolCalls.map((c) => ({
              id: c.id,
              type: "function" as const,
              function: { name: c.name, arguments: c.argsJson },
            })),
          }
        : {}),
    } as ChatMessage;

    return { message, text: visibleText, toolCalls, usage, model: servedModel };
  }

  /**
   * Re-yield a stream's chunks, giving up if the gap between two of them
   * exceeds the idle timeout.
   *
   * A `for await` over a stalled stream waits forever: nothing throws, the
   * socket stays open, and neither the retry loop nor the user's Esc is
   * reached, so the turn hangs with a live spinner on it until the process is
   * killed. Racing each `next()` against a timer turns that into an ordinary
   * retryable error. The underlying stream is aborted on the way out — without
   * it the abandoned request keeps consuming a connection (and, on metered
   * providers, keeps generating) after we've stopped reading.
   */
  private async *withIdleWatchdog<T>(stream: AsyncIterable<T>): AsyncGenerator<T> {
    const idleMs = this.streamIdleTimeoutMs;
    if (!Number.isFinite(idleMs) || idleMs <= 0) {
      yield* stream;
      return;
    }
    const iterator = stream[Symbol.asyncIterator]();
    try {
      for (;;) {
        let timer: NodeJS.Timeout | undefined;
        const idle = new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new StreamIdleError(idleMs)), idleMs);
        });
        const pending = iterator.next();
        // If the timer wins the race, this promise still settles later with
        // nobody awaiting it — pre-attach a handler so a late rejection can't
        // surface as an unhandled rejection and take the process down.
        pending.catch(() => {});
        let next: IteratorResult<T>;
        try {
          next = await Promise.race([pending, idle]);
        } finally {
          clearTimeout(timer);
        }
        if (next.done) return;
        yield next.value;
      }
    } catch (err) {
      if (err instanceof StreamIdleError) {
        (stream as { controller?: AbortController }).controller?.abort();
      }
      throw err;
    } finally {
      // Covers the caller breaking out early (an abort mid-turn) as well as
      // the idle path above; returning a generator is a no-op if it's done.
      //
      // Deliberately not awaited. An async generator suspended at an `await`
      // doesn't run its return until that await settles — so on the stalled
      // stream this exists to escape, awaiting here would block for exactly as
      // long as the hang we just refused to wait for, and the retry would
      // never be reached.
      void Promise.resolve(iterator.return?.()).catch(() => {});
    }
  }
}
