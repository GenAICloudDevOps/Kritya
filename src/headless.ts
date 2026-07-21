import path from "node:path";
import { Agent } from "./agent/loop.js";
import {
  CONFIG_DIR,
  listProviders,
  loadConfig,
  loadDotEnv,
  resolveProvider,
} from "./config/config.js";
import { DEFAULT_MODEL, contextWindowFor } from "./config/models.js";
import { PermissionManager } from "./permissions/permissions.js";
import { loadRules } from "./permissions/rules.js";
import { ProviderClient, RetryExhaustedError } from "./provider/client.js";
import { SessionStore } from "./session/store.js";
import { AuditLog } from "./audit/audit.js";
import { createTracer } from "./telemetry/tracer.js";
import { backgroundManager } from "./shell/background.js";
import { lspManager } from "./lsp/manager.js";
import { ALL_TOOLS } from "./tools/index.js";
import { loadMcpTools, shutdownMcp } from "./mcp/client.js";
import { loadProjectMcpServers, mergeMcpServers } from "./mcp/servers.js";
import { loadHooks, HookRunner } from "./hooks/hooks.js";
import { gatedContentHash, isTrusted } from "./trust/trust.js";
import { partitionByTrust, serverFingerprint, trustServer } from "./trust/mcpTrust.js";
import type { AgentHandlers, ToolDef } from "./types.js";

export interface HeadlessArgs {
  dir: string;
  prompt: string;
  provider: string;
  model: string;
  continue: boolean;
  output: "text" | "json";
  allowAll: boolean;
  trust: boolean;
  timeoutSeconds: number;
}

interface ToolCallRecord {
  name: string;
  summary: string;
  error: boolean;
}

interface HeadlessResult {
  success: boolean;
  result: string;
  error?: string;
  toolCalls: ToolCallRecord[];
  usage: { promptTokens: number; completionTokens: number; cachedPromptTokens: number };
  durationMs: number;
  model?: string;
}

function emit(args: HeadlessArgs, r: HeadlessResult): void {
  if (args.output === "json") {
    console.log(JSON.stringify(r));
    return;
  }
  if (r.result) console.log(r.result);
  if (r.error) console.error(`Error: ${r.error}`);
}

/**
 * Runs a single prompt to completion with no terminal UI at all — for
 * scripting, CI pipelines, and GitHub Actions (`kritya --prompt "..." --output json`).
 * Returns the process exit code (0 success, 1 failure) rather than exiting
 * itself, so the caller can flush stdio first.
 */
