import assert from "node:assert/strict";
import os from "node:os";
import { test } from "node:test";
import { Agent } from "../agent/loop.js";
import type { ProviderClient } from "../provider/client.js";
import { PermissionManager } from "../permissions/permissions.js";
import { SessionStore } from "../session/store.js";
import type { ChatMessage } from "../types.js";

function makeAgent(history: ChatMessage[]): Agent {
  return new Agent(
    undefined as unknown as ProviderClient, // never called by loadHistory
    () => "test-model",
    [],
    { workspace: os.tmpdir() },
    new PermissionManager(),
    new SessionStore(os.tmpdir(), true),
    history
  );
}

test("loadHistory repairs dangling tool_calls from a cancelled turn", () => {
  const agent = makeAgent([]);
  agent.loadHistory([
    { role: "user", content: "do two things" },
    {
      role: "assistant",
      content: null,
      tool_calls: [
        { id: "call_1", type: "function", function: { name: "read_file", arguments: "{}" } },
        { id: "call_2", type: "function", function: { name: "shell", arguments: "{}" } },
      ],
    },
    // Only call_1 got a result before the turn was interrupted.
    { role: "tool", tool_call_id: "call_1", content: "file contents" },
    { role: "user", content: "continue" },
  ]);

  const toolMsgs = agent.history.filter((m) => m.role === "tool");
  assert.equal(toolMsgs.length, 2, "a stub result was inserted for the unanswered call");
  const stub = toolMsgs.find((m) => (m as { tool_call_id: string }).tool_call_id === "call_2");
  assert.ok(stub, "stub answers the dangling call id");
  assert.match(String(stub!.content), /interrupted/);
  // The stub sits with the other tool results, before the next user message.
  const stubIdx = agent.history.indexOf(stub!);
  const userIdx = agent.history.findIndex((m) => m.role === "user" && m.content === "continue");
  assert.ok(stubIdx < userIdx, "stub inserted before the following user message");
});

test("saveCheckpoint + truncateHistory rewind the conversation to the saved point", () => {
  const agent = makeAgent([
    { role: "user", content: "first request" },
    { role: "assistant", content: "done" },
  ]);
  agent.saveCheckpoint("before-refactor", 1);

  // Conversation continues past the checkpoint.
  agent.history.push({ role: "user", content: "second request" });
  agent.history.push({ role: "assistant", content: "also done" });

  const cp = agent.getCheckpoint("before-refactor");
  assert.ok(cp);
  assert.equal(cp!.undoTurn, 1);
  assert.equal(cp!.historyLength, 2);

  agent.truncateHistory(cp!.historyLength);
  assert.equal(agent.history.length, 2);
  assert.equal(agent.history[agent.history.length - 1].content, "done");
});

test("truncateHistory never grows history when the checkpoint predates a compaction", () => {
  const agent = makeAgent([{ role: "user", content: "only message" }]);
  // A checkpoint length larger than the current (post-compaction) history.
  agent.truncateHistory(5);
  assert.equal(agent.history.length, 1);
});

test("reset clears saved checkpoints", () => {
  const agent = makeAgent([{ role: "user", content: "hi" }]);
  agent.saveCheckpoint("x", 0);
  agent.reset();
  assert.equal(agent.getCheckpoint("x"), undefined);
  assert.equal(agent.listCheckpoints().length, 0);
});

test("loadHistory leaves a fully-answered history unchanged", () => {
  const history: ChatMessage[] = [
    { role: "user", content: "hi" },
    {
      role: "assistant",
      content: null,
      tool_calls: [
        { id: "call_1", type: "function", function: { name: "read_file", arguments: "{}" } },
      ],
    },
    { role: "tool", tool_call_id: "call_1", content: "ok" },
    { role: "assistant", content: "done" },
  ];
  const agent = makeAgent([]);
  agent.loadHistory([...history]);
  assert.equal(agent.history.length, history.length);
});
