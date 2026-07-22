import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { test } from "node:test";
import { Agent } from "../agent/loop.js";
import { KillSwitch, KillSwitchError, linkAbort } from "../agent/killSwitch.js";
import { AuditLog } from "../audit/audit.js";
import type { ChatResult, ParsedToolCall, ProviderClient } from "../provider/client.js";
import { PermissionManager } from "../permissions/permissions.js";
import { SessionStore } from "../session/store.js";
import type { AgentHandlers, ChatMessage, ToolDef } from "../types.js";

function scriptedClient(rounds: ChatResult[]): { client: ProviderClient; callCount: () => number } {
  let i = 0;
  const client = {
    chat: async (): Promise<ChatResult> => {
      if (i >= rounds.length)
        throw new Error(`unexpected chat() call #${i + 1} — only ${rounds.length} scripted`);
      return rounds[i++];
    },
  } as unknown as ProviderClient;
  return { client, callCount: () => i };
}

function toolRound(calls: ParsedToolCall[]): ChatResult {
  return {
    message: {
      role: "assistant",
      content: null,
      tool_calls: calls.map((c) => ({
        id: c.id,
        type: "function" as const,
        function: { name: c.name, arguments: c.argsJson },
      })),
    } as ChatMessage,
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
  opts: { requiresPermission?: boolean; execute?: () => Promise<string> } = {}
): ToolDef & { calls: number } {
  const tool = {
    name,
    description: name,
    parameters: {},
    requiresPermission: opts.requiresPermission ?? false,
    summarize: () => name,
    execute: async () => {
      tool.calls++;
      return opts.execute ? await opts.execute() : `${name}-result`;
    },
    calls: 0,
  };
  return tool;
}

function makeHandlers(): {
  handlers: AgentHandlers;
  permissionCount: () => number;
  toolEnds: { name: string; isError: boolean; preview: string }[];
} {
  let permissions = 0;
  const toolEnds: { name: string; isError: boolean; preview: string }[] = [];
  return {
    permissionCount: () => permissions,
    toolEnds,
    handlers: {
      onTextDelta() {},
      onReasoningDelta() {},
      onAssistantText() {},
      onToolStart() {},
      onToolEnd(_id, name, _summary, preview, isError) {
        toolEnds.push({ name, isError, preview });
      },
      async requestPermission() {
        permissions++;
        return "yes";
      },
      onUsage() {},
    },
  };
}

function makeAgent(client: ProviderClient, tools: ToolDef[]): Agent {
  return new Agent(
    client,
    () => "test-model",
    tools,
    { workspace: os.tmpdir() },
    new PermissionManager(),
    new SessionStore(os.tmpdir(), true)
  );
}

test("engage is idempotent and reports its reason; release re-arms the signal", () => {
  const kill = new KillSwitch();
  assert.equal(kill.active, false);
  assert.equal(kill.signal.aborted, false);

  assert.equal(kill.engage("bad diff"), true);
  assert.equal(kill.active, true);
  assert.equal(kill.reason, "bad diff");
  assert.equal(kill.signal.aborted, true);
  assert.equal(kill.engage("something else"), false, "a second engage is a no-op");
  assert.equal(kill.reason, "bad diff", "the original reason is kept");

  assert.equal(kill.release(), true);
  assert.equal(kill.active, false);
  assert.equal(kill.reason, undefined);
  assert.equal(kill.signal.aborted, false, "a released switch hands out a fresh signal");
  assert.equal(kill.release(), false, "releasing an idle switch is a no-op");
});

test("onChange listeners fire on engage and release, and a throwing one can't block the stop", () => {
  const kill = new KillSwitch();
  const seen: boolean[] = [];
  kill.onChange(() => {
    throw new Error("listener blew up");
  });
  const unsubscribe = kill.onChange((active) => seen.push(active));

  kill.engage();
  kill.release();
  assert.deepEqual(seen, [true, false]);
  assert.equal(kill.active, false);

  unsubscribe();
  kill.engage();
  assert.deepEqual(seen, [true, false], "unsubscribed listener stops receiving");
});

test("linkAbort aborts from either the kill switch or the caller's own signal", () => {
  const kill = new KillSwitch();
  const own = new AbortController();
  const fromKill = linkAbort(kill, own.signal);
  assert.equal(fromKill.signal.aborted, false);
  kill.engage();
  assert.equal(fromKill.signal.aborted, true, "kill switch aborts the linked signal");

  const kill2 = new KillSwitch();
  const own2 = new AbortController();
  const fromOwn = linkAbort(kill2, own2.signal);
  own2.abort();
  assert.equal(fromOwn.signal.aborted, true, "the caller's own signal still works");
  assert.equal(kill2.active, false);

  // Already-engaged switch: the linked signal comes back pre-aborted.
  const kill3 = new KillSwitch();
  kill3.engage();
  assert.equal(linkAbort(kill3, new AbortController().signal).signal.aborted, true);
});

test("runTurn refuses to start while the kill switch is engaged, and leaves history untouched", async () => {
  const { client, callCount } = scriptedClient([textRound("should never run")]);
  const agent = makeAgent(client, []);
  agent.kill.engage("user pulled it");

  await assert.rejects(
    () => agent.runTurn("do something", makeHandlers().handlers),
    (err: unknown) => {
      assert.ok(err instanceof KillSwitchError);
      assert.match(err.message, /user pulled it/);
      return true;
    }
  );
  assert.equal(callCount(), 0, "no model call was made");
  assert.equal(agent.history.length, 0, "the refused turn was not recorded");
});

test("engaging mid-turn stops the loop before the next model round-trip", async () => {
  const readTool = fakeTool("read_file");
  // The switch is created up front and handed to the agent, so a tool can trip
  // it mid-execution the way a user pressing Ctrl+K would.
  const kill = new KillSwitch();
  const tripTool = fakeTool("trip", {
    execute: async () => {
      kill.engage("tripped mid-turn");
      return "tripped";
    },
  });

  const { client, callCount } = scriptedClient([
    toolRound([{ id: "call_1", name: "trip", argsJson: "{}" }]),
    // The loop must never get here — it would need a second round-trip.
    toolRound([{ id: "call_2", name: "read_file", argsJson: "{}" }]),
  ]);

  const agent = makeAgent(client, [tripTool, readTool]);
  agent.kill = kill;
  await assert.rejects(
    () => agent.runTurn("go", makeHandlers().handlers),
    (err: unknown) => err instanceof KillSwitchError
  );

  assert.equal(callCount(), 1, "no further model calls after the switch was engaged");
  assert.equal(readTool.calls, 0, "the next round's tool never ran");
});

test("a kill mid-round blocks the remaining tool calls without prompting or executing them", async () => {
  const kill = new KillSwitch();
  const first = fakeTool("write_a", {
    requiresPermission: true,
    execute: async () => {
      kill.engage("stop now");
      return "wrote a";
    },
  });
  const second = fakeTool("write_b", { requiresPermission: true });

  const { client } = scriptedClient([
    toolRound([
      { id: "call_1", name: "write_a", argsJson: "{}" },
      { id: "call_2", name: "write_b", argsJson: "{}" },
    ]),
  ]);

  const agent = makeAgent(client, [first, second]);
  agent.kill = kill;
  const log = makeHandlers();
  await assert.rejects(
    () => agent.runTurn("write both", log.handlers),
    (err: unknown) => err instanceof KillSwitchError
  );

  assert.equal(first.calls, 1);
  assert.equal(second.calls, 0, "the second tool never executed");
  assert.equal(log.permissionCount(), 1, "the blocked call never reached a permission prompt");
  const blocked = log.toolEnds.find((e) => e.name === "write_b");
  assert.ok(blocked?.isError);
  assert.match(blocked!.preview, /kill switch/i);
  const toolMsg = agent.history.find(
    (m) => m.role === "tool" && (m as { tool_call_id: string }).tool_call_id === "call_2"
  ) as { content: string };
  assert.match(String(toolMsg.content), /kill switch is ACTIVE/i);
});

test("the kill switch outranks accept-edits mode, which would otherwise auto-approve", async () => {
  const kill = new KillSwitch();
  const trip = fakeTool("read_file", {
    execute: async () => {
      kill.engage();
      return "ok";
    },
  });
  const write = fakeTool("write_file", { requiresPermission: true });

  const { client } = scriptedClient([
    toolRound([
      { id: "call_1", name: "read_file", argsJson: "{}" },
      { id: "call_2", name: "write_file", argsJson: '{"path":"a.ts"}' },
    ]),
  ]);

  const agent = makeAgent(client, [trip, write]);
  agent.kill = kill;
  agent.acceptEdits = true;
  await assert.rejects(
    () => agent.runTurn("read then write", makeHandlers().handlers),
    (err: unknown) => err instanceof KillSwitchError
  );
  assert.equal(write.calls, 0, "accept-edits did not auto-approve past the kill switch");
});

test("a blocked call is recorded in the audit log as a kill-switch denial", async () => {
  const kill = new KillSwitch();
  const trip = fakeTool("read_file", {
    execute: async () => {
      kill.engage("audit me");
      return "ok";
    },
  });
  const write = fakeTool("write_file", { requiresPermission: true });

  const { client } = scriptedClient([
    toolRound([
      { id: "call_1", name: "read_file", argsJson: "{}" },
      { id: "call_2", name: "write_file", argsJson: "{}" },
    ]),
  ]);

  const agent = makeAgent(client, [trip, write]);
  agent.kill = kill;
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "kritya-kill-")), "s.audit.jsonl");
  agent.audit = new AuditLog("sess", file);

  await assert.rejects(
    () => agent.runTurn("go", makeHandlers().handlers),
    (err: unknown) => err instanceof KillSwitchError
  );

  const records = fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Record<string, unknown>);
  const perm = records.find((r) => r.event === "permission" && r.tool === "write_file")!;
  assert.equal(perm.verdict, "denied");
  assert.equal(perm.source, "kill-switch");
  const exec = records.find((r) => r.event === "tool" && r.tool === "write_file")!;
  assert.equal(exec.outcome, "blocked");
  assert.equal(AuditLog.verify(file).ok, true);
});

