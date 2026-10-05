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

test("execute forwards the runner's status with a 1-based position for the batch", async () => {
  const ctx: ToolContext = {
    workspace: "/tmp",
    spawnAgents: async (specs, _signal, onProgress) => {
      onProgress?.(1, "step 4/15 · grep src/auth");
      onProgress?.(0, "done — found it");
      return specs.map((s) => ({ task: s.task, write: false, summary: "found it" }));
    },
  };
  const updates: string[] = [];
  await spawnAgentTool.execute({ tasks: ["a", "b"] }, ctx, undefined, (t) => updates.push(t));
  assert.deepEqual(updates, [
    "subagent 2/2 · step 4/15 · grep src/auth",
    "subagent 1/2 · done — found it",
  ]);
});

test("a lone failing subagent's reason is not lost on the bare-summary path", async () => {
  // This path returns the summary with no header, which used to mean a single
  // failing subagent came back as a bare string with the reason nowhere.
  const ctx: ToolContext = {
    workspace: "/tmp",
    spawnAgents: async () => [
      {
        task: "find x",
        write: false,
        summary: "partial progress",
        error: "timed out before finishing",
      },
    ],
  };
  const out = await spawnAgentTool.execute({ tasks: ["find x"] }, ctx);
  assert.match(out, /^partial progress\n\n\[error: timed out before finishing\]$/);
});

test("a subagent that hit its step cap says so, per section", async () => {
  const results: SubagentResult[] = [
    { task: "wide search", write: false, summary: "some hits", stoppedEarly: "max-steps" },
    { task: "narrow search", write: false, summary: "all hits" },
  ];
  const ctx: ToolContext = { workspace: "/tmp", spawnAgents: async () => results };
  const out = await spawnAgentTool.execute({ tasks: ["wide search", "narrow search"] }, ctx);
  assert.match(out, /--- Subagent 1: wide search ---\nsome hits\n\[stopped early:/);
  assert.doesNotMatch(out, /--- Subagent 2: narrow search ---[\s\S]*stopped early/);
});
