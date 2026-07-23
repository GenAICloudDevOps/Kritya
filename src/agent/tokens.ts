import type { ChatMessage } from "../types.js";

/**
 * Cheap, dependency-free token estimation for the history about to be sent.
 *
 * The loop needs a number *before* the request, for two things a
 * provider-reported count can't help with: deciding to compact pre-emptively,
 * and keeping the context meter alive on providers that never report usage at
 * all. A real tokenizer would mean shipping per-model vocabularies, which this
 * project deliberately doesn't do — so this is an estimate, and it is
 * calibrated to run slightly *high* rather than low. Over-estimating costs an
 * early compaction; under-estimating costs a failed request at the worst
 * possible moment.
 */

/**
 * Deliberately below the usual "~4 chars per token" rule of thumb. That figure
 * describes English prose; source code, JSON tool arguments, and non-Latin
 * scripts all tokenize denser than that, and this history is mostly those.
 */
const CHARS_PER_TOKEN = 3.4;

/** Per-message framing (role, delimiters) the serialized form doesn't show. */
const PER_MESSAGE_OVERHEAD = 4;

/**
 * Flat cost for an attached image. Its data URL is hundreds of KB of base64
 * that bears no relation to what the model is billed for, so counting its
 * characters would swamp the estimate with an entirely fictional number.
 */
const IMAGE_TOKENS = 800;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

interface ContentPart {
  type?: string;
  text?: string;
}

interface WithToolCalls {
  tool_calls?: { function?: { name?: string; arguments?: string } }[];
}

export function estimateMessageTokens(message: ChatMessage): number {
  let total = PER_MESSAGE_OVERHEAD;
  const content = message.content as unknown;
  if (typeof content === "string") {
    total += estimateTokens(content);
  } else if (Array.isArray(content)) {
    for (const part of content as ContentPart[]) {
      if (part?.type === "image_url") total += IMAGE_TOKENS;
      else if (typeof part?.text === "string") total += estimateTokens(part.text);
    }
  }
  for (const call of (message as WithToolCalls).tool_calls ?? []) {
    total += estimateTokens((call.function?.name ?? "") + (call.function?.arguments ?? ""));
  }
  return total;
}

/** Estimated prompt size of a full message list, tool schemas excluded. */
export function estimateHistoryTokens(messages: ChatMessage[]): number {
  let total = 0;
  for (const m of messages) total += estimateMessageTokens(m);
  return total;
}
