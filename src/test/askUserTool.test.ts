import assert from "node:assert/strict";
import { test } from "node:test";
import { askUserTool } from "../tools/askUser.js";
import type { ElicitationField, ElicitationResult, ToolContext } from "../types.js";

function ctxWith(
  respond: (message: string, fields: ElicitationField[]) => Promise<ElicitationResult>
): ToolContext {
  return { workspace: "/tmp", requestElicitation: respond };
}

test("execute rejects an empty question", async () => {
  await assert.rejects(
    () =>
      askUserTool.execute(
        { question: "  ", options: ["a", "b"] },
        ctxWith(async () => ({ action: "cancel" }))
      ),
    /question must not be empty/
  );
});

test("execute rejects fewer than 2 options", async () => {
  await assert.rejects(
    () =>
      askUserTool.execute(
        { question: "Which db?", options: ["sqlite"] },
        ctxWith(async () => ({ action: "cancel" }))
      ),
    /at least 2 choices/
  );
});

test("execute rejects more options than the cap allows", async () => {
  const options = Array.from({ length: 10 }, (_, i) => `opt${i}`);
  await assert.rejects(
    () =>
      askUserTool.execute(
        { question: "Which?", options },
        ctxWith(async () => ({ action: "cancel" }))
      ),
    /at most \d+ choices/
  );
});

test("execute reports unavailable when the session has no one to ask", async () => {
  const out = await askUserTool.execute(
    { question: "Which db?", options: ["sqlite", "postgres"] },
    { workspace: "/tmp" }
  );
  assert.match(out, /not available in this session/);
});

test("execute offers the given options plus an automatic Other, and reports the pick", async () => {
  let seenFields: ElicitationField[] = [];
  const ctx = ctxWith(async (_message, fields) => {
    seenFields = fields;
    return { action: "accept", content: { choice: "postgres" } };
  });
  const out = await askUserTool.execute(
    { question: "Which db?", options: ["sqlite", "postgres"] },
    ctx
  );
  assert.equal(out, "The user chose: postgres");
  assert.equal(seenFields.length, 1);
  assert.equal(seenFields[0].kind, "enum");
  if (seenFields[0].kind === "enum") {
    assert.deepEqual(seenFields[0].options, ["sqlite", "postgres", "Other (type my own answer)"]);
  }
});

test("execute follows up with a free-text field when the user picks Other", async () => {
  let call = 0;
  const ctx = ctxWith(async (_message, fields): Promise<ElicitationResult> => {
    call++;
    if (call === 1) {
      return { action: "accept", content: { choice: "Other (type my own answer)" } };
    }
    assert.equal(fields[0].kind, "string");
    return { action: "accept", content: { answer: "MongoDB, we already run it elsewhere" } };
  });
  const out = await askUserTool.execute(
    { question: "Which db?", options: ["sqlite", "postgres"] },
    ctx
  );
  assert.equal(call, 2);
  assert.equal(out, "The user answered: MongoDB, we already run it elsewhere");
});

test("execute reports a decline or cancel as a signal to proceed without an answer", async () => {
  const declined = await askUserTool.execute(
    { question: "Which db?", options: ["sqlite", "postgres"] },
    ctxWith(async () => ({ action: "decline" }))
  );
  assert.match(declined, /best judgment/);

  const cancelled = await askUserTool.execute(
    { question: "Which db?", options: ["sqlite", "postgres"] },
    ctxWith(async () => ({ action: "cancel" }))
  );
  assert.match(cancelled, /best judgment/);
});

test("summarize previews the question", () => {
  assert.equal(
    askUserTool.summarize({ question: "Which database should we use?" }),
    "Ask: Which database should we use?"
  );
});