export async function runHeadless(args: HeadlessArgs): Promise<number> {
  const startedAt = Date.now();
  const workspace = path.resolve(args.dir);

  // Only the user's own global .env is unconditionally trusted; see below.
  loadDotEnv([path.join(CONFIG_DIR, ".env")]);

  // There's no terminal to show the interactive trust prompt, so headless
  // mode never blocks on it. The workspace's gated content (its own allow
  // rules, hooks, .env, and custom commands) only takes effect if it was
  // already trusted in a prior interactive session, or --trust opts in
  // explicitly — never silently, since CI checking out arbitrary PR branches
  // is exactly the scenario that trust gate exists to protect against.
  const hash = gatedContentHash(workspace);
  const trustWorkspace = args.trust || !hash || isTrusted(workspace, hash);
  if (trustWorkspace) loadDotEnv([path.join(workspace, ".env")]);

  const config = loadConfig();
  const provider = resolveProvider(config, args.provider || undefined);
  if (!provider.apiKey) {
    return finish(args, startedAt, {
      success: false,
      result: "",
      error: `No API key found for provider "${provider.name}". Set it via env var, a .env file, or ~/.kritya/config.json.`,
      toolCalls: [],
      usage: { promptTokens: 0, completionTokens: 0, cachedPromptTokens: 0 },
      durationMs: 0,
    });
  }

  const providerDefaultModel = config.providers?.[provider.name]?.model;
  const model = args.model || config.model || providerDefaultModel || DEFAULT_MODEL;
  const client = new ProviderClient(provider.apiKey, provider.baseUrl, {
    temperature: provider.temperature,
    topP: provider.topP,
    maxTokens: provider.maxTokens,
  });

  const session = new SessionStore(workspace);
  const initialHistory = args.continue ? (SessionStore.loadLatest(workspace) ?? []) : [];
  session.start(initialHistory);

  // Subagents (spawn_agent/spawn_write_agent) aren't wired up here — they
  // need per-call worktree/concurrency plumbing that isn't worth duplicating
  // for a single headless prompt. If the model tries to use one, the tool
  // itself reports "not available in this session", same as any context
  // that doesn't wire spawnAgents.
  // .mcp.json is trust-gated for the same reason hooks and .env are: it runs
  // processes / contacts endpoints on the user's behalf the moment we load it.
  const projectMcp = trustWorkspace ? loadProjectMcpServers(workspace) : undefined;
  // On top of that, each individual server needs its own prior approval (see
  // trust/mcpTrust.ts) — there's no terminal here to prompt for new ones, so
  // headless mode only loads servers already approved in a past interactive
  // session, unless --trust opts in (same escape hatch as workspace trust).
  let approvedProjectMcp = projectMcp;
  if (projectMcp) {
    const { trusted, pending } = partitionByTrust(projectMcp);
    if (Object.keys(pending).length > 0) {
      if (args.trust) {
        for (const [name, cfg] of Object.entries(pending))
          trustServer(name, serverFingerprint(cfg));
        approvedProjectMcp = { ...trusted, ...pending };
      } else {
        approvedProjectMcp = trusted;
        process.stderr.write(
          `kritya: skipping unapproved MCP server(s) from .mcp.json: ${Object.keys(pending).join(", ")} ` +
            `(approve them once interactively, or pass --trust)\n`
        );
      }
    }
  }
  const mcpTools: ToolDef[] = await loadMcpTools(
    mergeMcpServers(config.mcpServers, approvedProjectMcp)
  );
  const tools: ToolDef[] = [...ALL_TOOLS, ...mcpTools];

  const permissions = new PermissionManager(loadRules(workspace, trustWorkspace));
  const agent = new Agent(
    client,
    () => model,
    tools,
    { workspace },
    permissions,
    session,
    initialHistory
  );
  agent.contextWindow = contextWindowFor(model, config);
  if (config.maxSteps && config.maxSteps > 0) agent.maxSteps = config.maxSteps;
  agent.hooks = new HookRunner(loadHooks(workspace, trustWorkspace), workspace);
  agent.audit = AuditLog.forSession(session.id);
  agent.tracer = createTracer(session.id);

  const toolCalls: ToolCallRecord[] = [];
  let usage = { promptTokens: 0, completionTokens: 0, cachedPromptTokens: 0 };
  let finalText = "";

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, args.timeoutSeconds) * 1000);
  timer.unref();

  const handlers: AgentHandlers = {
    onTextDelta: () => {},
    onReasoningDelta: () => {},
    onAssistantText: (text) => {
      finalText = text;
    },
    onToolStart: () => {},
    onToolEnd: (_id, name, summary, _preview, isError) => {
      toolCalls.push({ name, summary, error: isError });
    },
    // No terminal to ask. A destructive command (classifyDanger sets
    // `warning`) is always denied, no matter what — there's no one to
    // confirm it and letting it run unattended would be unsafe. Anything
    // else follows --allow-all, or falls through to settings.json allow
    // rules (which PermissionManager already applied before this is called).
    requestPermission: async (_name, _summary, _diff, warning) => {
      if (warning) return "no";
      return args.allowAll ? "yes" : "no";
    },
    onUsage: (u) => {
      usage = {
        promptTokens: usage.promptTokens + u.promptTokens,
        completionTokens: usage.completionTokens + u.completionTokens,
        cachedPromptTokens: usage.cachedPromptTokens + (u.cachedPromptTokens ?? 0),
      };
    },
  };

  let success = true;
  let errorMessage: string | undefined;
  try {
    await agent.runTurn(args.prompt, handlers, controller.signal);
  } catch (err) {
    success = false;
    const isTimeout = controller.signal.aborted;
    if (isTimeout) {
      errorMessage = `Timed out after ${args.timeoutSeconds}s (--timeout to raise it)`;
    } else if (err instanceof RetryExhaustedError) {
      const alternatives = listProviders(config)
        .filter((p) => p.hasKey && p.name !== provider.name)
        .map((p) => p.name);
      const hint = alternatives.length
        ? ` Retry with --provider ${alternatives[0]}` +
          (alternatives.length > 1
            ? ` (also configured: ${alternatives.slice(1).join(", ")})`
            : "") +
          `.`
        : " No other provider has an API key configured to fall back to.";
      errorMessage = `${err.message}.${hint}`;
    } else {
      errorMessage = err instanceof Error ? err.message : String(err);
    }
  } finally {
    clearTimeout(timer);
    backgroundManager.killAll();
    lspManager.disposeAll();
    shutdownMcp();
  }

  return finish(args, startedAt, {
    success,
    result: finalText,
    error: errorMessage,
    toolCalls,
    usage,
    durationMs: Date.now() - startedAt,
    model,
  });
}

function finish(
  args: HeadlessArgs,
  startedAt: number,
  r: Omit<HeadlessResult, "durationMs"> & { durationMs?: number }
): number {
  const result: HeadlessResult = { ...r, durationMs: r.durationMs ?? Date.now() - startedAt };
  emit(args, result);
  return result.success ? 0 : 1;
}
