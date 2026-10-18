import assert from "node:assert/strict";
import { test } from "node:test";
import { ToolExecutor, type ToolExecutorHost } from "../agent/toolExecutor.js";
import { KillSwitch } from "../agent/killSwitch.js";
import { PermissionManager } from "../permissions/permissions.js";
import {
  classifyLaterExec,
  classifyLaterExecInShell,
  laterExecFiles,
  laterExecNotice,
  recordLaterExec,
  resetLaterExec,
  workspaceRelative,
} from "../permissions/later.js";
import { NOOP_METER } from "../telemetry/metrics.js";
import { NOOP_TRACER } from "../telemetry/tracer.js";
import type { AgentHandlers, ToolDef } from "../types.js";

// --- classification ---------------------------------------------------------

test("classifyLaterExec flags the files that run code after the agent stops", () => {
  const cases: Array<[string, RegExp]> = [
    [".git/hooks/pre-commit", /git hook/],
    [".git/hooks/pre-push", /git hook/],
    [".husky/pre-commit", /husky/],
    [".git/config", /git config/],
    [".envrc", /direnv/],
    [".vscode/tasks.json", /VS Code/],
    [".vscode/launch.json", /VS Code/],
    [".pre-commit-config.yaml", /pre-commit/],
  ];
  for (const [p, re] of cases) {
    const label = classifyLaterExec(p);
    assert.ok(label, `${p} must be flagged`);
    assert.match(label!, re);
  }
});

test("classifyLaterExec ignores the sample hooks git ships and ordinary files", () => {
  assert.equal(classifyLaterExec(".git/hooks/pre-commit.sample"), null);
  assert.equal(classifyLaterExec("src/index.ts"), null);
  assert.equal(classifyLaterExec(".gitignore"), null);
  assert.equal(classifyLaterExec(".vscode/extensions.json"), null);
});

test("classifyLaterExec only flags package.json when a lifecycle script is written", () => {
  // A dependency bump must not prompt — that would train the user to click
  // through the one that matters.
  assert.equal(classifyLaterExec("package.json", '{"dependencies": {"openai": "^7.38.0"}}'), null);
  assert.match(
    classifyLaterExec("package.json", '{"scripts": {"postinstall": "node x.js"}}')!,
    /npm runs them/
  );
  assert.match(
    classifyLaterExec("package.json", '{"scripts": {"prepare": "husky"}}')!,
    /npm runs them/
  );
  assert.match(
    classifyLaterExec("package.json", '{"scripts": {"prepublishOnly": "npm test"}}')!,
    /npm runs them/
  );
  // No content to inspect means no claim either way.
  assert.equal(classifyLaterExec("package.json"), null);
});

test("classifyLaterExec normalises Windows separators and a leading ./", () => {
  assert.ok(classifyLaterExec(".git\\hooks\\pre-commit"));
  assert.ok(classifyLaterExec("./.git/hooks/pre-commit"));
});

test("workspaceRelative refuses paths outside the workspace", () => {
  assert.equal(workspaceRelative("/ws", ".git/hooks/x"), ".git/hooks/x");
  assert.equal(workspaceRelative("/ws", "/ws/.envrc"), ".envrc");
  assert.equal(workspaceRelative("/ws", "../etc/passwd"), null);
  assert.equal(workspaceRelative("/ws", "/etc/passwd"), null);
});

test("classifyLaterExecInShell reads redirect targets, not the whole command", () => {
  assert.equal(
    classifyLaterExecInShell("echo hi > notes.txt", "/ws"),
    null,
    "an ordinary redirect is not a hook"
  );
  const hook = classifyLaterExecInShell("printf 'x' > .git/hooks/pre-commit", "/ws");
  assert.equal(hook?.path, ".git/hooks/pre-commit");
  assert.match(hook!.label, /git hook/);

  const quoted = classifyLaterExecInShell('echo x >> ".envrc"', "/ws");
  assert.equal(quoted?.path, ".envrc");

  assert.equal(
    classifyLaterExecInShell("npm test > /dev/null", "/ws"),
    null,
    "discarding output is not a write to a runnable file"
  );
  assert.equal(
    classifyLaterExecInShell("echo x > /etc/passwd", "/ws"),
    null,
    "outside the workspace is a different problem, handled elsewhere"
  );
});

// --- session record ---------------------------------------------------------

test("the session record keeps one entry per path and sorts for a stable list", () => {
  resetLaterExec();
  recordLaterExec({ path: "package.json", label: "package.json scripts" });
  recordLaterExec({ path: ".git/hooks/pre-commit", label: "a git hook" });
  recordLaterExec({ path: "package.json", label: "package.json scripts" });
  assert.deepEqual(
    laterExecFiles().map((f) => f.path),
    [".git/hooks/pre-commit", "package.json"]
  );
  resetLaterExec();
  assert.deepEqual(laterExecFiles(), []);
});

