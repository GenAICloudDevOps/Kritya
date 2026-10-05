import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnWriteAgentTool } from "../tools/writeAgent.js";
import type { SubagentResult, ToolContext } from "../types.js";

test("execute rejects an empty task list", async () => {
  const out = await spawnWriteAgentTool.execute({ tasks: [] }, { workspace: "/tmp" });
  assert.match(out, /tasks is required/);
});

test("execute rejects more than the max number of tasks", async () => {
  const out = await spawnWriteAgentTool.execute(
    { tasks: ["a", "b", "c", "d", "e"] },
    { workspace: "/tmp" }
  );
  assert.match(out, /at most 4 tasks per call/);
});

test("execute reports when subagents aren't available in this session", async () => {
  const out = await spawnWriteAgentTool.execute({ tasks: ["do x"] }, { workspace: "/tmp" });
  assert.match(out, /subagents are not available in this session/);
});

test("execute passes write: true specs to spawnAgents", async () => {
  let captured: { task: string; write?: boolean }[] = [];
  const ctx: ToolContext = {
    workspace: "/tmp",
    spawnAgents: async (specs) => {
      captured = specs;
      return specs.map((s) => ({ task: s.task, write: true, summary: "" }));
    },
  };
  await spawnWriteAgentTool.execute({ tasks: ["a"] }, ctx);
  assert.deepEqual(captured, [{ task: "a", write: true }]);
});

test("a successful subagent's branch is reported with review instructions", async () => {
  const results: SubagentResult[] = [
    { task: "add tests", write: true, summary: "wrote 3 tests", branch: "kritya/agent-abc" },
  ];
  const ctx: ToolContext = { workspace: "/tmp", spawnAgents: async () => results };
  const out = await spawnWriteAgentTool.execute({ tasks: ["add tests"] }, ctx);
  assert.match(out, /--- Write subagent 1: add tests ---/);
  assert.match(out, /wrote 3 tests/);
  assert.match(out, /Changes committed to branch "kritya\/agent-abc"/);
  assert.match(out, /git diff main\.\.\.kritya\/agent-abc/);
});

test("a subagent with no file changes says so instead of naming a branch", async () => {
  const results: SubagentResult[] = [
    { task: "look around", write: true, summary: "nothing to change" },
  ];
  const ctx: ToolContext = { workspace: "/tmp", spawnAgents: async () => results };
  const out = await spawnWriteAgentTool.execute({ tasks: ["look around"] }, ctx);
  assert.match(out, /\(no file changes were made\)/);
});

test("a failed subagent's error is appended instead of a branch note", async () => {
  const results: SubagentResult[] = [
    {
      task: "risky change",
      write: true,
      summary: "partial progress",
      error: "commit hook rejected it",
    },
  ];
  const ctx: ToolContext = { workspace: "/tmp", spawnAgents: async () => results };
  const out = await spawnWriteAgentTool.execute({ tasks: ["risky change"] }, ctx);
  assert.match(out, /partial progress\n\[error: commit hook rejected it\]/);
  assert.doesNotMatch(out, /no file changes were made/);
});

test("summarize shows a single task's text, or a count for several", () => {
  assert.equal(
    spawnWriteAgentTool.summarize({ tasks: ["implement the API client"] }),
    "Write subagent: implement the API client"
  );
  assert.equal(
    spawnWriteAgentTool.summarize({ tasks: ["a", "b"] }),
    "2 write subagents in parallel"
  );
});

test("execute forwards the runner's status with a 1-based position for the batch", async () => {
  const ctx: ToolContext = {
    workspace: "/tmp",
    spawnAgents: async (specs, _signal, onProgress) => {
      onProgress?.(0, "step 2/30 · edit_file");
      return specs.map((s) => ({ task: s.task, write: true, summary: "done" }));
    },
  };
  const updates: string[] = [];
  await spawnWriteAgentTool.execute({ tasks: ["a", "b"] }, ctx, undefined, (t) => updates.push(t));
  assert.deepEqual(updates, ["subagent 1/2 · step 2/30 · edit_file"]);
});

test("a step-capped write subagent gets the cap note, not the branch advice", async () => {
  // Telling someone to review a branch is wrong when the subagent stopped
  // before finishing what it was doing — the note has to win.
  const results: SubagentResult[] = [
    {
      task: "big refactor",
      write: true,
      summary: "half done",
      branch: "kritya/agent-abc",
      stoppedEarly: "max-steps",
    },
  ];
  const ctx: ToolContext = { workspace: "/tmp", spawnAgents: async () => results };
  const out = await spawnWriteAgentTool.execute({ tasks: ["big refactor"] }, ctx);
  assert.match(out, /half done\n\[stopped early:/);
  assert.doesNotMatch(out, /Changes committed to branch/);
});

test("preview lists every task with a reminder that nothing touches the real tree", async () => {
  const preview = await spawnWriteAgentTool.preview!({ tasks: ["a", "b"] }, { workspace: "/tmp" });
  assert.match(preview!, /About to run 2 write-capable subagent\(s\)/);
  assert.match(preview!, /1\. a/);
  assert.match(preview!, /2\. b/);
  assert.match(preview!, /None of this touches your working tree directly/);
});
