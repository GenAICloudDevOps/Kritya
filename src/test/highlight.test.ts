import assert from "node:assert";
import { test } from "node:test";
import { tokenizeLine } from "../ui/highlight.js";

function kinds(line: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const t of tokenizeLine(line)) (out[t.kind] ??= []).push(t.text);
  return out;
}

test("tokenizes TypeScript keywords, strings, numbers", () => {
  const k = kinds('const url = "https://x.dev"; return 42;');
  assert.deepStrictEqual(k.keyword, ["const", "return"]);
  assert.deepStrictEqual(k.string, ['"https://x.dev"']);
  assert.deepStrictEqual(k.number, ["42"]);
});

test("a // inside a string is not a comment", () => {
  const k = kinds('x = "a // b" // real comment');
  assert.deepStrictEqual(k.string, ['"a // b"']);
  assert.deepStrictEqual(k.comment, ["// real comment"]);
});

test("python def and # comment", () => {
  const k = kinds("def add(a, b):  # sums");
  assert.deepStrictEqual(k.keyword, ["def"]);
  assert.deepStrictEqual(k.comment, ["# sums"]);
});

test("round-trips text losslessly", () => {
  const line = `if (n > 3.14) { call("it's ok"); } // done`;
  const joined = tokenizeLine(line)
    .map((t) => t.text)
    .join("");
  assert.strictEqual(joined, line);
});
