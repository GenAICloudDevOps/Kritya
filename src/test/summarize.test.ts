import assert from "node:assert/strict";
import { test } from "node:test";
import type { ChatMessage } from "../types.js";
import { SUMMARY_SYSTEM_PROMPT, selectMessagesForSummary } from "../agent/compactor.js";

const user = (content: string): ChatMessage => ({ role: "user", content });
const toolMsg = (content: string): ChatMessage => ({
  role: "tool",
  content,
  tool_call_id: "call_1",
});

test("selectMessagesForSummary keeps the whole history when it fits", () => {
  const history = [user("hello"), user("do the thing"), user("thanks")];
  const { messages, dropped } = selectMessagesForSummary(history, 120_000);
  assert.deepEqual(messages, history);
  assert.equal(dropped, 0);
});

test("selectMessagesForSummary drops the oldest messages when over budget", () => {
  // budget is half the window: 500 tokens here, each message ~337.
  const history = Array.from({ length: 6 }, (_, i) => user(`m${i} ` + "x".repeat(1000)));
  const { messages, dropped } = selectMessagesForSummary(history, 1000);
  assert.ok(dropped > 0);
  assert.ok(messages.length < history.length);
  // The kept messages are the newest suffix of the history.
  assert.deepEqual(
    messages.map((m) => m.content),
    history.slice(dropped).map((m) => m.content)
  );
});

test("selectMessagesForSummary never starts on an orphaned tool reply", () => {
  const history = [
    user("u1 " + "x".repeat(4000)),
    toolMsg("t1 " + "x".repeat(4000)),
    user("u2"),
    user("u3"),
  ];
  const { messages, dropped } = selectMessagesForSummary(history, 4000);
  assert.notEqual(messages[0].role, "tool");
  assert.equal(dropped, 2);
  assert.deepEqual(
    messages.map((m) => m.content),
    ["u2", "u3"]
  );
});

test("SUMMARY_SYSTEM_PROMPT asks for a dense briefing", () => {
  assert.ok(SUMMARY_SYSTEM_PROMPT.length > 0);
  assert.match(SUMMARY_SYSTEM_PROMPT, /briefing/i);
});
