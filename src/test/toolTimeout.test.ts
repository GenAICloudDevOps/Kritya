import assert from "node:assert/strict";
import os from "node:os";
import { test } from "node:test";
import { Agent } from "../agent/loop.js";
import type { ChatResult, ProviderClient } from "../provider/client.js";
import { PermissionManager } from "../permissions/permissions.js";
import { SessionStore } from "../session/store.js";
import type { AgentHandlers, ChatMessage, ToolDef } from "../types.js";

/** A model that calls `toolName` once, then answers on the next round. */
function clientCalling(toolName: string): ProviderClient {
  let called = false;
  return {
    chat: async (): Promise<ChatResult> => {
      if (called) {
        return { message: { role: "assistant", content: "done" }, text: "done", toolCalls: [] };
      }
      called = true;
      return {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "c1", type: "function", function: { name: toolName, arguments: "{}" } },
          ],
        } as ChatMessage,
        text: "",
        toolCalls: [{ id: "c1", name: toolName, argsJson: "{}" }],
      };
    },
  } as unknown as ProviderClient;
}

function makeAgent(client: ProviderClient, tools: ToolDef[]): Agent {
  return new Agent(
    client,
    () => "test-model",
    tools,
    { workspace: os.tmpdir() },
    new PermissionManager(),
    new SessionStore(os.tmpdir(), true),
    []
  );
}

function handlers(): AgentHandlers & { toolEnds: { error: boolean; preview: string }[] } {
  const toolEnds: { error: boolean; preview: string }[] = [];
  return {
    toolEnds,
    onTextDelta: () => {},
    onReasoningDelta: () => {},
    onAssistantText: () => {},
    onToolStart: () => {},
    onToolEnd: (_id, _name, _summary, preview, isError) =>
      toolEnds.push({ error: isError, preview }),
    requestPermission: async () => "yes",
    onUsage: () => {},
  };
}

/** A tool that never resolves — the hang this whole feature exists for. */
function hangingTool(overrides: Partial<ToolDef> = {}): ToolDef {
  return {
    name: "hangs",
    description: "never returns",
    parameters: { type: "object", properties: {} },
    requiresPermission: false,
    summarize: () => "hangs",
    // Unref'd: an abandoned tool must never keep the process alive.
    execute: () =>
      new Promise<string>((resolve) => setTimeout(() => resolve("late"), 60_000).unref()),
    ...overrides,
  };
}

function quickTool(): ToolDef {
  return {
    name: "quick",
    description: "returns immediately",
    parameters: { type: "object", properties: {} },
    requiresPermission: false,
    summarize: () => "quick",
    execute: async () => "fast result",
  };
}

test("a hanging tool is abandoned and the turn continues", async () => {
  const agent = makeAgent(clientCalling("hangs"), [hangingTool()]);
  agent.toolTimeoutMs = 50;
  const h = handlers();

  // Without the deadline this await never returns.
  await agent.runTurn("go", h);

  assert.equal(h.toolEnds.length, 1);
  assert.equal(h.toolEnds[0].error, true);
  assert.match(h.toolEnds[0].preview, /timed out after/);
  // The model is told what happened, so it can choose a different approach.
  const toolMsg = agent.history.find((m) => m.role === "tool");
  assert.match(String(toolMsg?.content), /timed out/);
  assert.match(String(toolMsg?.content), /Do not simply retry/);
});

test("a tool that finishes in time is untouched by the deadline", async () => {
  const agent = makeAgent(clientCalling("quick"), [quickTool()]);
  agent.toolTimeoutMs = 5000;
  const h = handlers();

  await agent.runTurn("go", h);

  assert.equal(h.toolEnds.length, 1);
  assert.equal(h.toolEnds[0].error, false);
  assert.equal(h.toolEnds[0].preview, "fast result");
});

test("a tool opts out of the deadline with timeoutMs 0", async () => {
  const agent = makeAgent(clientCalling("hangs"), [
    hangingTool({
      timeoutMs: 0,
      execute: async () => {
        await new Promise((r) => setTimeout(r, 80));
        return "self-managed, finished late";
      },
    }),
  ]);
  // Far shorter than the tool takes: opting out must really opt out, or
  // `shell` and subagents would be cut off mid-run.
  agent.toolTimeoutMs = 10;
  const h = handlers();

  await agent.runTurn("go", h);

  assert.equal(h.toolEnds[0].error, false);
  assert.equal(h.toolEnds[0].preview, "self-managed, finished late");
});

test("setting the agent's timeout to 0 disables the cap for every tool", async () => {
  const agent = makeAgent(clientCalling("hangs"), [
    hangingTool({
      execute: async () => {
        await new Promise((r) => setTimeout(r, 80));
        return "no cap in force";
      },
    }),
  ]);
  agent.toolTimeoutMs = 0;
  const h = handlers();

  await agent.runTurn("go", h);

  assert.equal(h.toolEnds[0].error, false);
  assert.equal(h.toolEnds[0].preview, "no cap in force");
});

test("a tool that throws still reports its own error, not a timeout", async () => {
  const agent = makeAgent(clientCalling("hangs"), [
    hangingTool({
      execute: async () => {
        throw new Error("the tool itself failed");
      },
    }),
  ]);
  agent.toolTimeoutMs = 5000;
  const h = handlers();

  await agent.runTurn("go", h);

  assert.equal(h.toolEnds[0].error, true);
  assert.match(h.toolEnds[0].preview, /the tool itself failed/);
});
