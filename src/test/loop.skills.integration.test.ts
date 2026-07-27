import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Agent } from "../agent/loop.js";
import { skillsDir } from "../agent/skills.js";
import { loadSkillTool } from "../tools/skills.js";
import { readFileTool } from "../tools/read.js";
import type { ChatResult, ParsedToolCall, ProviderClient } from "../provider/client.js";
import { PermissionManager } from "../permissions/permissions.js";
import { SessionStore } from "../session/store.js";
import type {
  AgentHandlers,
  ChatMessage,
  PermissionDecision,
  ToolDef,
  ToolContext,
} from "../types.js";

// Same helpers as src/test/loop.integration.test.ts -- duplicated locally
// rather than imported across test files, matching this suite's existing
// convention of self-contained test files.
function scriptedClient(rounds: ChatResult[]): { client: ProviderClient; callCount: () => number } {
  let i = 0;
  const client = {
    chat: async (): Promise<ChatResult> => {
      if (i >= rounds.length)
        throw new Error(`unexpected chat() call #${i + 1} -- only ${rounds.length} scripted`);
      return rounds[i++];
    },
  } as unknown as ProviderClient;
  return { client, callCount: () => i };
}

function assistantToolCallMsg(calls: ParsedToolCall[]): ChatMessage {
  return {
    role: "assistant",
    content: null,
    tool_calls: calls.map((c) => ({
      id: c.id,
      type: "function" as const,
      function: { name: c.name, arguments: c.argsJson },
    })),
  };
}

function toolRound(calls: ParsedToolCall[]): ChatResult {
  return {
    message: assistantToolCallMsg(calls),
    text: "",
    toolCalls: calls,
    usage: { promptTokens: 100, completionTokens: 10 },
  };
}

function textRound(text: string): ChatResult {
  return {
    message: { role: "assistant", content: text },
    text,
    toolCalls: [],
    usage: { promptTokens: 100, completionTokens: 10 },
  };
}

interface HandlerLog {
  texts: string[];
  toolEnds: { name: string; isError: boolean }[];
  handlers: AgentHandlers;
}

function makeHandlers(): HandlerLog {
  const log: HandlerLog = {
    texts: [],
    toolEnds: [],
    handlers: {
      onTextDelta() {},
      onReasoningDelta() {},
      onAssistantText(text) {
        log.texts.push(text);
      },
      onToolStart() {},
      onToolEnd(_id, name, _summary, _preview, isError) {
        log.toolEnds.push({ name, isError });
      },
      async requestPermission(): Promise<PermissionDecision> {
        return "yes";
      },
      onUsage() {},
    },
  };
  return log;
}

function makeAgent(workspace: string, client: ProviderClient, tools: ToolDef[]): Agent {
  const ctx: ToolContext = { workspace };
  return new Agent(
    client,
    () => "test-model",
    tools,
    ctx,
    new PermissionManager(),
    new SessionStore(workspace, true) // ephemeral: true, no disk writes in tests
  );
}

function loadSkillCall(name: string, id = "call_1"): ParsedToolCall {
  return { id, name: "load_skill", argsJson: JSON.stringify({ name }) };
}

function tmpWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "kritya-skills-loop-"));
}

