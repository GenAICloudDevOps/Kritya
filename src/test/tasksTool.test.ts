import assert from "node:assert/strict";
import { test } from "node:test";
import { updateTasksTool } from "../tools/tasks.js";
import type { TaskItem, ToolContext } from "../types.js";

test("execute rejects a non-array tasks argument", async () => {
  await assert.rejects(
    () => updateTasksTool.execute({ tasks: "not an array" }, { workspace: "/tmp" }),
    /tasks must be an array/
  );
});

test("execute normalizes tasks and reports the update to the UI bridge", async () => {
  let seen: TaskItem[] | undefined;
  const ctx: ToolContext = { workspace: "/tmp", onTasksUpdate: (t) => (seen = t) };
  const out = await updateTasksTool.execute(
    {
      tasks: [
        { text: "step one", status: "done" },
        { text: "step two", status: "pending" },
      ],
    },
    ctx
  );
  assert.equal(out, "Task list updated (2 tasks).");
  assert.deepEqual(seen, [
    { text: "step one", status: "done" },
    { text: "step two", status: "pending" },
  ]);
});

test("execute defaults a missing or invalid status to 'pending'", async () => {
  let seen: TaskItem[] | undefined;
  const ctx: ToolContext = { workspace: "/tmp", onTasksUpdate: (t) => (seen = t) };
  await updateTasksTool.execute(
    { tasks: [{ text: "a" }, { text: "b", status: "not-a-real-status" }] },
    ctx
  );
  assert.equal(seen![0].status, "pending");
  assert.equal(seen![1].status, "pending");
});

test("execute coerces a missing text field to an empty string rather than throwing", async () => {
  let seen: TaskItem[] | undefined;
  const ctx: ToolContext = { workspace: "/tmp", onTasksUpdate: (t) => (seen = t) };
  await updateTasksTool.execute({ tasks: [{ status: "done" }] }, ctx);
  assert.equal(seen![0].text, "");
});

test("execute works fine with no onTasksUpdate callback wired up", async () => {
  const out = await updateTasksTool.execute(
    { tasks: [{ text: "a", status: "pending" }] },
    { workspace: "/tmp" }
  );
  assert.equal(out, "Task list updated (1 tasks).");
});

test("summarize reports the done/total count", () => {
  const summary = updateTasksTool.summarize({
    tasks: [
      { text: "a", status: "done" },
      { text: "b", status: "done" },
      { text: "c", status: "pending" },
    ],
  });
  assert.equal(summary, "Update tasks (2/3 done)");
});

test("summarize handles a missing or malformed tasks argument", () => {
  assert.equal(updateTasksTool.summarize({}), "Update tasks (0/0 done)");
});
