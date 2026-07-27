import "./useAgentTestHome.js";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { render } from "ink-testing-library";
import { KillSwitch } from "../agent/killSwitch.js";
import { RetryExhaustedError } from "../provider/client.js";
import type { Agent } from "../agent/loop.js";
import type { CliConfig } from "../config/config.js";
import type { PermissionDecision, UiBridge } from "../types.js";
import { useAgent, type UseAgentParams } from "../ui/useAgent.js";

async function tick(): Promise<void> {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
}

type FakeRunTurn = Agent["runTurn"];

function fakeAgent(overrides: Partial<Record<string, unknown>> = {}): Agent {
  return {
    kill: new KillSwitch(),
    contextWindow: 120_000,
    planMode: false,
    dryRunMode: false,
    acceptEdits: false,
    onAutoApprove: undefined,
    audit: undefined,
    turnSpan: undefined,
    setClient: () => {},
    addUserNote: () => {},
    loadHistory: () => {},
    contextUsage: () => 0,
    queueSteer: () => {},
    runTurn: async () => {},
    ...overrides,
  } as unknown as Agent;
}

function fakeUiBridge(): UiBridge {
  return { onTasksUpdate: () => {} };
}

async function setup(overrides: Partial<UseAgentParams> = {}) {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "kritya-useagent-"));
  const params: UseAgentParams = {
    agent: fakeAgent(),
    workspace,
    modelRef: { current: "nvidia/test-model" },
    providerRef: { current: "nvidia" },
    config: {} as CliConfig,
    uiBridge: fakeUiBridge(),
    resumedCount: 0,
    refreshFileList: () => {},
    onSwitchClient: () => {},
    ...overrides,
  };

  let current!: ReturnType<typeof useAgent>;
  function Harness({ onReady }: { onReady: (a: ReturnType<typeof useAgent>) => void }) {
    const value = useAgent(params);
    onReady(value);
    return null;
  }
  render(<Harness onReady={(a) => (current = a)} />);
  await tick();

  // `current` is reassigned on every re-render, but destructuring `{ api }` out of
  // this function's return value would freeze whatever it pointed to at that
  // instant. A Proxy forwards every access to whatever `current` is *right now*,
  // so `const { api } = await setup(...)` stays live across state updates.
  const api = new Proxy({} as ReturnType<typeof useAgent>, {
    get(_target, prop: keyof ReturnType<typeof useAgent>) {
      const value = current[prop];
      return typeof value === "function" ? value.bind(current) : value;
    },
  });
  return { api, workspace, params };
}

function lastItemText(items: { kind: string }[]): string {
  const last = items[items.length - 1] as { kind: string; text?: string };
  return last.text ?? "";
}

test("the initial transcript is just the banner when nothing was resumed", async () => {
  const { api } = await setup();
  assert.equal(api.items.length, 1);
  assert.equal(api.items[0].kind, "banner");
});

test("resuming a session adds a note with the checklist restore stats", async () => {
  const { api } = await setup({
    resumedCount: 3,
    initialTasks: [
      { text: "a", status: "done" },
      { text: "b", status: "pending" },
    ],
  });
  assert.equal(api.items.length, 2);
  assert.match(lastItemText(api.items), /Resumed previous session \(3 messages\)/);
  assert.match(lastItemText(api.items), /checklist restored \(1\/2 done\)/);
});

test("cycleMode goes normal -> confirm -> accept-edits -> dry-run -> normal", async () => {
  const agent = fakeAgent();
  const { api } = await setup({ agent });

  // First Shift+Tab always pauses on confirmation before ever entering accept-edits.
  api.cycleMode();
  await tick();
  assert.equal(api.phase, "confirmMode");
  assert.equal(agent.acceptEdits, false);

  api.onAcceptEditsConfirm(true);
  await tick();
  assert.equal(api.phase, "input");
  assert.equal(agent.acceptEdits, true);
  assert.match(lastItemText(api.items), /Accept-edits mode ON/);

  api.cycleMode();
  await tick();
  assert.equal(agent.acceptEdits, false);
  assert.equal(agent.dryRunMode, true);
  assert.equal(agent.planMode, false, "the manual toggle never touches the workflow's plan mode");
  assert.match(lastItemText(api.items), /Dry-run mode ON/);

  api.cycleMode();
  await tick();
  assert.equal(agent.dryRunMode, false);
  assert.match(lastItemText(api.items), /Dry-run mode OFF/);
});

test("declining the first accept-edits confirmation leaves everything off", async () => {
  const agent = fakeAgent();
  const { api } = await setup({ agent });
  api.cycleMode();
  await tick();
  api.onAcceptEditsConfirm(false);
  await tick();
  assert.equal(api.phase, "input");
  assert.equal(agent.acceptEdits, false);
});

