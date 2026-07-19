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
import { describeGatedContent, gatedContentHash, isTrusted, saveTrust } from "./trust/trust.js";
import {
  createWorktree,
  commitWorktree,
  worktreeDiffStat,
  removeWorktree,
  isGitRepo,
} from "./agent/worktree.js";
import type { AgentHandlers, SubagentResult, SubagentSpec } from "./types.js";
import { VERSION } from "./version.js";

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

// Only the user's own global .env (~/.kritya/.env) is unconditionally trusted.
// The workspace's .env can be authored by whoever's repo this is, so loading
// it is gated behind the workspace trust prompt below (see resolveWorkspaceTrust).
loadDotEnv([path.join(CONFIG_DIR, ".env")]);

if (!process.stdin.isTTY) {
  console.error("kritya is interactive and requires a TTY.");
  process.exit(1);
}

/**
 * Whether the workspace's .kritya/settings.json `allow` rules, `hooks`,
 * `.env` file, and `.kritya/commands/*.md` may take effect. Prompts (via a
 * standalone Ink screen) only when that content actually exists and hasn't
 * already been trusted.
 */
async function resolveWorkspaceTrust(): Promise<boolean> {
  const hash = gatedContentHash(workspace);
  if (!hash) return true;
  if (isTrusted(workspace, hash)) return true;

  const preview = describeGatedContent(workspace);

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
  if (trustWorkspace) {
    // Only the workspace's own .env — it's part of the trust-gated content.
    // The launch directory's .env is deliberately NOT loaded: it can belong to
    // an unrelated (possibly cloned) repo and is invisible to the trust hash.
    loadDotEnv([path.join(workspace, ".env")]);
  }

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

  const cleanup = () => {
    backgroundManager.killAll();
    shutdownMcp();
  };
  process.on("exit", cleanup);
  // Default signal handling terminates WITHOUT firing "exit", which would
  // orphan background dev servers and MCP children (e.g. when the terminal
  // window closes → SIGHUP). Clean up, then exit with the conventional code.
  for (const [sig, code] of [
    ["SIGTERM", 143],
    ["SIGHUP", 129],
  ] as const) {
    process.on(sig, () => {
      cleanup();
      process.exit(code);
    });
  }

  // Best-effort retention: session transcripts can contain secrets that passed
  // through tool output; don't let them accumulate forever.
  SessionStore.cleanupOldSessions();

  const undoStack = new UndoStack();
  const uiBridge: UiBridge = { onTasksUpdate: (_tasks: TaskItem[]) => {} };

  // MCP servers (if any) contribute extra tools; loading is resilient.
  const mcpTools: ToolDef[] = await loadMcpTools(config.mcpServers);
  const tools: ToolDef[] = [...ALL_TOOLS, ...mcpTools];

  // Subagents never get spawn_agent/spawn_write_agent themselves — otherwise a
  // subagent could spawn more subagents unboundedly (fork-bomb-style resource
  // exhaustion) with no human in the loop to notice.
  const nonRecursive = (list: ToolDef[]) =>
    list.filter((t) => t.name !== "spawn_agent" && t.name !== "spawn_write_agent");
  const readOnlySubTools = [...READONLY_TOOLS, ...mcpTools.filter((t) => !t.requiresPermission)];
  const writeSubTools = [
    ...nonRecursive(ALL_TOOLS),
    ...mcpTools.filter((t) => !t.requiresPermission),
  ];

  // Hard caps so a runaway or hung subagent can't stall the session or burn
  // unbounded API/compute: a wall-clock timeout per subagent, and a bound on
  // how many run at once.
  const SUBAGENT_TIMEOUT_MS = 10 * 60 * 1000;
  const SUBAGENT_CONCURRENCY = 3;

  function silentHandlers(
    onFinalText: (t: string) => void,
    requestPermission: AgentHandlers["requestPermission"]
  ): AgentHandlers {
    return {
      onTextDelta: () => {},
      onReasoningDelta: () => {},
      onAssistantText: onFinalText,
      onToolStart: () => {},
      onToolEnd: () => {},
      requestPermission,
      onUsage: () => {},
    };
  }

  async function runReadOnlyAgent(task: string, signal: AbortSignal): Promise<SubagentResult> {
    const sub = new Agent(
      client,
      () => modelRef.current,
      readOnlySubTools,
      { workspace },
      new PermissionManager(),
      new SessionStore(workspace, true),
      []
    );
    sub.maxSteps = 15;
    let finalText = "";
    await sub.runTurn(
      task,
      // read-only tools never require permission, so this is never invoked
      silentHandlers(
        (t) => (finalText = t),
        async () => "no"
      ),
      signal
    );
    return { task, write: false, summary: finalText.trim() || "(subagent returned no findings)" };
  }

  async function runWriteAgent(task: string, signal: AbortSignal): Promise<SubagentResult> {
    if (!isGitRepo(workspace)) {
      return {
        task,
        write: true,
        summary: "",
        error:
          "the workspace is not a git repository, so an isolated worktree could not be created",
      };
    }
    const wt = createWorktree(workspace);
    if (!wt) {
      return { task, write: true, summary: "", error: "failed to create an isolated git worktree" };
    }

    let finalText = "";
    try {
      // Auto-allow ordinary writes/edits/shell (no human is watching this run),
      // but a destructive command still forces `warning` via classifyDanger in
      // the agent loop regardless of the allowlist — fail-safe deny it there,
      // since there's no one to confirm it and letting it run unattended would
      // be unsafe even inside an isolated worktree (it still has real shell/
      // network access).
      const sub = new Agent(
        client,
        () => modelRef.current,
        writeSubTools,
        { workspace: wt.dir },
        new PermissionManager({ allow: ["write_file", "edit_file", "shell(*)"], deny: [] }),
        new SessionStore(wt.dir, true),
        []
      );
      sub.maxSteps = 30;
      await sub.runTurn(
        task,
        silentHandlers(
          (t) => (finalText = t),
          async (_name, _summary, _diff, warning) => (warning ? "no" : "yes")
        ),
        signal
      );
    } catch (err) {
      if (!finalText)
        finalText = `(subagent stopped: ${err instanceof Error ? err.message : String(err)})`;
    }

    const commitState = commitWorktree(wt, `kritya subagent: ${task.slice(0, 72)}`);
    if (commitState === "clean") {
      const cleaned = removeWorktree(workspace, wt, true);
      const summary = finalText.trim() || "(no changes made)";
      // Surface this rather than silently leave an empty orphaned branch: a
      // failed `git branch -D` (e.g. a transient ref lock) shouldn't look
      // identical to a subagent that genuinely made no changes.
      return cleaned
        ? { task, write: true, summary }
        : {
            task,
            write: true,
            summary,
            error:
              `made no changes, but its empty scratch branch "${wt.branch}" could not be ` +
              `auto-deleted (a transient git lock) — safe to remove manually with ` +
              `\`git branch -D ${wt.branch}\``,
          };
    }
    if (commitState === "failed") {
      // Don't discard the worktree: the subagent's edits are real work, even
      // if a commit hook rejected them. Leave it on disk for manual recovery.
      return {
        task,
        write: true,
        summary: finalText.trim(),
        error: `changes could not be committed (a commit hook may have rejected them) — left uncommitted at ${wt.dir}`,
      };
    }
    const diffstat = worktreeDiffStat(workspace, wt);
    removeWorktree(workspace, wt, false);
    return {
      task,
      write: true,
      branch: wt.branch,
      summary: `${finalText.trim() || "(no summary)"}${diffstat ? `\n\n${diffstat}` : ""}`,
    };
  }

  async function runOneAgent(
    spec: SubagentSpec,
    parentSignal?: AbortSignal
  ): Promise<SubagentResult> {
    const controller = new AbortController();
    const onParentAbort = () => controller.abort();
    parentSignal?.addEventListener("abort", onParentAbort);
    const timer = setTimeout(() => controller.abort(), SUBAGENT_TIMEOUT_MS);
    try {
      return spec.write
        ? await runWriteAgent(spec.task, controller.signal)
        : await runReadOnlyAgent(spec.task, controller.signal);
    } catch (err) {
      return {
        task: spec.task,
        write: Boolean(spec.write),
        summary: "",
        error: err instanceof Error ? err.message : String(err),
      };
    } finally {
      clearTimeout(timer);
      parentSignal?.removeEventListener("abort", onParentAbort);
    }
  }

  // Runs subagents concurrently, capped at SUBAGENT_CONCURRENCY at a time, so
  // a burst of parallel tasks can't exhaust API rate limits or system resources.
  const spawnAgents = async (
    specs: SubagentSpec[],
    signal?: AbortSignal
  ): Promise<SubagentResult[]> => {
    const results: SubagentResult[] = new Array(specs.length);
    let next = 0;
    const workers = Array.from(
      { length: Math.min(SUBAGENT_CONCURRENCY, specs.length) },
      async () => {
        while (next < specs.length) {
          const i = next++;
          results[i] = await runOneAgent(specs[i], signal);
        }
      }
    );
    await Promise.all(workers);
    return results;
  };

  const agent = new Agent(
    client,
    () => modelRef.current,
    tools,
    {
      workspace,
      undo: undoStack,
      onTasksUpdate: (t) => uiBridge.onTasksUpdate(t),
      spawnAgents,
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
      customCommands={loadCustomCommands(workspace, trustWorkspace)}
      mcpToolCount={mcpTools.length}
    />
  );
}

void main();
