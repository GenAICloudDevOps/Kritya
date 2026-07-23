import assert from "node:assert/strict";
import os from "node:os";
import { test } from "node:test";
import { Agent } from "../agent/loop.js";
import { fallbackSummary } from "../agent/compactor.js";
import type { ChatResult, ProviderClient } from "../provider/client.js";
import { PermissionManager } from "../permissions/permissions.js";
import { SessionStore } from "../session/store.js";
import type { AgentHandlers, ChatMessage } from "../types.js";

/** A model call, as the fake client sees it. */
type ChatImpl = (messages: ChatMessage[]) => Promise<ChatResult>;

function reply(text: string): ChatResult {
  return { message: { role: "assistant", content: text }, text, toolCalls: [] };
}

/** True for the request doCompact makes, so a test can answer it differently. */
function isSummarizationRequest(messages: ChatMessage[]): boolean {
  const system = messages[0];
  return system?.role === "system" && String(system.content).includes("You summarize");
}

function fakeClient(impl: ChatImpl): ProviderClient {
  return {
    chat: (_model: string, messages: ChatMessage[]) => impl(messages),
  } as unknown as ProviderClient;
}

function makeAgent(client: ProviderClient, history: ChatMessage[]): Agent {
  return new Agent(
    client,
    () => "test-model",
    [],
    { workspace: os.tmpdir() },
    new PermissionManager(),
    new SessionStore(os.tmpdir(), true),
    history
  );
}

/** A history long enough for splitForCompaction to have something to cut. */
function longHistory(pairs = 12): ChatMessage[] {
  const history: ChatMessage[] = [];
  for (let i = 0; i < pairs; i++) {
    history.push({ role: "user", content: `request number ${i}` });
    history.push({
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: `call_${i}`,
          type: "function",
          function: { name: "write_file", arguments: JSON.stringify({ path: `src/file${i}.ts` }) },
        },
      ],
    });
    history.push({ role: "tool", tool_call_id: `call_${i}`, content: `wrote src/file${i}.ts` });
  }
  return history;
}

function recordingHandlers(): AgentHandlers & {
  toolEnds: { name: string; summary: string; error: boolean }[];
  finalText: string[];
} {
  const toolEnds: { name: string; summary: string; error: boolean }[] = [];
  const finalText: string[] = [];
  return {
    toolEnds,
    finalText,
    onTextDelta: () => {},
    onReasoningDelta: () => {},
    onAssistantText: (t) => finalText.push(t),
    onToolStart: () => {},
    onToolEnd: (_id, name, summary, _preview, isError) =>
      toolEnds.push({ name, summary, error: isError }),
    requestPermission: async () => "no",
    onUsage: () => {},
  };
}

test("fallbackSummary records the files and commands of the dropped span", () => {
  const summary = fallbackSummary([
    { role: "user", content: "fix the parser" },
    {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "a",
          type: "function",
          function: { name: "edit_file", arguments: JSON.stringify({ path: "src/parse.ts" }) },
        },
        {
          id: "b",
          type: "function",
          function: { name: "shell", arguments: JSON.stringify({ command: "npm test" }) },
        },
      ],
    },
    // Synthetic notes aren't counted as user requests.
    { role: "user", content: "[Conversation summary of earlier work]" },
  ]);

  assert.match(summary, /src\/parse\.ts/);
  assert.match(summary, /npm test/);
  assert.match(summary, /Requests from the user in that span: 1/);
  // It must announce its own incompleteness, or the model will trust it.
  assert.match(summary, /NOT captured/);
});

test("fallbackSummary survives tool arguments that aren't valid JSON", () => {
  const summary = fallbackSummary([
    {
      role: "assistant",
      content: null,
      tool_calls: [
        { id: "a", type: "function", function: { name: "edit_file", arguments: "{truncated" } },
      ],
    },
  ]);
  assert.match(summary, /messages were dropped/);
});

