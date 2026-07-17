import type { ChatMessage } from "../types.js";

/** How many recent messages survive compaction untouched. */
const KEEP_TAIL = 8;

interface AssistantWithCalls {
  role: string;
  tool_calls?: { function: { name: string; arguments: string } }[];
}

/**
 * Split history into an older part to summarize and a recent tail to keep.
 * The tail never starts on a tool reply: the cut moves back to the assistant
 * message that issued the tool calls, so call/reply pairs stay together.
 */
export function splitForCompaction(history: ChatMessage[]): {
  toSummarize: ChatMessage[];
  keep: ChatMessage[];
} {
  if (history.length <= KEEP_TAIL) return { toSummarize: [], keep: history };
  let cut = history.length - KEEP_TAIL;
  while (cut > 0 && history[cut].role === "tool") cut--;
  return { toSummarize: history.slice(0, cut), keep: history.slice(cut) };
}

/** Render messages as a plain-text transcript for the summarization request. */
export function renderTranscript(messages: ChatMessage[]): string {
  return messages
    .map((m) => {
      if (m.role === "tool") {
        return `[tool result]: ${String(m.content ?? "").slice(0, 400)}`;
      }
      const content = typeof m.content === "string" ? m.content : "";
      const calls = (m as AssistantWithCalls).tool_calls
        ?.map((c) => `${c.function.name}(${c.function.arguments.slice(0, 200)})`)
        .join(", ");
      return `${m.role}: ${content}${calls ? `\n[called: ${calls}]` : ""}`;
    })
    .join("\n\n");
}
