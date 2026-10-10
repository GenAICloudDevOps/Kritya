import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ChatMessage } from "../types.js";
import {
  BUILTIN_TEMPLATES,
  allTemplates,
  applyTemplate,
  isValidName,
  lastUserText,
  loadTemplates,
  saveTemplates,
} from "../commands/templates.js";

const user = (content: unknown): ChatMessage => ({ role: "user", content: content as string });

test("applyTemplate fills {{input}} with the words", () => {
  assert.equal(applyTemplate("Do this: {{input}}", "src/foo.ts"), "Do this: src/foo.ts");
  assert.equal(applyTemplate("{{input}} then {{input}}", "x"), "x then x");
});

test("applyTemplate appends the words when there is no placeholder", () => {
  assert.equal(applyTemplate("Review this", "src/foo.ts"), "Review this src/foo.ts");
  assert.equal(applyTemplate("Review this", ""), "Review this");
});

test("applyTemplate drops the placeholder when there are no words", () => {
  assert.equal(applyTemplate("Review this:\n\n{{input}}", ""), "Review this:");
  assert.ok(!applyTemplate("Review this:\n\n{{input}}", "").includes("{{input}}"));
});

test("isValidName accepts sane names only", () => {
  assert.equal(isValidName("review"), true);
  assert.equal(isValidName("my-template_2"), true);
  assert.equal(isValidName(""), false);
  assert.equal(isValidName("has space"), false);
  assert.equal(isValidName("semi;colon"), false);
  assert.equal(isValidName("x".repeat(33)), false);
});

test("lastUserText returns the most recent real prompt", () => {
  const history = [user("first"), user("second")];
  assert.equal(lastUserText(history), "second");
});

test("lastUserText skips command echoes and non-text messages", () => {
  const history = [
    user("real prompt"),
    user("/template save x"),
    user({ type: "text", text: "img" }),
  ];
  assert.equal(lastUserText(history), "real prompt");
  assert.equal(lastUserText([]), null);
  assert.equal(lastUserText([user("   ")]), null);
});

test("allTemplates lets user templates override built-ins", () => {
  assert.ok(BUILTIN_TEMPLATES["review"]);
  const all = allTemplates({ review: "mine" });
  assert.equal(all["review"], "mine");
  assert.equal(all["explain"], BUILTIN_TEMPLATES["explain"]);
});

test("saveTemplates and loadTemplates round-trip through a temp dir", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kritya-templates-"));
  assert.deepEqual(loadTemplates(dir), {});
  saveTemplates({ mine: "hello {{input}}" }, dir);
  assert.deepEqual(loadTemplates(dir), { mine: "hello {{input}}" });
  assert.ok(fs.existsSync(path.join(dir, "templates.json")));
});

test("loadTemplates ignores a broken file and invalid entries", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kritya-templates-"));
  fs.writeFileSync(path.join(dir, "templates.json"), "not json{");
  assert.deepEqual(loadTemplates(dir), {});
  fs.writeFileSync(
    path.join(dir, "templates.json"),
    JSON.stringify({ ok: "yes", "bad name!": "no", num: 42 })
  );
  assert.deepEqual(loadTemplates(dir), { ok: "yes" });
});
