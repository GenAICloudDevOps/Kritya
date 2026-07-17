#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { render } from "ink";
import { Agent } from "./agent/loop.js";
import { CONFIG_DIR, loadConfig, loadDotEnv, resolveProvider } from "./config/config.js";
import { DEFAULT_MODEL, contextWindowFor } from "./config/models.js";
import { PermissionManager } from "./permissions/permissions.js";
import { loadRules } from "./permissions/rules.js";
import { ProviderClient } from "./provider/client.js";
import { SessionStore } from "./session/store.js";
import { backgroundManager } from "./shell/background.js";
import { ALL_TOOLS, READONLY_TOOLS } from "./tools/index.js";
import { UndoStack } from "./undo/undo.js";
import { App, type UiBridge } from "./ui/App.js";
import { TrustPrompt } from "./ui/TrustPrompt.js";
import type { TaskItem, ToolDef } from "./types.js";
import { loadHooks, HookRunner } from "./hooks/hooks.js";
import { loadMcpTools, shutdownMcp } from "./mcp/client.js";
import { loadCustomCommands } from "./commands/custom.js";
import { gatedContentHash, isTrusted, saveTrust } from "./trust/trust.js";

const VERSION = "0.3.0";

const USAGE = `kritya — a lean, provider-agnostic terminal coding agent

Usage: kritya [directory] [options]

Options:
  -c, --continue      resume the most recent session for this directory
  -r, --resume        pick a past session for this directory from a list
  -m, --model <id>    model ID to use (any model your provider offers)
  -p, --provider <n>  provider: nvidia (default), openai, openrouter, groq,
                      deepseek, mistral, together, ollama, or a custom one
  -h, --help          show this help
  -v, --version       show version

Setup:
  1. Get an API key at https://build.nvidia.com (free credits available)
  2. export NVIDIA_API_KEY=nvapi-...        (Linux/macOS)
     setx NVIDIA_API_KEY nvapi-...          (Windows)
  3. cd your-project && kritya .

Config file: ~/.kritya/config.json  { "apiKey", "model", "customModels": [{"id"}] }`;

