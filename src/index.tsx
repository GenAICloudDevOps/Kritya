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
import { AuditLog } from "./audit/audit.js";
import { runAuditCli } from "./audit/cli.js";
import { runSkillsCli } from "./agent/skillsCli.js";
import { createTracer, cleanupOldTelemetry } from "./telemetry/tracer.js";
import { createMeter } from "./telemetry/metrics.js";
import { retentionDaysFor } from "./config/retention.js";
import { backgroundManager } from "./shell/background.js";
import { sandboxAvailable, sandboxUnavailableReason } from "./shell/sandbox.js";
import { lspManager } from "./lsp/manager.js";
import { ALL_TOOLS, READONLY_TOOLS } from "./tools/index.js";
import { UndoStack } from "./undo/undo.js";
import { App, type UiBridge } from "./ui/App.js";
import { TrustPrompt } from "./ui/TrustPrompt.js";
import { McpTrustPrompt } from "./ui/McpTrustPrompt.js";
import type { ElicitationField, ElicitationResult, TaskItem, ToolDef } from "./types.js";
import type { McpServerConfig } from "./config/config.js";
import { loadHooks, HookRunner } from "./hooks/hooks.js";
import {
  loadMcpTools,
  shutdownMcp,
  type SamplingRequest,
  type SamplingResult,
} from "./mcp/client.js";
import { loadProjectMcpServers, mergeMcpServers } from "./mcp/servers.js";
import { loadCustomCommands } from "./commands/custom.js";
import { pluginsDir, scanPlugins, userPluginsDir } from "./plugins/discover.js";
import { loadPluginMcpServers } from "./plugins/mcp.js";
import { describeGatedContent, gatedContentHash, isTrusted, saveTrust } from "./trust/trust.js";
import { partitionByTrust, serverFingerprint, trustServer } from "./trust/mcpTrust.js";
import { runHeadless } from "./headless.js";
import { installCrashHandlers } from "./crash.js";
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

Headless / CI mode (no terminal UI, exits with 0 on success / 1 on failure):
  --prompt <text>     run this one prompt to completion, then exit
  --output <fmt>      text (default) or json — a single JSON object on stdout
                      with {success, result, error, toolCalls, usage, durationMs}
  --allow-all         auto-approve tool calls that would otherwise prompt
                      (destructive commands are still always denied — there's
                      no terminal to confirm them)
  --trust             trust the workspace's own .kritya/settings.json allow
                      rules, hooks, .env, and custom commands (off by default,
                      since CI often checks out untrusted branches/PRs)
  --timeout <seconds> hard wall-clock cap for the whole run (default 1800)
  --non-interactive   accepted for compatibility; implied by --prompt

Inspect the local audit log:
  kritya audit --list | --verify [file] | --show [file]

List and validate skills:
  kritya skills [dir] [--json] [--validate]

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
    prompt: "",
    output: "text" as "text" | "json",
    allowAll: false,
    trust: false,
    timeoutSeconds: 1800,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-c" || a === "--continue") args.continue = true;
    else if (a === "-r" || a === "--resume") args.resume = true;
    else if (a === "-m" || a === "--model") args.model = argv[++i] ?? "";
    else if (a === "-p" || a === "--provider") args.provider = argv[++i] ?? "";
    else if (a === "-h" || a === "--help") args.help = true;
    else if (a === "-v" || a === "--version") args.version = true;
    else if (a === "--prompt") args.prompt = argv[++i] ?? "";
    else if (a === "--output") {
      const v = argv[++i] ?? "";
      if (v !== "text" && v !== "json") {
        console.error(`--output must be "text" or "json", got "${v}"`);
        process.exit(1);
      }
      args.output = v;
    } else if (a === "--allow-all") args.allowAll = true;
    else if (a === "--trust") args.trust = true;
    else if (a === "--timeout") args.timeoutSeconds = Number(argv[++i]) || args.timeoutSeconds;
    else if (a === "--non-interactive") {
      // implied by --prompt; accepted so scripts can pass it explicitly
    } else if (!a.startsWith("-")) args.dir = a;
    else {
      console.error(`Unknown option: ${a}\n\n${USAGE}`);
      process.exit(1);
    }
  }
  return args;
}

// `kritya audit ...` is a standalone inspection subcommand, not a session — it
// never touches a workspace directory, so it's dispatched before the normal
// directory-based argv parsing below even looks at it.
if (process.argv[2] === "audit") {
  process.exit(runAuditCli(process.argv.slice(3)));
}

