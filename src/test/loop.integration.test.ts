import assert from "node:assert/strict";
import os from "node:os";
import { test } from "node:test";
import { Agent } from "../agent/loop.js";
import type { ChatResult, ParsedToolCall } from "../provider/client.js";
import type { ProviderClient } from "../provider/client.js";
import { PermissionManager } from "../permissions/permissions.js";
import { SessionStore } from "../session/store.js";
import type { AgentHandlers, ChatMessage, PermissionDecision, ToolContext, ToolDef } from "../types.js";

/**
 * Scripts a sequence of model round-trips: call N of `client.chat()` returns
 * `rounds[N]`. Throws if the loop asks for more rounds than were scripted,
 * which turns an unbounded/looping bug into a fast, obvious test failure.
 */
function scriptedClient(rounds: ChatResult[]): { client: ProviderClient; callCount: () => number } {
  let i = 0;
  const client = {
    chat: async (): Promise<ChatResult> => {
      if (i >= rounds.length) throw new Error(`unexpected chat() call #${i + 1} — only ${rounds.length} scripted`);
      return rounds[i++];
    },
  } as unknown as ProviderClient;
  return { client, callCount: () => i };
}

function assistantToolCallMsg(calls: ParsedToolCall[]): ChatMessage {
  return {
    role: "assistant",
    content: null,
    tool_calls: calls.map((c) => ({
      id: c.id,
      type: "function" as const,
      function: { name: c.name, arguments: c.argsJson },
    })),
  };
}

function toolRound(calls: ParsedToolCall[]): ChatResult {
  return {
    message: assistantToolCallMsg(calls),
    text: "",
    toolCalls: calls,
    usage: { promptTokens: 100, completionTokens: 10 },
  };
}

function textRound(text: string): ChatResult {
  return {
    message: { role: "assistant", content: text },
    text,
    toolCalls: [],
    usage: { promptTokens: 100, completionTokens: 10 },
  };
}

function fakeTool(
  name: string,
  opts: Partial<ToolDef> & { output?: string } = {}
): ToolDef & { calls: Record<string, unknown>[] } {
  const calls: Record<string, unknown>[] = [];
  const tool = {
    name,
    description: name,
    parameters: {},
    requiresPermission: opts.requiresPermission ?? false,
    external: opts.external,
    summarize: opts.summarize ?? (() => name),
    execute: async (args: Record<string, unknown>) => {
      calls.push(args);
      return opts.output ?? `${name}-result`;
    },
    calls,
  };
  return tool;
}

interface HandlerLog {
  texts: string[];
  toolStarts: string[];
  toolEnds: { name: string; isError: boolean }[];
  handlers: AgentHandlers;
}

function makeHandlers(permissionDecision: PermissionDecision = "yes"): HandlerLog {
  const log: HandlerLog = {
    texts: [],
    toolStarts: [],
    toolEnds: [],
    handlers: {
      onTextDelta() {},
      onReasoningDelta() {},
      onAssistantText(text) {
        log.texts.push(text);
      },
      onToolStart(name) {
        log.toolStarts.push(name);
      },
      onToolEnd(name, _summary, _preview, isError) {
        log.toolEnds.push({ name, isError });
      },
      async requestPermission() {
        return permissionDecision;
      },
      onUsage() {},
    },
  };
  return log;
}

function makeAgent(client: ProviderClient, tools: ToolDef[]): Agent {
  const ctx: ToolContext = { workspace: os.tmpdir() };
  return new Agent(
    client,
    () => "test-model",
    tools,
    ctx,
    new PermissionManager(),
    new SessionStore(os.tmpdir(), true)
  );
}

