import assert from "node:assert/strict";
import { test } from "node:test";
import { applyEdit } from "../tools/fuzzyMatch.js";

test("exact match replaces once", () => {
  const r = applyEdit("hello world", "world", "there", false);
  assert.equal(r.matched, true);
  assert.equal(r.strategy, "exact");
  assert.equal(r.result, "hello there");
});

test("exact match rejects ambiguity without replace_all", () => {
  const r = applyEdit("a a a", "a", "b", false);
  assert.equal(r.matched, true);
  assert.equal(r.count, 3);
  assert.equal(r.result, undefined);
});

test("exact match replace_all", () => {
  const r = applyEdit("a a a", "a", "b", true);
  assert.equal(r.result, "b b b");
});

test("line-trimmed fallback tolerates indentation differences", () => {
  const content = "function f() {\n  return 1;\n}\n";
  // Model reproduced the body with extra indentation not present in the file,
  // so no exact substring exists and the fallback must kick in.
  const r = applyEdit(content, "      return 1;", "      return 2;", false);
  assert.equal(r.matched, true);
  assert.equal(r.strategy, "line-trimmed");
  assert.equal(r.result, "function f() {\n      return 2;\n}\n");
});

test("line-trimmed fallback matches a multi-line block", () => {
  const content = "if (x) {\n        doThing();\n        done();\n}\n";
  const oldStr = "doThing();\ndone();";
  const r = applyEdit(content, oldStr, "doOther();", false);
  assert.equal(r.matched, true);
  assert.equal(r.result, "if (x) {\ndoOther();\n}\n");
});

test("no match returns matched false", () => {
  const r = applyEdit("abc", "xyz", "q", false);
  assert.equal(r.matched, false);
  assert.equal(r.strategy, "none");
});