test("once accept-edits has been confirmed once, cycling back to it skips the prompt", async () => {
  const agent = fakeAgent();
  const { api } = await setup({ agent });
  api.cycleMode(); // -> confirm
  await tick();
  api.onAcceptEditsConfirm(true); // -> accept-edits
  await tick();
  api.cycleMode(); // -> dry-run
  await tick();
  api.cycleMode(); // -> normal
  await tick();
  api.cycleMode(); // -> straight to accept-edits, no confirm this time
  await tick();
  assert.equal(api.phase, "input");
  assert.equal(agent.acceptEdits, true);
});

test("engaging the kill switch aborts the turn, resolves any open permission prompt with 'no', and clears transient state", async () => {
  const agent = fakeAgent();
  const { api } = await setup({ agent });

  let resolved: PermissionDecision | undefined;
  // Simulate a pending permission prompt by writing into internal state via runAgent's requestPermission path.
  const runTurn: FakeRunTurn = (async (_text, handlers) => {
    await handlers.requestPermission("run_shell", "rm -rf ./x").then((d: PermissionDecision) => {
      resolved = d;
    });
  }) as FakeRunTurn;
  agent.runTurn = runTurn;

  const turnPromise = api.runAgent("do something");
  await tick();
  assert.equal(api.phase, "permission");

  api.engageKill("test reason");
  await tick();
  await turnPromise;

  assert.equal(resolved, "no");
  assert.equal(api.killed, true);
  assert.equal(api.killReason, "test reason");
  assert.equal(api.permission, null);
  assert.match(lastItemText(api.items), /KILL SWITCH ENGAGED — test reason/);
});

test("engaging an already-engaged kill switch is a no-op", async () => {
  const agent = fakeAgent();
  const { api } = await setup({ agent });
  api.engageKill("first");
  await tick();
  const before = api.items.length;
  api.engageKill("second");
  await tick();
  assert.equal(
    api.items.length,
    before,
    "no new item — engage() returned false and short-circuited"
  );
  assert.equal(api.killReason, "first");
});

