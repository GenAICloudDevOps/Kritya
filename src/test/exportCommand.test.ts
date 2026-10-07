import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { runCommand, type CommandContext } from "../commands/registry.js";
import { resolveExportPath, transcriptToMarkdown } from "../session/export.js";
import type { ChatMessage } from "../types.js";
import type { ItemBody } from "../types.js";

function makeCtx(arg: string, workspace: string, history: ChatMessage[]) {
  const said: string[] = [];
  const agent = {
    history,
    sessionName: () => "fix-the-login-bug",
  };
  const ctx = {
    arg,
    raw: `/export${arg ? ` ${arg}` : ""}`,
    agent,
    workspace,
    model: "test-model",
    provider: "test-provider",
    addItem(item: ItemBody) {
      said.push("text" in item && typeof item.text === "string" ? item.text : "");
    },
  } as unknown as CommandContext;
  return { ctx, said };
}

const HISTORY: ChatMessage[] = [
  { role: "system", content: "you are a test" },
  { role: "user", content: "Fix the login bug" },
  {
    role: "assistant",
    content: "On it.",
    tool_calls: [
      {
        id: "call_1",
        type: "function",
        function: { name: "bash", arguments: JSON.stringify({ cmd: "ls" }) },
      },
    ],
  },
  { role: "tool", tool_call_id: "call_1", content: "a.ts\nb.ts" },
  { role: "assistant", content: "Done." },
];

test("transcriptToMarkdown renders turns, skips the system prompt, pairs tool results", () => {
  const md = transcriptToMarkdown(HISTORY, {
    sessionName: "fix-the-login-bug",
    model: "m",
    provider: "p",
    exportedAt: new Date("2026-10-07T05:45:00"),
  });
  assert.match(md, /# Kritya session: fix-the-login-bug/);
  assert.match(md, /## User\n\nFix the login bug/);
  assert.match(md, /## Assistant\n\nOn it\./);
  assert.match(md, /### Tool: bash/);
  assert.match(md, /a\.ts/);
  assert.ok(!md.includes("you are a test"), "the system prompt must not leak into the export");
});

test("transcriptToMarkdown truncates huge tool outputs", () => {
  const big = "x".repeat(5000);
  const md = transcriptToMarkdown([{ role: "tool", tool_call_id: "c", content: big }], {
    sessionName: "s",
    model: "m",
    provider: "p",
    exportedAt: new Date(),
  });
  assert.ok(md.length < 5000);
  assert.match(md, /truncated/);
});

test("resolveExportPath defaults, adds .md, and rejects traversal", () => {
  // A platform-appropriate workspace. A POSIX literal like "/work/proj" is not
  // drive-qualified, so resolveSafe's path.resolve() output ("D:\work\proj" on
  // Windows) never equals a path.join() of it — this failed on Windows only.
  const ws = path.resolve("/work/proj");
  const def = resolveExportPath(ws, "", "fix-the-login-bug", new Date("2026-10-07T05:45:00"));
  assert.equal(def, path.join(ws, "kritya-fix-the-login-bug-20261007-0545.md"));

  assert.equal(
    resolveExportPath(ws, "notes", "s"),
    path.join(ws, "notes.md"),
    "a bare name gets .md"
  );
  assert.equal(
    resolveExportPath(ws, "docs/notes.md", "s"),
    path.join(ws, "docs/notes.md"),
    "an explicit path is kept"
  );
  assert.throws(() => resolveExportPath(ws, "../../etc/evil.md", "s"), /outside the workspace/);
});

test("/export writes the transcript to the default file", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "kritya-export-"));
  const { ctx, said } = makeCtx("", workspace, HISTORY);

  await runCommand("/export", ctx);

  const m = said[0].match(/^Transcript exported to (.+) \(4 messages\)\.$/);
  assert.ok(m, `expected an export confirmation, got: ${said[0]}`);
  const exported = m[1];
  assert.ok(fs.existsSync(exported), "the file must exist");
  const md = fs.readFileSync(exported, "utf8");
  assert.match(md, /# Kritya session: fix-the-login-bug/);
  assert.match(md, /## User/);
});

test("/export with a path writes there", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "kritya-export-"));
  const { ctx, said } = makeCtx("my-notes", workspace, HISTORY);

  await runCommand("/export", ctx);

  assert.match(said[0], /my-notes\.md/);
  assert.ok(fs.existsSync(path.join(workspace, "my-notes.md")));
});

test("/export refuses a path outside the workspace", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "kritya-export-"));
  const { ctx, said } = makeCtx("../../evil.md", workspace, HISTORY);

  await runCommand("/export", ctx);

  assert.match(said[0], /Can't export there/);
});

test("/export says so when the conversation is empty", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "kritya-export-"));
  const { ctx, said } = makeCtx("", workspace, [{ role: "system", content: "hi" }]);

  await runCommand("/export", ctx);

  assert.deepEqual(said, ["Nothing to export — the conversation is empty."]);
});
