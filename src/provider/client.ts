import OpenAI from "openai";
import { NVIDIA_BASE_URL } from "../config/config.js";
import type { ChatMessage, ToolDef, Usage } from "../types.js";

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
}

export interface StreamCallbacks {
  onTextDelta(delta: string): void;
  onReasoningDelta(delta: string): void;
  /** Called before a retry after a transient provider error. */
  onRetry?(attempt: number, status?: number): void;
}

/** Backward-compatible alias; the client is provider-agnostic. */
export { ProviderClient as NvidiaClient };

/** Retry transient provider failures (429 / 5xx / network) with backoff. */
const MAX_ATTEMPTS = 4;

function isRetryable(err: unknown): boolean {
  const status = (err as { status?: number })?.status;
  if (status === 429 || (typeof status === "number" && status >= 500)) return true;
  const code = (err as { code?: string })?.code;
  return (
    code === "ECONNRESET" || code === "ETIMEDOUT" || code === "ENOTFOUND" || code === "EAI_AGAIN"
  );
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      reject(new DOMException("Aborted", "AbortError"));
    });
  });

export class ProviderClient {
  private client: OpenAI;

  constructor(apiKey: string, baseURL: string = NVIDIA_BASE_URL) {
    // We do our own streaming-aware retry loop, so disable the SDK's.
    this.client = new OpenAI({ apiKey, baseURL, maxRetries: 0 });
  }

  async chat(
    model: string,
    messages: ChatMessage[],
    tools: ToolDef[],
    callbacks: StreamCallbacks,
    signal?: AbortSignal
  ): Promise<ChatResult> {
    let lastErr: unknown;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      try {
        return await this.chatOnce(model, messages, tools, callbacks, signal);
      } catch (err) {
        if (signal?.aborted || (err as Error)?.name === "AbortError") throw err;
        lastErr = err;
        if (attempt === MAX_ATTEMPTS - 1 || !isRetryable(err)) throw err;
        const status = (err as { status?: number })?.status;
        callbacks.onRetry?.(attempt + 1, status);
        await sleep(Math.min(1000 * 2 ** attempt, 8000) + Math.random() * 250, signal);
      }
    }
    throw lastErr;
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
        temperature: 0.2,
        top_p: 0.95,
        max_tokens: 8192,
        stream: true,
        stream_options: { include_usage: true },
      },
      { signal }
    );

    let text = "";
    const calls = new Map<number, { id: string; name: string; argsJson: string }>();
    let usage: Usage | undefined;

    for await (const chunk of stream) {
      if (chunk.usage) {
        usage = {
          promptTokens: chunk.usage.prompt_tokens ?? 0,
          completionTokens: chunk.usage.completion_tokens ?? 0,
        };
      }
      const delta = chunk.choices?.[0]?.delta;
      if (!delta) continue;

      // Some NVIDIA-hosted models (DeepSeek R1, Nemotron reasoning modes)
      // stream thinking on a nonstandard field.
      const reasoning = (delta as { reasoning_content?: string }).reasoning_content;
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

    const toolCalls: ParsedToolCall[] = [...calls.entries()]
      .sort(([a], [b]) => a - b)
      .map(([i, c]) => ({
        id: c.id || `call_${i}`,
        name: c.name,
        argsJson: c.argsJson || "{}",
      }));

    const message = {
      role: "assistant",
      content: text || null,
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

    return { message, text, toolCalls, usage };
  }
}