function parseArgs(argv: string[]) {
  const args = {
    dir: ".",
    continue: false,
    resume: false,
    model: "",
    provider: "",
    help: false,
    version: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-c" || a === "--continue") args.continue = true;
    else if (a === "-r" || a === "--resume") args.resume = true;
    else if (a === "-m" || a === "--model") args.model = argv[++i] ?? "";
    else if (a === "-p" || a === "--provider") args.provider = argv[++i] ?? "";
    else if (a === "-h" || a === "--help") args.help = true;
    else if (a === "-v" || a === "--version") args.version = true;
    else if (!a.startsWith("-")) args.dir = a;
    else {
      console.error(`Unknown option: ${a}\n\n${USAGE}`);
      process.exit(1);
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));

if (args.help) {
  console.log(USAGE);
  process.exit(0);
}
if (args.version) {
  console.log(VERSION);
  process.exit(0);
}

const workspace = path.resolve(args.dir);
if (!fs.existsSync(workspace) || !fs.statSync(workspace).isDirectory()) {
  console.error(`Not a directory: ${workspace}`);
  process.exit(1);
}

loadDotEnv([
  path.join(workspace, ".env"),
  path.join(process.cwd(), ".env"),
  path.join(CONFIG_DIR, ".env"),
]);

const config = loadConfig();
const provider = resolveProvider(config, args.provider || undefined);
const apiKey = provider.apiKey;
if (!apiKey) {
  const hint =
    provider.name === "nvidia"
      ? `Get one at https://build.nvidia.com, then one of:\n` +
        `  put NVIDIA_API_KEY=nvapi-... in a .env file (workspace or ~/.kritya/.env)\n` +
        `  export NVIDIA_API_KEY=nvapi-...\n` +
        `  add "apiKey" to ~/.kritya/config.json`
      : `Set the API key for provider "${provider.name}" via its env var or a .env file,\n` +
        `  or add it under providers.${provider.name}.apiKey in ~/.kritya/config.json`;
  console.error(`No API key found for provider "${provider.name}".\n\n${hint}`);
  process.exit(1);
}

if (!process.stdin.isTTY) {
  console.error("kritya is interactive and requires a TTY.");
  process.exit(1);
}

const providerDefaultModel = config.providers?.[provider.name]?.model;
const modelRef = {
  current: args.model || config.model || providerDefaultModel || DEFAULT_MODEL,
};
const client = new ProviderClient(apiKey, provider.baseUrl, {
  temperature: provider.temperature,
  topP: provider.topP,
  maxTokens: provider.maxTokens,
});
const session = new SessionStore(workspace);

const initialHistory = args.continue ? (SessionStore.loadLatest(workspace) ?? []) : [];
session.start(initialHistory);

const resumeSessions = args.resume ? SessionStore.listSessions(workspace) : [];

process.on("exit", () => {
  backgroundManager.killAll();
  shutdownMcp();
});

const undoStack = new UndoStack();
const uiBridge: UiBridge = { onTasksUpdate: (_tasks: TaskItem[]) => {} };

/**
 * Whether the workspace's .kritya/settings.json `allow` rules and `hooks`
 * may take effect. Prompts (via a standalone Ink screen) only when that file
 * actually has gated content and it hasn't already been trusted.
 */
async function resolveWorkspaceTrust(): Promise<boolean> {
  const hash = gatedContentHash(workspace);
  if (!hash) return true;
  if (isTrusted(workspace, hash)) return true;

  let preview: string;
  try {
    preview = fs.readFileSync(path.join(workspace, ".kritya", "settings.json"), "utf8");
  } catch {
    preview = "(could not re-read settings.json)";
  }

  return new Promise((resolve) => {
    const instance = render(
      <TrustPrompt
        workspace={workspace}
        preview={preview}
        onDecision={(trust) => {
          if (trust) saveTrust(workspace, hash);
          instance.unmount();
          resolve(trust);
        }}
      />
    );
  });
}

async function main() {
  const trustWorkspace = await resolveWorkspaceTrust();
  // MCP servers (if any) contribute extra tools; loading is resilient.
  const mcpTools: ToolDef[] = await loadMcpTools(config.mcpServers);
  const tools: ToolDef[] = [...ALL_TOOLS, ...mcpTools];

  // A read-only subagent for wide searches; shares the model and workspace but
  // has its own fresh context and cannot mutate anything.
  const spawnSubagent = async (task: string, signal?: AbortSignal): Promise<string> => {
    const sub = new Agent(
      client,
      () => modelRef.current,
      [...READONLY_TOOLS, ...mcpTools.filter((t) => !t.requiresPermission)],
      { workspace },
      new PermissionManager(),
      new SessionStore(workspace, true),
      []
    );
    sub.maxSteps = 15;
    let finalText = "";
    await sub.runTurn(
      task,
      {
        onTextDelta: () => {},
        onReasoningDelta: () => {},
        onAssistantText: (t) => {
          finalText = t;
        },
        onToolStart: () => {},
        onToolEnd: () => {},
        requestPermission: async () => "no",
        onUsage: () => {},
      },
      signal
    );
    return finalText.trim() || "(subagent returned no findings)";
  };

  const agent = new Agent(
    client,
    () => modelRef.current,
    tools,
    {
      workspace,
      undo: undoStack,
      onTasksUpdate: (t) => uiBridge.onTasksUpdate(t),
      spawnSubagent,
    },
    new PermissionManager(loadRules(workspace, trustWorkspace)),
    session,
    initialHistory
  );
  agent.contextWindow = contextWindowFor(modelRef.current, config);
  if (config.maxSteps && config.maxSteps > 0) agent.maxSteps = config.maxSteps;
  agent.hooks = new HookRunner(loadHooks(workspace, trustWorkspace), workspace);

  render(
    <App
      agent={agent}
      workspace={workspace}
      modelRef={modelRef}
      config={config}
      resumedCount={initialHistory.length}
      undoStack={undoStack}
      uiBridge={uiBridge}
      resumeSessions={resumeSessions.length ? resumeSessions : undefined}
      customCommands={loadCustomCommands(workspace)}
      mcpToolCount={mcpTools.length}
    />
  );
}

void main();