test("laterExecNotice says nothing when nothing was touched, and names what was", () => {
  assert.equal(laterExecNotice([]), null);
  const one = laterExecNotice([{ path: ".envrc", label: "direnv config" }])!;
  assert.match(one, /1 file here can run code later/);
  assert.match(one, /\.envrc/);
  assert.match(one, /direnv config/);
  const two = laterExecNotice([
    { path: ".envrc", label: "direnv config" },
    { path: "package.json", label: "package.json scripts" },
  ])!;
  assert.match(two, /2 files here can run code later/);
});

// --- executor integration ---------------------------------------------------

function makeHost(overrides: Partial<ToolExecutorHost> = {}): ToolExecutorHost {
  return {
    ctx: { workspace: "/ws" },
    permissions: new PermissionManager(["write_file(*)", "shell(*)"], "/ws"),
    kill: new KillSwitch(),
    planMode: false,
    dryRunMode: false,
    acceptEdits: false,
    bypassMode: false,
    interactive: true,
    tracer: NOOP_TRACER,
    meter: NOOP_METER,
    turnSpan: undefined,
    toolTimeoutMs: 0,
    ...overrides,
  };
}

function makeHandlers(onPrompt?: (danger?: string) => void): AgentHandlers {
  return {
    onTextDelta() {},
    onReasoningDelta() {},
    onAssistantText() {},
    onToolStart() {},
    onToolEnd() {},
    requestPermission: async (_tool, _details, _diff, danger) => {
      onPrompt?.(danger);
      return "yes";
    },
    onUsage() {},
  };
}

const writeTool: ToolDef = {
  name: "write_file",
  description: "test-only write tool",
  parameters: {},
  requiresPermission: true,
  summarize: (args) => `write(${String((args as { path?: string }).path)})`,
  execute: async () => "wrote 1 line",
};

const shellTool: ToolDef = {
  name: "shell",
  description: "test-only shell tool",
  parameters: {},
  requiresPermission: true,
  summarize: (args) => `shell(${String((args as { command?: string }).command)})`,
  execute: async () => "ok",
};

test("writing a git hook prompts even when an allow rule covers every write", async () => {
  resetLaterExec();
  const warnings: Array<string | undefined> = [];
  const executor = new ToolExecutor([writeTool], makeHost());
  await executor.executeToolCalls(
    [{ id: "c1", name: "write_file", argsJson: JSON.stringify({ path: ".git/hooks/pre-commit" }) }],
    makeHandlers((danger) => warnings.push(danger))
  );
  assert.equal(warnings.length, 1, "the write must be confirmed, not waved through");
  assert.match(warnings[0] ?? "", /git hook/);
  assert.deepEqual(
    laterExecFiles().map((f) => f.path),
    [".git/hooks/pre-commit"],
    "and it must reach the end-of-session list"
  );
});

test("writing an ordinary file still rides on the allow rule", async () => {
  resetLaterExec();
  const warnings: Array<string | undefined> = [];
  const executor = new ToolExecutor([writeTool], makeHost());
  await executor.executeToolCalls(
    [{ id: "c1", name: "write_file", argsJson: JSON.stringify({ path: "src/index.ts" }) }],
    makeHandlers((danger) => warnings.push(danger))
  );
  assert.deepEqual(warnings, [], "no prompt for a file that runs nothing");
  assert.deepEqual(laterExecFiles(), []);
});

test("--accept-edits does not skip the hook prompt", async () => {
  resetLaterExec();
  const warnings: Array<string | undefined> = [];
  const executor = new ToolExecutor([writeTool], makeHost({ acceptEdits: true }));
  await executor.executeToolCalls(
    [{ id: "c1", name: "write_file", argsJson: JSON.stringify({ path: ".envrc" }) }],
    makeHandlers((danger) => warnings.push(danger))
  );
  assert.equal(warnings.length, 1);
  assert.match(warnings[0] ?? "", /direnv/);
});

test("a shell redirect into a hook prompts too", async () => {
  resetLaterExec();
  const warnings: Array<string | undefined> = [];
  const executor = new ToolExecutor([shellTool], makeHost());
  await executor.executeToolCalls(
    [
      {
        id: "c1",
        name: "shell",
        argsJson: JSON.stringify({ command: "printf x > .git/hooks/pre-commit" }),
      },
    ],
    makeHandlers((danger) => warnings.push(danger))
  );
  assert.equal(warnings.length, 1);
  assert.match(warnings[0] ?? "", /git hook/);
});

test("a headless run is not prompted but is still recorded", async () => {
  // A write subagent auto-refuses anything carrying a danger label, so
  // prompting there would turn every package.json edit into a refusal. The
  // record still happens, which is what the sign-off list reads.
  resetLaterExec();
  const warnings: Array<string | undefined> = [];
  const executor = new ToolExecutor([writeTool], makeHost({ interactive: false }));
  await executor.executeToolCalls(
    [{ id: "c1", name: "write_file", argsJson: JSON.stringify({ path: ".envrc" }) }],
    makeHandlers((danger) => warnings.push(danger))
  );
  assert.deepEqual(warnings, []);
  assert.deepEqual(
    laterExecFiles().map((f) => f.path),
    [".envrc"]
  );
});
