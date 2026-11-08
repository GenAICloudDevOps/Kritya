import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { loadRules } from "../permissions/rules.js";

function workspaceWithSettings(settings: unknown): string {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "kritya-rules-"));
  fs.mkdirSync(path.join(workspace, ".kritya"), { recursive: true });
  fs.writeFileSync(
    path.join(workspace, ".kritya", "settings.json"),
    JSON.stringify(settings),
    "utf8"
  );
  return workspace;
}

test("loadRules keeps ordinary allow and deny rules", () => {
  const workspace = workspaceWithSettings({
    allow: ["shell(git *)", "write_file"],
    deny: ["shell(rm *)"],
  });
  const rules = loadRules(workspace, true);
  assert.ok(rules.allow.includes("shell(git *)"));
  assert.ok(rules.allow.includes("write_file"));
  assert.ok(rules.deny.includes("shell(rm *)"));
});

test("loadRules drops an allow rule that carries a literal secret", () => {
  const secretRule = "shell(curl -H 'Authorization: Bearer AKIAABCDEFGHIJKLMNOP' *)";
  const workspace = workspaceWithSettings({
    allow: ["shell(git *)", secretRule],
    deny: [],
  });
  const rules = loadRules(workspace, true);
  assert.ok(rules.allow.includes("shell(git *)"));
  assert.ok(!rules.allow.includes(secretRule));
});

test("loadRules drops a deny rule that carries a literal secret", () => {
  const secretRule = "write_file(token=Zx9pQr2LmN8vTy4Wk1Bs*)";
  const workspace = workspaceWithSettings({
    allow: [],
    deny: ["shell(rm *)", secretRule],
  });
  const rules = loadRules(workspace, true);
  assert.ok(rules.deny.includes("shell(rm *)"));
  assert.ok(!rules.deny.includes(secretRule));
});

test("loadRules keeps rules that reference a value instead of spelling it out", () => {
  const workspace = workspaceWithSettings({
    allow: ["shell(curl -H 'Authorization: Bearer $API_TOKEN' *)"],
    deny: [],
  });
  const rules = loadRules(workspace, true);
  assert.ok(rules.allow.includes("shell(curl -H 'Authorization: Bearer $API_TOKEN' *)"));
});

test("loadRules still applies the workspace trust gate to allow rules", () => {
  const workspace = workspaceWithSettings({
    allow: ["shell(git *)"],
    deny: ["shell(rm *)"],
  });
  const rules = loadRules(workspace, false);
  assert.ok(!rules.allow.includes("shell(git *)"));
  assert.ok(rules.deny.includes("shell(rm *)"));
});