test("releasing when not engaged reports there's nothing to release", async () => {
  const { api } = await setup();
  api.releaseKill();
  await tick();
  assert.match(lastItemText(api.items), /isn't engaged/);
  assert.equal(api.killed, false);
});

test("releasing an engaged kill switch clears the killed flag", async () => {
  const agent = fakeAgent();
  const { api } = await setup({ agent });
  api.engageKill("stop");
  await tick();
  api.releaseKill();
  await tick();
  assert.equal(api.killed, false);
  assert.equal(api.killReason, undefined);
  assert.match(lastItemText(api.items), /Kill switch released/);
});

test("runAgent refuses to start a new turn while the kill switch is active", async () => {
  const agent = fakeAgent();
  agent.kill.engage("already stopped");
  let called = false;
  agent.runTurn = (async () => {
    called = true;
  }) as FakeRunTurn;
  const { api } = await setup({ agent });

  await api.runAgent("hello");
  await tick();
  assert.equal(called, false);
  assert.match(lastItemText(api.items), /Kill switch ACTIVE — already stopped/);
});

test("runAgent refuses to start once the token budget is exhausted", async () => {
  const agent = fakeAgent();
  let called = false;
  agent.runTurn = (async () => {
    called = true;
  }) as FakeRunTurn;
  const { api } = await setup({ agent });
  api.setBudgetLimit(10);
  await tick();
  // Drive usage past the budget via a real turn so budgetStopped flips on internally.
  agent.runTurn = (async (_text, handlers) => {
    handlers.onUsage({ promptTokens: 20, completionTokens: 0, cachedPromptTokens: 0 });
  }) as FakeRunTurn;
  await api.runAgent("first");
  await tick();
  assert.equal(api.budgetStopped, true);

  agent.runTurn = (async () => {
    called = true;
  }) as FakeRunTurn;
  await api.runAgent("second");
  await tick();
  assert.equal(called, false, "the second turn never started");
  assert.match(lastItemText(api.items), /Token budget reached/);
});

test("a full turn streams text, records usage, and settles back to the input phase", async () => {
  const agent = fakeAgent();
  agent.runTurn = (async (_text, handlers) => {
    handlers.onTextDelta("Hel");
    handlers.onTextDelta("lo");
    handlers.onAssistantText("Hello");
    handlers.onUsage({ promptTokens: 100, completionTokens: 50, cachedPromptTokens: 0 });
  }) as FakeRunTurn;
  let refreshed = false;
  const { api } = await setup({ agent, refreshFileList: () => (refreshed = true) });

  await api.runAgent("hi");
  await tick();

  assert.equal(api.phase, "input");
  assert.equal(api.stream, "");
  const last = api.items[api.items.length - 1] as { kind: string; text?: string };
  assert.equal(last.kind, "assistant");
  assert.equal(last.text, "Hello");
  assert.equal(api.totalUsage.promptTokens, 100);
  assert.equal(api.totalUsage.completionTokens, 50);
  assert.equal(refreshed, true);
});

test("a tool call in flight is tracked and cleared when it ends", async () => {
  const agent = fakeAgent();
  agent.runTurn = (async (_text, handlers) => {
    handlers.onToolStart("1", "write_file", "writing foo.txt");
    handlers.onToolEnd("1", "write_file", "writing foo.txt", "ok", false, "wrote foo.txt");
  }) as FakeRunTurn;
  const { api } = await setup({ agent });
  await api.runAgent("write something");
  await tick();
  assert.equal(api.inFlight.length, 0);
  const toolItem = api.items[api.items.length - 1] as {
    kind: string;
    name?: string;
    resultSummary?: string;
  };
  assert.equal(toolItem.kind, "tool");
  assert.equal(toolItem.name, "write_file");
  assert.equal(toolItem.resultSummary, "wrote foo.txt");
});

test("update_tasks tool calls don't clutter the transcript", async () => {
  const agent = fakeAgent();
  agent.runTurn = (async (_text, handlers) => {
    handlers.onToolStart("1", "update_tasks", "updating tasks");
    handlers.onToolEnd("1", "update_tasks", "updating tasks", "", false);
  }) as FakeRunTurn;
  const { api } = await setup({ agent });
  const before = api.items.length;
  await api.runAgent("update tasks");
  await tick();
  assert.equal(api.items.length, before, "no item was added for update_tasks");
});

test("a plain error surfaces as 'Error: <message>'", async () => {
  const agent = fakeAgent();
  agent.runTurn = (async () => {
    throw new Error("boom");
  }) as FakeRunTurn;
  const { api } = await setup({ agent });
  await api.runAgent("hi");
  await tick();
  assert.match(lastItemText(api.items), /^Error: boom$/);
});

test("an abort error is reported as 'Interrupted.'", async () => {
  const agent = fakeAgent();
  agent.runTurn = (async () => {
    const err = new Error("The operation was aborted");
    err.name = "AbortError";
    throw err;
  }) as FakeRunTurn;
  const { api } = await setup({ agent });
  await api.runAgent("hi");
  await tick();
  assert.match(lastItemText(api.items), /^Interrupted\.$/);
});

test("RetryExhaustedError suggests another configured provider as a fallback", async () => {
  const agent = fakeAgent();
  agent.runTurn = (async () => {
    throw new RetryExhaustedError(new Error("network down"), 5);
  }) as FakeRunTurn;
  const config: CliConfig = {
    providers: {
      nvidia: { baseUrl: "https://x", apiKey: "k1" },
      ollama: { baseUrl: "https://y", apiKey: "k2" },
    },
  };
  const { api } = await setup({ agent, config, providerRef: { current: "nvidia" } });
  await api.runAgent("hi");
  await tick();
  assert.match(lastItemText(api.items), /isn't responding — try \/provider ollama/);
});

test("RetryExhaustedError with no fallback provider says so plainly", async () => {
  // ollama's builtin entry always "has a key" (it's a hardcoded placeholder for
  // a local, no-auth server), so it must be the *active* provider here — the
  // active one is excluded from its own fallback list — and every other
  // builtin's env var must be unset so none of them looks configured either.
  const apiKeyEnvVars = [
    "NVIDIA_API_KEY",
    "OPENAI_API_KEY",
    "OPENROUTER_API_KEY",
    "GROQ_API_KEY",
    "DEEPSEEK_API_KEY",
    "MISTRAL_API_KEY",
    "TOGETHER_API_KEY",
    "ANTHROPIC_API_KEY",
    "GEMINI_API_KEY",
  ];
  const saved = Object.fromEntries(apiKeyEnvVars.map((k) => [k, process.env[k]]));
  for (const k of apiKeyEnvVars) delete process.env[k];
  try {
    const agent = fakeAgent();
    agent.runTurn = (async () => {
      throw new RetryExhaustedError(new Error("network down"), 5);
    }) as FakeRunTurn;
    const { api } = await setup({
      agent,
      config: {} as CliConfig,
      providerRef: { current: "ollama" },
    });
    await api.runAgent("hi");
    await tick();
    assert.match(lastItemText(api.items), /no other provider has an API key configured/);
  } finally {
    for (const k of apiKeyEnvVars) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
});

test("setModelEverywhere updates the model ref, the agent's context window, and adds a note", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "kritya-useagent-home-"));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  const { useAgent: freshUseAgent } = (await import(
    `../ui/useAgent.js?t=${Date.now()}`
  )) as typeof import("../ui/useAgent.js");

  const agent = fakeAgent();
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "kritya-useagent-"));
  const modelRef = { current: "old/model" };
  let api!: ReturnType<typeof freshUseAgent>;
  function Harness({ onReady }: { onReady: (a: ReturnType<typeof freshUseAgent>) => void }) {
    const value = freshUseAgent({
      agent,
      workspace,
      modelRef,
      providerRef: { current: "nvidia" },
      config: {} as CliConfig,
      uiBridge: fakeUiBridge(),
      resumedCount: 0,
      refreshFileList: () => {},
      onSwitchClient: () => {},
    });
    onReady(value);
    return null;
  }
  render(<Harness onReady={(a) => (api = a)} />);
  await tick();

  api.setModelEverywhere("new/model");
  await tick();

  assert.equal(modelRef.current, "new/model");
  assert.equal(api.model, "new/model");
  assert.match(lastItemText(api.items), /Model set to new\/model/);
});

