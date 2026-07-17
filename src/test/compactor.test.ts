import assert from "node:assert";
import { test } from "node:test";
import { splitForCompaction, renderTranscript } from "../agent/compactor.js";
import type { ChatMessage } from "../types.js";

const user = (text: string): ChatMessage => ({ role: "user", content: text });
const assistant = (text: string): ChatMessage => ({ role: "assistant", content: text });
const assistantCalls = (): ChatMessage =>
  ({
    role: "assistant",
    content: null,
    tool_calls: [{ id: "c1", type: "function", function: { name: "read_file", arguments: "{}" } }],
  }) as ChatMessage;
const toolMsg = (): ChatMessage => ({ role: "tool", tool_call_id: "c1", content: "data" });

test("short history is kept whole", () => {
  const history = [user("a"), assistant("b")];
  const { toSummarize, keep } = splitForCompaction(history);
  assert.strictEqual(toSummarize.length, 0);
  assert.strictEqual(keep.length, 2);
});

test("never splits an assistant tool call from its replies", () => {
  // 12 messages; the default cut (index 4) lands on a tool reply, so the
  // boundary must move back to the assistant message that issued the call.
  const history: ChatMessage[] = [
    user("start"), // 0
    assistant("ok"), // 1
    user("next"), // 2
    assistantCalls(), // 3
    toolMsg(), // 4  <- naive cut point
    toolMsg(), // 5
    assistant("done"), // 6
    user("more"), // 7
    assistant("sure"), // 8
    user("again"), // 9
    assistant("yes"), // 10
    user("final"), // 11
  ];
  const { toSummarize, keep } = splitForCompaction(history);
  assert.notStrictEqual(keep[0].role, "tool");
  assert.ok(
    (keep[0] as { tool_calls?: unknown[] }).tool_calls,
    "keep starts at the calling assistant"
  );
  assert.strictEqual(toSummarize.length + keep.length, history.length);
  assert.strictEqual(toSummarize.length, 3);
});

test("renderTranscript includes roles, text, and tool call names", () => {
  const out = renderTranscript([user("hello"), assistantCalls(), toolMsg()]);
  assert.match(out, /user: hello/);
  assert.match(out, /read_file/);
  assert.match(out, /\[tool result\]: data/);
});
