import assert from "node:assert/strict";
import { test } from "node:test";
import { recoverToolCalls } from "../provider/textToolCalls.js";

const TOOLS = new Set(["edit_file", "write_file", "shell", "read_file"]);

test("recovers the shape that ended a real turn with raw JSON as the answer", () => {
  // Observed verbatim: the model wrote an edit_file call into the text channel,
  // the turn ended with no tool call, and the user was shown this blob.
  const text =
    '{\n  "edit_file": {\n    "path": "test/math.test.js",\n' +
    '    "old_string": "a",\n    "new_string": "b"\n  }\n}\n```';
  const calls = recoverToolCalls(text, TOOLS);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, "edit_file");
  assert.deepEqual(JSON.parse(calls[0].argsJson), {
    path: "test/math.test.js",
    old_string: "a",
    new_string: "b",
  });
});

test("recovers the OpenAI name/arguments shape", () => {
  const calls = recoverToolCalls('{"name": "shell", "arguments": {"command": "npm test"}}', TOOLS);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, "shell");
  assert.deepEqual(JSON.parse(calls[0].argsJson), { command: "npm test" });
});

test("recovers arguments that were double-encoded as a JSON string", () => {
  const calls = recoverToolCalls(
    '{"name": "read_file", "arguments": "{\\"path\\": \\"a.ts\\"}"}',
    TOOLS
  );
  assert.deepEqual(JSON.parse(calls[0].argsJson), { path: "a.ts" });
});

test("recovers the nested function shape", () => {
  const calls = recoverToolCalls(
    '{"function": {"name": "write_file", "arguments": {"path": "x", "content": "y"}}}',
    TOOLS
  );
  assert.equal(calls[0].name, "write_file");
  assert.deepEqual(JSON.parse(calls[0].argsJson), { path: "x", content: "y" });
});

test("unwraps a fenced code block", () => {
  const calls = recoverToolCalls(
    '```json\n{"tool": "shell", "parameters": {"command": "ls"}}\n```',
    TOOLS
  );
  assert.equal(calls[0].name, "shell");
  assert.deepEqual(JSON.parse(calls[0].argsJson), { command: "ls" });
});

test("unwraps a <tool_call> tag", () => {
  const calls = recoverToolCalls(
    '<tool_call>{"name": "read_file", "arguments": {"path": "a"}}</tool_call>',
    TOOLS
  );
  assert.equal(calls[0].name, "read_file");
});

test("recovers several calls from an array", () => {
  const calls = recoverToolCalls(
    '[{"name": "read_file", "arguments": {"path": "a"}},' +
      ' {"name": "read_file", "arguments": {"path": "b"}}]',
    TOOLS
  );
  assert.equal(calls.length, 2);
  assert.notEqual(calls[0].id, calls[1].id, "each call needs its own id");
});

test("leaves ordinary prose alone", () => {
  assert.deepEqual(recoverToolCalls("I've updated the file and the tests pass.", TOOLS), []);
});

test("leaves a JSON answer the user actually asked for alone", () => {
  // No key here names a tool, so this is data, not a call.
  const text = '{\n  "name": "demo",\n  "version": "1.0.0"\n}';
  assert.deepEqual(recoverToolCalls(text, TOOLS), []);
});

test("does not fire on a tool call merely quoted inside an explanation", () => {
  const text = 'You could call it like this: {"name": "shell", "arguments": {"command": "ls"}}';
  assert.deepEqual(recoverToolCalls(text, TOOLS), []);
});

test("refuses a payload naming a tool that does not exist", () => {
  assert.deepEqual(recoverToolCalls('{"name": "delete_everything", "arguments": {}}', TOOLS), []);
});

test("refuses the whole batch when one entry is unrecognizable", () => {
  const text =
    '[{"name": "read_file", "arguments": {"path": "a"}}, {"nonsense": true, "other": 1}]';
  assert.deepEqual(recoverToolCalls(text, TOOLS), []);
});

test("recovers nothing when there are no tools to match against", () => {
  assert.deepEqual(recoverToolCalls('{"name": "shell", "arguments": {}}', new Set()), []);
});

test("a call with no arguments still yields valid empty JSON", () => {
  const calls = recoverToolCalls('{"name": "shell"}', TOOLS);
  assert.equal(calls.length, 1);
  assert.deepEqual(JSON.parse(calls[0].argsJson), {});
});