// `kritya skills` is likewise a standalone inspection subcommand, dispatched
// the same way and for the same reason.
if (process.argv[2] === "skills") {
  process.exit(runSkillsCli(process.argv.slice(3)));
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

// Headless mode: run one prompt to completion with no terminal UI at all, and
// no TTY requirement — this is what makes `kritya --prompt "..."` usable from
// CI/scripts. Everything else in this file (the TTY check, the Ink app) is
// only for the interactive path, so it's skipped entirely here.
if (args.prompt) {
  runHeadless({
    dir: args.dir,
    prompt: args.prompt,
    provider: args.provider,
    model: args.model,
    continue: args.continue,
    output: args.output,
    allowAll: args.allowAll,
    trust: args.trust,
    timeoutSeconds: args.timeoutSeconds,
  }).then((code) => process.exit(code));
} else {
  runInteractive();
}

function runInteractive(): void {
  // Only the user's own global .env (~/.kritya/.env) is unconditionally
  // trusted. The workspace's .env can be authored by whoever's repo this is,
  // so loading it is gated behind the workspace trust prompt below (see
  // resolveWorkspaceTrust).
  loadDotEnv([path.join(CONFIG_DIR, ".env")]);

  if (!process.stdin.isTTY) {
    console.error("kritya is interactive and requires a TTY.");
    process.exit(1);
  }

  void main();
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

/**
 * Whether each server named in the workspace's .mcp.json may be loaded.
 * Workspace trust above only gates the file as a whole; this adds a second,
 * per-server gate so a later edit to .mcp.json (e.g. a new server added by a
 * `git pull` or a malicious PR branch) doesn't silently inherit trust from
 * servers the user already reviewed. Already-approved servers (by
 * fingerprint, across all workspaces) pass straight through.
 *
 * Pending servers are decided one at a time: a batch approval makes refusing
 * one server cost you the others, which is how people end up approving things
 * they wouldn't have alone.
 */
async function resolveMcpServerTrust(
  projectMcp: Record<string, McpServerConfig> | undefined
): Promise<Record<string, McpServerConfig> | undefined> {
  if (!projectMcp) return undefined;
  const { trusted, pending } = partitionByTrust(projectMcp);
  if (Object.keys(pending).length === 0) return trusted;

  return new Promise((resolve) => {
    const instance = render(
      <McpTrustPrompt
        servers={pending}
        onComplete={(approved) => {
          const loaded = { ...trusted };
          for (const name of approved) {
            trustServer(name, serverFingerprint(pending[name]));
            loaded[name] = pending[name];
          }
          instance.unmount();
          resolve(loaded);
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

  const sandboxMode = config.sandboxExec ?? "auto";
  if (sandboxMode !== "off" && !sandboxAvailable()) {
    console.error(
      `⚠ sandboxExec is "${sandboxMode}" but ${sandboxUnavailableReason()}. ` +
        `Shell commands will run WITHOUT sandbox isolation this session — each one will ` +
        `say so in its output.`
    );
  }

  const providerDefaultModel = config.providers?.[provider.name]?.model;
  const modelRef = {
    current: args.model || config.model || providerDefaultModel || DEFAULT_MODEL,
  };
  const providerRef = { current: provider.name };
  // Mutable so /provider can swap the active client mid-session (fallback
  // when a provider keeps timing out or rate-limiting — see
  // RetryExhaustedError) without losing the conversation. runReadOnlyAgent /
  // runWriteAgent below read this variable at call time, so subagents spawned
  // after a switch pick up the new provider too.
  let client = new ProviderClient(apiKey, provider.baseUrl, {
    temperature: provider.temperature,
    topP: provider.topP,
    maxTokens: provider.maxTokens,
  });
  const session = new SessionStore(workspace);
  // Shared by the main agent and every subagent it spawns, so a write
  // subagent's commits and a read-only subagent's tool calls land in the same
  // audit trail and trace tree as the turn that spawned them — an agent that
  // edits the repo should never do so off the record.
  const sessionAudit = AuditLog.forSession(session.id, config.audit);
  const sessionTracer = createTracer(session.id, config.otel);
  const sessionMeter = createMeter(session.id, config.otel);

  const initialHistory = args.continue ? (SessionStore.loadLatest(workspace) ?? []) : [];
  const initialTasks = args.continue ? SessionStore.loadLatestTasks(workspace) : [];
  session.start(initialHistory);

  const resumeSessions = args.resume ? SessionStore.listSessions(workspace) : [];

  // Filled in once the app is mounted, below; the crash handler needs a way to
  // tear the UI down and is installed before there is a UI to tear down.
  const ui: { instance?: ReturnType<typeof render> } = {};

  const cleanup = () => {
    backgroundManager.killAll();
    lspManager.disposeAll();
    shutdownMcp();
    undoStack.closeAll();
    sessionMeter.flush();
    sessionMeter.stop();
  };
  // Node ignores async work started inside an "exit" handler, so this last-
  // resort fallback path stays on the synchronous, fire-and-forget flush()
  // inside cleanup() — it's best-effort only, not guaranteed to land.
  process.on("exit", cleanup);
  // Same reasoning as the signal handlers below, for the other way the process
  // can die without firing "exit": an error nothing caught. Also hands the
  // terminal back — Ink leaves it in raw mode with the cursor hidden.
  installCrashHandlers({
    cleanup,
    restoreTerminal: true,
    unmountUi: () => ui.instance?.unmount(),
    details: () => {
      const file = session.path;
      return file
        ? ["", `The conversation was saved to ${file}`, `Resume it with:  kritya -c ${workspace}`]
        : [];
    },
  });
  // Default signal handling terminates WITHOUT firing "exit", which would
  // orphan background dev servers and MCP children (e.g. when the terminal
  // window closes → SIGHUP). Clean up, then exit with the conventional code.
  // Give the final metrics export a real chance to land first (capped so a
  // hung collector can't stall shutdown) — cleanup()'s own sessionMeter.flush()
  // is fire-and-forget and would otherwise usually be discarded by the
  // process.exit() that follows it.
  for (const [sig, code] of [
    ["SIGTERM", 143],
    ["SIGHUP", 129],
  ] as const) {
    process.on(sig, () => {
      void (async () => {
        await Promise.race([
          sessionMeter.flushAndWait(),
          new Promise((resolve) => setTimeout(resolve, 2000).unref()),
        ]);
        cleanup();
        process.exit(code);
      })();
    });
  }

  // Best-effort retention: session transcripts, audit logs, and telemetry can
  // all carry secrets that passed through tool output, so none of them
  // accumulate forever by default. retentionDaysFor honors config.json's
  // retentionDays / KRITYA_RETENTION_DAYS; 0 or negative disables this.
  const retentionDays = retentionDaysFor(config);
  SessionStore.cleanupOldSessions(retentionDays);
  AuditLog.cleanupOld(retentionDays);
  cleanupOldTelemetry(retentionDays);

  const undoStack = new UndoStack();
  const uiBridge: UiBridge = {
    onTasksUpdate: (_tasks: TaskItem[]) => {},
    onExternalEdit: (_relPath: string) => {},
  };
  undoStack.onExternalChange = (relPath) => uiBridge.onExternalEdit?.(relPath);

  // MCP servers (if any) contribute extra tools; loading is resilient.
  // Project-level .mcp.json is part of the workspace trust gate: it launches
  // processes / contacts endpoints with the user's credentials, so it only
  // takes effect once the workspace is trusted.
  const projectMcp = trustWorkspace ? loadProjectMcpServers(workspace) : undefined;
  const approvedProjectMcp = await resolveMcpServerTrust(projectMcp);

  // Agent Plugins (.kritya/plugins/, ~/.kritya/plugins/). The workspace's own
  // plugins/ folder is part of the same trust gate as .mcp.json above -- a
  // plugin dropped into a cloned repo is just as capable of declaring a
  // server that runs on the user's behalf. User-global plugins are always
  // discovered, same as ~/.kritya/config.json.
  const plugins = scanPlugins(
    trustWorkspace ? [pluginsDir(workspace), userPluginsDir()] : [userPluginsDir()]
  );
  const { servers: pluginMcp } = loadPluginMcpServers(plugins);
  const approvedPluginMcp = await resolveMcpServerTrust(
    Object.keys(pluginMcp).length ? pluginMcp : undefined
  );

  // Filled in once <App> mounts (below) — sampling requests only ever arrive
  // after that, so the callback can safely read it lazily at call time (same
  // pattern as modelRef/providerRef above).
  const permissionRef: { current?: AgentHandlers["requestPermission"] } = {};
  const samplingApprovedServers = new Set<string>();
  const onSampling = async (server: string, req: SamplingRequest): Promise<SamplingResult> => {
    if (!samplingApprovedServers.has(server)) {
      if (!permissionRef.current) return { ok: false, reason: "sampling approval unavailable" };
      const decision = await permissionRef.current(
        `mcp:sampling:${server}`,
        `Server "${server}" wants to use your model to generate text.`
      );
      if (decision === "always") samplingApprovedServers.add(server);
      else if (decision !== "yes") return { ok: false, reason: "user declined" };
    }
    try {
      const result = await client.complete(
        modelRef.current,
        [
          ...(req.systemPrompt ? [{ role: "system" as const, content: req.systemPrompt }] : []),
          ...req.messages.map((m) => ({ role: m.role, content: m.content })),
        ],
        req.maxTokens
      );
      return {
        ok: true,
        role: "assistant",
        content: result.text,
        model: result.model,
        stopReason: result.stopReason,
      };
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
  };

  const elicitationRef: { current?: Required<AgentHandlers>["requestElicitation"] } = {};
  const onElicitation = async (
    server: string,
    message: string,
    fields: ElicitationField[]
  ): Promise<ElicitationResult> => {
    if (!elicitationRef.current) return { action: "cancel" };
    return elicitationRef.current(`[MCP: ${server}] ${message}`, fields);
  };

  const mcpTools: ToolDef[] = await loadMcpTools(
    mergeMcpServers(config.mcpServers, approvedProjectMcp, approvedPluginMcp),
    { tracer: sessionTracer, audit: sessionAudit, workspace, onSampling, onElicitation }
  );
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
      { workspace, sandboxMode, trustWorkspace },
      new PermissionManager(),
      new SessionStore(workspace, true),
      []
    );
    sub.maxSteps = 15;
    sub.audit = sessionAudit;
    sub.tracer = sessionTracer;
    sub.meter = sessionMeter;
    // Share the parent's kill switch: a subagent with its own would keep
    // running after the user stopped the session.
    sub.kill = agent.kill;
    sub.spanParent = agent.turnSpan;
    sub.spanAttributes = { "kritya.subagent": true, "kritya.subagent_task": task.slice(0, 120) };
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
      sessionAudit?.logTool({
        tool: "subagent_worktree",
        summary: `worktree creation failed for task: ${task.slice(0, 72)}`,
        outcome: "error",
      });
      return { task, write: true, summary: "", error: "failed to create an isolated git worktree" };
    }
    sessionAudit?.logTool({
      tool: "subagent_worktree",
      summary: `created branch "${wt.branch}" for task: ${task.slice(0, 72)}`,
      outcome: "ok",
    });

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
        { workspace: wt.dir, sandboxMode, trustWorkspace },
        new PermissionManager({ allow: ["write_file", "edit_file", "shell(*)"], deny: [] }),
        new SessionStore(wt.dir, true),
        []
      );
      sub.maxSteps = 30;
      sub.audit = sessionAudit;
      sub.tracer = sessionTracer;
      sub.meter = sessionMeter;
      sub.kill = agent.kill; // see runReadOnlyAgent
      sub.spanParent = agent.turnSpan;
      sub.spanAttributes = {
        "kritya.subagent": true,
        "kritya.subagent_write": true,
        "kritya.subagent_task": task.slice(0, 120),
        "kritya.subagent_branch": wt.branch,
      };
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
    sessionAudit?.logTool({
      tool: "subagent_worktree",
      summary: `branch "${wt.branch}": commit ${commitState}`,
      outcome: commitState === "failed" ? "error" : "ok",
    });
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
    // Don't stand up worktrees and API calls for work that the shared kill
    // switch would abort on its first step anyway.
    if (agent.kill.active) {
      return specs.map((s) => ({
        task: s.task,
        write: Boolean(s.write),
        summary: "",
        error: "not started — the kill switch is active",
      }));
    }
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
      sandboxMode,
      trustWorkspace,
      undo: undoStack,
      onTasksUpdate: (t) => {
        uiBridge.onTasksUpdate(t);
        session.saveTasks(t);
      },
      spawnAgents,
    },
    new PermissionManager(loadRules(workspace, trustWorkspace)),
    session,
    initialHistory
  );
  agent.contextWindow = contextWindowFor(modelRef.current, config);
  if (config.maxSteps && config.maxSteps > 0) agent.maxSteps = config.maxSteps;
  // Not gated on > 0: 0 is a meaningful setting here ("no cap"), unlike maxSteps.
  if (config.toolTimeoutSeconds !== undefined) {
    agent.toolTimeoutMs = config.toolTimeoutSeconds * 1000;
  }
  agent.hooks = new HookRunner(loadHooks(workspace, trustWorkspace), workspace);
  agent.audit = sessionAudit;
  agent.tracer = sessionTracer;
  agent.meter = sessionMeter;
  agent.hooks.tracer = sessionTracer;
  // Only the main interactive agent distills durable facts into KRITYA.md on
  // compaction — subagents (read-only or write) never do, even though they
  // run the same Agent class and can also trigger auto-compaction.
  agent.autoMemory = true;

  ui.instance = render(
    <App
      agent={agent}
      workspace={workspace}
      modelRef={modelRef}
      providerRef={providerRef}
      config={config}
      resumedCount={initialHistory.length}
      initialTasks={initialTasks}
      undoStack={undoStack}
      uiBridge={uiBridge}
      resumeSessions={resumeSessions.length ? resumeSessions : undefined}
      customCommands={loadCustomCommands(workspace, trustWorkspace, plugins)}
      mcpToolCount={mcpTools.length}
      onSwitchClient={(newClient) => {
        client = newClient;
      }}
      onRequestPermissionReady={(fn) => {
        permissionRef.current = fn;
      }}
      onRequestElicitationReady={(fn) => {
        elicitationRef.current = fn;
      }}
    />
  );
}