test("setProviderEverywhere reports a missing API key without touching the agent", async () => {
  const agent = fakeAgent();
  let switched: unknown;
  const { api } = await setup({
    agent,
    config: {} as CliConfig,
    onSwitchClient: (c) => (switched = c),
  });
  api.setProviderEverywhere("ghost-provider");
  await tick();
  assert.equal(switched, undefined);
  assert.match(lastItemText(api.items), /No API key found for provider "ghost-provider"/);
});

test("setProviderEverywhere switches the client and carries the model over when the new provider has no default", async () => {
  const agent = fakeAgent();
  let switchedTo: unknown;
  const config: CliConfig = {
    providers: { ollama: { baseUrl: "http://localhost:11434/v1", apiKey: "local-key" } },
  };
  const { api } = await setup({
    agent,
    config,
    providerRef: { current: "nvidia" },
    onSwitchClient: (c) => (switchedTo = c),
  });
  api.setProviderEverywhere("ollama");
  await tick();
  assert.notEqual(switchedTo, undefined);
  assert.equal(api.provider, "ollama");
  assert.match(lastItemText(api.items), /Switched provider to ollama — conversation history kept/);
});

test("setProviderEverywhere adopts the new provider's default model when it has one", async () => {
  const agent = fakeAgent();
  const config: CliConfig = {
    providers: {
      ollama: { baseUrl: "http://localhost:11434/v1", apiKey: "local-key", model: "llama3" },
    },
  };
  const { api } = await setup({ agent, config, providerRef: { current: "nvidia" } });
  api.setProviderEverywhere("ollama");
  await tick();
  assert.equal(api.model, "llama3");
  assert.match(lastItemText(api.items), /Switched provider to ollama \(model: llama3\)/);
});

test("resuming a session replays recent messages and restores its task checklist", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "kritya-useagent-session-"));
  const sessionFile = path.join(dir, "2026-01-01T00-00-00-000Z.jsonl");
  const messages = [
    { role: "user", content: "first question" },
    { role: "assistant", content: "first answer" },
  ];
  await fs.writeFile(sessionFile, messages.map((m) => JSON.stringify(m)).join("\n") + "\n");
  await fs.writeFile(
    sessionFile.replace(/\.jsonl$/, ".tasks.json"),
    JSON.stringify([{ text: "task a", status: "done" }])
  );

  const agent = fakeAgent();
  let loaded: unknown;
  agent.loadHistory = (m: unknown) => (loaded = m);
  const { api } = await setup({
    agent,
    resumeSessions: [
      {
        file: sessionFile,
        title: "old chat",
        preview: "first question",
        date: "2026-01-01",
        count: 2,
      },
    ],
  });

  api.onResumeSelect(sessionFile);
  await tick();

  assert.equal((loaded as unknown[]).length, 2);
  assert.equal(api.tasks.length, 1);
  assert.equal(api.tasks[0].text, "task a");
  assert.match(lastItemText(api.items), /Resumed session from 2026-01-01 \(2 messages\)/);
  assert.match(lastItemText(api.items), /checklist restored \(1\/1 done\)/);
});

test("choosing 'start fresh' (an empty file) on the resume picker just says so", async () => {
  const { api } = await setup();
  api.onResumeSelect("");
  await tick();
  assert.match(lastItemText(api.items), /Starting a fresh session/);
});

test("onPermissionDecision resolves the pending promise and returns to the working phase", async () => {
  const agent = fakeAgent();
  let resolved: PermissionDecision | undefined;
  agent.runTurn = (async (_text, handlers) => {
    resolved = await handlers.requestPermission("shell", "rm -rf /");
  }) as FakeRunTurn;
  const { api } = await setup({ agent });
  const turn = api.runAgent("hi");
  await tick();
  assert.equal(api.phase, "permission");
  api.onPermissionDecision("yes");
  await tick();
  await turn;
  assert.equal(resolved, "yes");
});
