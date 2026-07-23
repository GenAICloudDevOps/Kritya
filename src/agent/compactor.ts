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

/**
 * Build the replacement for the summarized-away messages when the model can't
 * be asked to summarize them — because the summarization request itself
 * failed, which is most likely precisely when it's needed (a full context, a
 * rate-limited provider, a dropped connection).
 *
 * The alternative to this is losing the turn. Dropping the old messages
 * outright would leave the model with no idea what it had already done, so
 * this keeps the skeleton that survives cheaply without a model call: which
 * files were touched and which commands ran. It is much worse than a real
 * summary, and says so, so the model treats it as the partial record it is.
 */
export function fallbackSummary(toSummarize: ChatMessage[]): string {
  const files = new Set<string>();
  const commands: string[] = [];
  let userAsks = 0;

  for (const m of toSummarize) {
    if (m.role === "user" && typeof m.content === "string" && !m.content.startsWith("["))
      userAsks++;
    for (const call of (m as AssistantWithCalls).tool_calls ?? []) {
      let args: { path?: unknown; command?: unknown };
      try {
        args = JSON.parse(call.function.arguments) as { path?: unknown; command?: unknown };
      } catch {
        continue;
      }
      if (typeof args.path === "string") files.add(args.path);
      if (typeof args.command === "string" && commands.length < 20) commands.push(args.command);
    }
  }

  const lines = [
    `[Earlier work in this session — ${toSummarize.length} messages were dropped to stay within ` +
      `the context window. The model that would have summarized them was unavailable, so this is ` +
      `a mechanical record, not a summary: details, decisions, and outcomes are NOT captured here. ` +
      `Re-read files or re-run commands before relying on their contents.]`,
    `Requests from the user in that span: ${userAsks}`,
  ];
  if (files.size) {
    lines.push(`Files touched: ${[...files].slice(0, 40).join(", ")}`);
  }
  if (commands.length) {
    lines.push(`Commands run: ${commands.map((c) => c.slice(0, 120)).join(" | ")}`);
  }
  return lines.join("\n");
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