test("a subagent sharing the parent's switch is stopped by it", async () => {
  const { client: subClient, callCount: subCalls } = scriptedClient([textRound("subagent work")]);
  const parent = makeAgent(scriptedClient([]).client, []);
  const sub = makeAgent(subClient, []);
  // Mirrors how index.tsx wires a spawned subagent.
  sub.kill = parent.kill;

  parent.kill.engage("halt everything");

  await assert.rejects(
    () => sub.runTurn("do the subtask", makeHandlers().handlers),
    (err: unknown) => err instanceof KillSwitchError
  );
  assert.equal(subCalls(), 0, "the subagent never called the model");
});

test("compact() is gated too, since it calls the model outside runTurn", async () => {
  const agent = makeAgent(scriptedClient([]).client, []);
  for (let i = 0; i < 12; i++) agent.history.push({ role: "user", content: `message ${i}` });
  agent.kill.engage();
  await assert.rejects(
    () => agent.compact(),
    (err: unknown) => err instanceof KillSwitchError
  );
});

test("releasing the switch restores normal operation", async () => {
  const readTool = fakeTool("read_file");
  const { client } = scriptedClient([
    toolRound([{ id: "call_1", name: "read_file", argsJson: "{}" }]),
    textRound("all done."),
  ]);
  const agent = makeAgent(client, [readTool]);

  agent.kill.engage("temporary");
  await assert.rejects(
    () => agent.runTurn("go", makeHandlers().handlers),
    (err: unknown) => err instanceof KillSwitchError
  );

  agent.kill.release();
  await agent.runTurn("go again", makeHandlers().handlers);
  assert.equal(readTool.calls, 1, "tools run again after release");
  assert.equal(agent.history.at(-1)?.content, "all done.");
});
