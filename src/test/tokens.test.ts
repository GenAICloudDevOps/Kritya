import assert from "node:assert/strict";
import { test } from "node:test";
import { estimateHistoryTokens, estimateMessageTokens, estimateTokens } from "../agent/tokens.js";
import type { ChatMessage } from "../types.js";

test("estimateTokens runs high rather than low", () => {
  // The guarantee that matters: never under-count, since an under-count is
  // what turns into a failed request. ~4 chars/token is the prose rule of
  // thumb; this must not be looser than that.
  const text = "a".repeat(400);
  assert.ok(estimateTokens(text) >= 100, "at least the 4-chars-per-token estimate");
  assert.equal(estimateTokens(""), 0);
});

test("estimateMessageTokens counts tool call names and arguments", () => {
  const bare: ChatMessage = { role: "assistant", content: null };
  const withCall: ChatMessage = {
    role: "assistant",
    content: null,
    tool_calls: [
      {
        id: "a",
        type: "function",
        function: { name: "edit_file", arguments: JSON.stringify({ path: "src/x.ts" }) },
      },
    ],
  };
  assert.ok(
    estimateMessageTokens(withCall) > estimateMessageTokens(bare),
    "tool call payload is not invisible to the estimate"
  );
});

test("estimateMessageTokens charges an image a flat cost, not its data-URL length", () => {
  const huge = "data:image/png;base64," + "A".repeat(500_000);
  const message: ChatMessage = {
    role: "user",
    content: [
      { type: "text", text: "what is this" },
      { type: "image_url", image_url: { url: huge } },
    ],
  } as ChatMessage;

  const estimate = estimateMessageTokens(message);
  // Counting the base64 would produce ~150k tokens for one small image and
  // trigger endless compaction.
  assert.ok(estimate < 2000, `expected a flat image cost, got ${estimate}`);
  assert.ok(estimate > 100, "but the image is not free either");
});

test("estimateHistoryTokens grows with history and handles an empty list", () => {
  const one: ChatMessage[] = [{ role: "user", content: "hello there" }];
  const three: ChatMessage[] = [...one, { role: "assistant", content: "hi" }, ...one];
  assert.equal(estimateHistoryTokens([]), 0);
  assert.ok(estimateHistoryTokens(three) > estimateHistoryTokens(one));
});
