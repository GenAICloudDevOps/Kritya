import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnAgentTool } from "../tools/subagent.js";
import type { SubagentResult, ToolContext } from "../types.js";

test("execute rejects an empty task list", async () => {
  const out = await spawnAgentTool.execute({ tasks: [] }, { workspace: "/tmp" });
  assert.match(out, /tasks is required/);
});

test("execute rejects when every task is blank", async () => {
  const out = await spawnAgentTool.execute({ tasks: ["   ", ""] }, { workspace: "/tmp" });
  assert.match(out, /tasks is required/);
});

test("execute rejects more than the max number of tasks", async () => {
  const out = await spawnAgentTool.execute(
    { tasks: ["a", "b", "c", "d", "e", "f", "g"] },
    { workspace: "/tmp" }
  );
  assert.match(out, /at most 6 tasks per call/);
});

test("execute reports when subagents aren't available in this session", async () => {
  const out = await spawnAgentTool.execute({ tasks: ["investigate x"] }, { workspace: "/tmp" });
  assert.match(out, /subagents are not available in this session/);
});

test("execute returns a single subagent's summary directly, with no header", async () => {
  const ctx: ToolContext = {
    workspace: "/tmp",
    spawnAgents: async (specs) =>
      specs.map((s) => ({ task: s.task, write: false, summary: "found it" })),
  };
  const out = await spawnAgentTool.execute({ tasks: ["find x"] }, ctx);
  assert.equal(out, "found it");
});

test("execute labels each subagent's section when several run in parallel", async () => {
  const results: SubagentResult[] = [
    { task: "task one", write: false, summary: "summary one" },
    { task: "task two", write: false, summary: "summary two" },
  ];
  const ctx: ToolContext = { workspace: "/tmp", spawnAgents: async () => results };
  const out = await spawnAgentTool.execute({ tasks: ["task one", "task two"] }, ctx);
  assert.match(out, /--- Subagent 1: task one ---\nsummary one/);
  assert.match(out, /--- Subagent 2: task two ---\nsummary two/);
});

test("execute passes read-only specs (write: false) to spawnAgents", async () => {
  let captured: { task: string; write?: boolean }[] = [];
  const ctx: ToolContext = {
    workspace: "/tmp",
    spawnAgents: async (specs) => {
      captured = specs;
      return specs.map((s) => ({ task: s.task, write: false, summary: "" }));
    },
  };
  await spawnAgentTool.execute({ tasks: ["a", "b"] }, ctx);
  assert.deepEqual(captured, [
    { task: "a", write: false },
    { task: "b", write: false },
  ]);
});

test("summarize shows a single task's text, or a count for several", () => {
  assert.equal(
    spawnAgentTool.summarize({ tasks: ["find the auth flow"] }),
    "Subagent: find the auth flow"
  );
  assert.equal(spawnAgentTool.summarize({ tasks: ["a", "b", "c"] }), "3 subagents in parallel");
});
