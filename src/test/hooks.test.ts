import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { HookRunner, loadHooks } from "../hooks/hooks.js";

function workspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kritya-hooks-test-"));
  fs.mkdirSync(path.join(dir, ".kritya"), { recursive: true });
  return dir;
}

function writeSettings(ws: string, hooks: unknown): void {
  fs.writeFileSync(path.join(ws, ".kritya", "settings.json"), JSON.stringify({ hooks }, null, 2));
}

const NODE = process.execPath;

test("loadHooks reads workspace-declared hooks when the workspace is trusted", () => {
  const ws = workspace();
  writeSettings(ws, { postToolUse: [{ match: "edit_file", command: "true" }] });
  const hooks = loadHooks(ws, true);
  assert.equal(hooks.postToolUse?.length, 1);
  assert.equal(hooks.postToolUse?.[0].command, "true");
});

test("loadHooks ignores workspace hooks when the workspace isn't trusted", () => {
  const ws = workspace();
  writeSettings(ws, { postToolUse: [{ match: "edit_file", command: "true" }] });
  const hooks = loadHooks(ws, false);
  assert.deepEqual(hooks.postToolUse ?? [], []);
});

test("loadHooks tolerates a missing or malformed settings.json", () => {
  const ws = workspace();
  fs.writeFileSync(path.join(ws, ".kritya", "settings.json"), "{ not valid json");
  const hooks = loadHooks(ws, true);
  assert.deepEqual(hooks, {});

  const noFile = fs.mkdtempSync(path.join(os.tmpdir(), "kritya-hooks-nofile-"));
  assert.deepEqual(loadHooks(noFile, true), {});
});

test("HookRunner.has reflects whether an event has any hooks configured", () => {
  const runner = new HookRunner({ stop: [{ command: "true" }] }, os.tmpdir());
  assert.equal(runner.has("stop"), true);
  assert.equal(runner.has("preToolUse"), false);
});

test("runToolHooks only runs hooks whose match regex tests the tool name", () => {
  const marker = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "kritya-hooks-out-")), "ran.txt");
  const runner = new HookRunner(
    {
      postToolUse: [
        {
          match: "^shell$",
          command: `${quoted(NODE)} -e "require('fs').writeFileSync(${quoted(marker)}, 'ran')"`,
        },
      ],
    },
    os.tmpdir()
  );

  return runner.runToolHooks("postToolUse", "read_file", {}).then((result) => {
    assert.equal(result.blocked, false);
    assert.equal(
      fs.existsSync(marker),
      false,
      "the non-matching tool name must not trigger the hook"
    );
  });
});

function quoted(s: string): string {
  return JSON.stringify(s);
}

test("a blocking preToolUse hook that fails reports blocked=true with its own output", async () => {
  const runner = new HookRunner(
    {
      preToolUse: [
        {
          command: `${quoted(NODE)} -e "console.error('nope'); process.exit(1)"`,
          blocking: true,
        },
      ],
    },
    os.tmpdir()
  );
  const result = await runner.runToolHooks("preToolUse", "shell", {});
  assert.equal(result.blocked, true);
  assert.match(result.output, /nope/);
});

test("a non-blocking preToolUse hook that fails does not block the call", async () => {
  const runner = new HookRunner(
    {
      preToolUse: [{ command: `${quoted(NODE)} -e "process.exit(1)"`, blocking: false }],
    },
    os.tmpdir()
  );
  const result = await runner.runToolHooks("preToolUse", "shell", {});
  assert.equal(result.blocked, false);
});

test("runToolHooks exposes tool name/path/command as env vars to the hook command", async () => {
  const runner = new HookRunner(
    {
      postToolUse: [
        {
          command: `${quoted(NODE)} -e "console.log(process.env.KRITYA_TOOL_NAME + '|' + process.env.KRITYA_TOOL_PATH)"`,
        },
      ],
    },
    os.tmpdir()
  );
  const result = await runner.runToolHooks("postToolUse", "edit_file", { path: "src/x.ts" });
  assert.equal(result.blocked, false);
  assert.match(result.output, /edit_file\|src\/x\.ts/);
});

test("runStop runs every configured stop hook without throwing on failure", async () => {
  const runner = new HookRunner(
    {
      stop: [
        { command: `${quoted(NODE)} -e "process.exit(1)"` },
        { command: `${quoted(NODE)} -e "process.exit(0)"` },
      ],
    },
    os.tmpdir()
  );
  await assert.doesNotReject(runner.runStop());
});