test("compact degrades to a summary-free record when summarization fails", async () => {
  const agent = makeAgent(
    fakeClient(async () => {
      throw Object.assign(new Error("rate limited"), { status: 429 });
    }),
    longHistory()
  );

  const note = await agent.compact();

  assert.match(note, /WITHOUT a summary/);
  assert.ok(agent.history.length < longHistory().length, "history was still shortened");
  const head = String(agent.history[0].content);
  assert.match(head, /messages were dropped/);
  assert.match(head, /src\/file0\.ts/, "the mechanical record survived the failure");
});

test("compact still propagates cancellation rather than degrading", async () => {
  const controller = new AbortController();
  const agent = makeAgent(
    fakeClient(async () => {
      controller.abort();
      throw Object.assign(new Error("Aborted"), { name: "AbortError" });
    }),
    longHistory()
  );

  await assert.rejects(() => agent.compact(controller.signal), /Aborted/);
});

test("a turn compacts before sending when the prompt is predicted to overflow", async () => {
  const seen: number[] = [];
  const agent = makeAgent(
    fakeClient(async (messages) => {
      if (isSummarizationRequest(messages)) return reply("a summary of earlier work");
      seen.push(messages.length);
      return reply("done");
    }),
    longHistory()
  );
  // Small enough that the estimator alone must trigger compaction — nothing
  // has reported usage yet, so the post-call threshold cannot have fired.
  agent.contextWindow = 200;
  const handlers = recordingHandlers();

  await agent.runTurn("go", handlers);

  assert.equal(seen.length, 1, "one real model call");
  assert.ok(seen[0] < longHistory().length, "it was sent a compacted history");
  assert.ok(
    handlers.toolEnds.some((t) => t.name === "compact" && /predicted overflow/.test(t.summary)),
    "the pre-flight compaction was reported to the user"
  );
});

test("a context-overflow rejection is recovered by compacting and re-sending once", async () => {
  let realCalls = 0;
  const agent = makeAgent(
    fakeClient(async (messages) => {
      if (isSummarizationRequest(messages)) return reply("summary");
      if (++realCalls === 1) {
        throw Object.assign(new Error("maximum context length is 8192 tokens"), { status: 400 });
      }
      return reply("recovered");
    }),
    longHistory()
  );
  const handlers = recordingHandlers();

  await agent.runTurn("go", handlers);

  assert.equal(realCalls, 2, "the request was retried after compaction");
  assert.deepEqual(handlers.finalText, ["recovered"]);
  assert.ok(handlers.toolEnds.some((t) => /Context overflow/.test(t.summary)));
});

test("a context overflow that compaction cannot fix surfaces instead of looping", async () => {
  let realCalls = 0;
  const agent = makeAgent(
    fakeClient(async (messages) => {
      if (isSummarizationRequest(messages)) return reply("summary");
      realCalls++;
      throw Object.assign(new Error("maximum context length is 8192 tokens"), { status: 400 });
    }),
    longHistory()
  );

  await assert.rejects(() => agent.runTurn("go", recordingHandlers()), /maximum context length/);
  assert.equal(realCalls, 2, "recovery is attempted exactly once per step");
});

test("a failed auto-compaction does not destroy the turn", async () => {
  // Compaction is reached via the post-call threshold, and every model call
  // fails except the turn's own — including the summarization one.
  let realCalls = 0;
  const agent = makeAgent(
    fakeClient(async (messages) => {
      if (isSummarizationRequest(messages)) throw new Error("summarizer unavailable");
      realCalls++;
      return {
        ...reply("answered"),
        usage: { promptTokens: 100_000, completionTokens: 10 },
      };
    }),
    longHistory()
  );
  agent.contextWindow = 100_000; // usage above the 0.8 threshold
  const handlers = recordingHandlers();

  await agent.runTurn("go", handlers);

  assert.equal(realCalls, 1);
  assert.deepEqual(handlers.finalText, ["answered"], "the turn's answer still reached the user");
});