test("runTurn drives a multi-round tool-call sequence to a final answer", async () => {
  const readTool = fakeTool("read_file", { output: "file contents here" });
  const writeTool = fakeTool("write_file", { requiresPermission: true });

  const { client, callCount } = scriptedClient([
    toolRound([{ id: "call_1", name: "read_file", argsJson: "{}" }]),
    toolRound([{ id: "call_2", name: "write_file", argsJson: '{"path":"a.ts"}' }]),
    textRound("Done — read and updated a.ts."),
  ]);

  const agent = makeAgent(client, [readTool, writeTool]);
  const log = makeHandlers("yes");

  await agent.runTurn("read a.ts then update it", log.handlers);

  assert.equal(callCount(), 3, "the loop drove exactly three model round-trips");
  assert.equal(readTool.calls.length, 1);
  assert.equal(writeTool.calls.length, 1);
  assert.deepEqual(log.toolStarts, ["read_file", "write_file"]);
  assert.deepEqual(
    log.toolEnds.map((e) => e.name),
    ["read_file", "write_file"]
  );
  assert.equal(log.texts.at(-1), "Done — read and updated a.ts.");

  // History interleaves correctly: user, assistant(call_1), tool(call_1),
  // assistant(call_2), tool(call_2), assistant(final text).
  const roles = agent.history.map((m) => m.role);
  assert.deepEqual(roles, ["user", "assistant", "tool", "assistant", "tool", "assistant"]);
  const firstTool = agent.history[2] as { tool_call_id: string; content: string };
  assert.equal(firstTool.tool_call_id, "call_1");
  assert.equal(firstTool.content, "file contents here");
});

test("runTurn blocks a mutating tool in plan mode without executing it, then continues the loop", async () => {
  const writeTool = fakeTool("write_file", { requiresPermission: true });

  const { client } = scriptedClient([
    toolRound([{ id: "call_1", name: "write_file", argsJson: '{"path":"a.ts"}' }]),
    textRound("Understood, staying read-only."),
  ]);

  const agent = makeAgent(client, [writeTool]);
  agent.planMode = true;
  const log = makeHandlers("yes");

  await agent.runTurn("update a.ts", log.handlers);

  assert.equal(writeTool.calls.length, 0, "tool never executed in plan mode");
  const blockedEnd = log.toolEnds.find((e) => e.name === "write_file");
  assert.ok(blockedEnd?.isError, "blocked call is reported as an error to the UI");
  const toolMsg = agent.history.find((m) => m.role === "tool") as { content: string };
  assert.match(String(toolMsg.content), /plan mode/i);
  assert.equal(log.texts.at(-1), "Understood, staying read-only.");
});

test("runTurn feeds a user permission denial back to the model instead of executing the tool", async () => {
  const writeTool = fakeTool("write_file", { requiresPermission: true });

  const { client } = scriptedClient([
    toolRound([{ id: "call_1", name: "write_file", argsJson: '{"path":"a.ts"}' }]),
    textRound("Okay, I won't write that file."),
  ]);

  const agent = makeAgent(client, [writeTool]);
  const log = makeHandlers("no");

  await agent.runTurn("update a.ts", log.handlers);

  assert.equal(writeTool.calls.length, 0);
  const toolMsg = agent.history.find((m) => m.role === "tool") as { content: string };
  assert.match(String(toolMsg.content), /denied permission/i);
  assert.equal(log.texts.at(-1), "Okay, I won't write that file.");
});

test("runTurn stops at maxSteps and reports the safety-limit message", async () => {
  const readTool = fakeTool("read_file");

  // Every round asks for another tool call — the model never naturally stops.
  const { client, callCount } = scriptedClient([
    toolRound([{ id: "call_1", name: "read_file", argsJson: "{}" }]),
    toolRound([{ id: "call_2", name: "read_file", argsJson: "{}" }]),
  ]);

  const agent = makeAgent(client, [readTool]);
  agent.maxSteps = 2;
  const log = makeHandlers("yes");

  await agent.runTurn("keep reading forever", log.handlers);

  assert.equal(callCount(), 2, "loop stopped after exactly maxSteps model calls");
  assert.equal(readTool.calls.length, 2);
  assert.match(log.texts.at(-1)!, /Stopped after 2 steps/);
});

test("runTurn repairs a dangling tool call left by a previously cancelled turn before the next request", async () => {
  const readTool = fakeTool("read_file");
  const { client } = scriptedClient([textRound("continuing now.")]);

  const agent = makeAgent(client, [readTool]);
  // Simulate a prior turn that was cancelled mid-tool-call: an assistant
  // message with a tool_calls entry that never got a matching tool result.
  agent.history = [
    { role: "user", content: "do something" },
    assistantToolCallMsg([{ id: "call_1", name: "read_file", argsJson: "{}" }]),
  ];
  const log = makeHandlers("yes");

  await agent.runTurn("continue", log.handlers);

  const toolMsgs = agent.history.filter((m) => m.role === "tool");
  assert.equal(toolMsgs.length, 1);
  assert.match(String((toolMsgs[0] as { content: string }).content), /interrupted/);
  assert.equal(log.texts.at(-1), "continuing now.");
});