function writeSkill(
  ws: string,
  name: string,
  opts: { description?: string; body?: string } = {}
): string {
  const dir = path.join(skillsDir(ws), name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${opts.description ?? "a skill"}\n---\n\n${opts.body ?? "Do the thing."}\n`
  );
  return dir;
}

test("load_skill returns the skill body and the loop completes", async () => {
  const ws = tmpWorkspace();
  writeSkill(ws, "ratio-analysis", {
    body: "Compute current ratio = current assets / current liabilities.",
  });
  const { client } = scriptedClient([
    toolRound([loadSkillCall("ratio-analysis")]),
    textRound("Loaded the ratio-analysis skill and applied it."),
  ]);
  const agent = makeAgent(ws, client, [loadSkillTool, readFileTool]);
  const log = makeHandlers();
  await agent.runTurn("analyze the ratios", log.handlers);
  assert.equal(log.texts.at(-1), "Loaded the ratio-analysis skill and applied it.");
  assert.deepEqual(log.toolEnds, [{ name: "load_skill", isError: false }]);
  const toolMsg = agent.history[2] as { content: string };
  assert.match(toolMsg.content, /Compute current ratio = current assets \/ current liabilities\./);
});

test("load_skill with an unknown name surfaces an error the loop can continue from", async () => {
  const ws = tmpWorkspace();
  writeSkill(ws, "ratio-analysis");
  const { client } = scriptedClient([
    toolRound([loadSkillCall("does-not-exist")]),
    textRound("That skill doesn't exist, so I'll proceed without it."),
  ]);
  const agent = makeAgent(ws, client, [loadSkillTool, readFileTool]);
  const log = makeHandlers();
  await agent.runTurn("use the fictional skill", log.handlers);
  assert.equal(log.texts.at(-1), "That skill doesn't exist, so I'll proceed without it.");
  assert.deepEqual(log.toolEnds, [{ name: "load_skill", isError: true }]);
  // The model still sees a usable error message for the next round, not a
  // raw stack trace.
  const toolMsg = agent.history.find((m) => m.role === "tool") as { content: string } | undefined;
  assert.match(toolMsg!.content, /skill "does-not-exist" not found.*ratio-analysis/s);
});

test("load_skill surfaces bundled scripts/references, and a follow-up read_file succeeds", async () => {
  const ws = tmpWorkspace();
  const dir = writeSkill(ws, "ratio-analysis");
  fs.mkdirSync(path.join(dir, "references"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "references", "formulas.md"),
    "current_ratio = assets / liabilities"
  );
  fs.mkdirSync(path.join(dir, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(dir, "scripts", "compute.py"), "# compute");

  const { client } = scriptedClient([
    toolRound([loadSkillCall("ratio-analysis")]),
    toolRound([
      {
        id: "call_2",
        name: "read_file",
        argsJson: JSON.stringify({ path: ".kritya/skills/ratio-analysis/references/formulas.md" }),
      },
    ]),
    textRound("Used the formula from the referenced file."),
  ]);
  const agent = makeAgent(ws, client, [loadSkillTool, readFileTool]);
  const log = makeHandlers();
  await agent.runTurn("compute the ratio", log.handlers);
  assert.equal(log.texts.at(-1), "Used the formula from the referenced file.");
  assert.deepEqual(log.toolEnds, [
    { name: "load_skill", isError: false },
    { name: "read_file", isError: false },
  ]);
  const firstToolMsg = agent.history[2] as { content: string };
  assert.match(firstToolMsg.content, /scripts\/[\s\S]*compute\.py/);
  assert.match(firstToolMsg.content, /references\/[\s\S]*formulas\.md/);
});

test("looking up the second of two skills by name is not order-dependent", async () => {
  const ws = tmpWorkspace();
  writeSkill(ws, "aaa-first", { body: "first skill body" });
  writeSkill(ws, "zzz-second", { body: "second skill body" });
  const { client } = scriptedClient([
    toolRound([loadSkillCall("zzz-second")]),
    textRound("Loaded zzz-second."),
  ]);
  const agent = makeAgent(ws, client, [loadSkillTool, readFileTool]);
  const log = makeHandlers();
  await agent.runTurn("use zzz-second", log.handlers);
  assert.equal(log.texts.at(-1), "Loaded zzz-second.");
  const toolMsg = agent.history[2] as { content: string };
  assert.match(toolMsg.content, /second skill body/);
});

test("load_skill in a workspace with no skills directory throws a clean 'none available' error", async () => {
  const ws = tmpWorkspace(); // no .kritya/skills at all
  const { client } = scriptedClient([
    toolRound([loadSkillCall("anything")]),
    textRound("No skills are configured here."),
  ]);
  const agent = makeAgent(ws, client, [loadSkillTool, readFileTool]);
  const log = makeHandlers();
  await agent.runTurn("use a skill", log.handlers);
  assert.equal(log.texts.at(-1), "No skills are configured here.");
  const toolMsg = agent.history[2] as { content: string };
  assert.match(toolMsg.content, /not found.*\(none\)/s);
});
