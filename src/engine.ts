import path from "node:path";
import { Agent } from "./agent/loop.js";
import { CONFIG_DIR, loadConfig, loadDotEnv, resolveProvider } from "./config/config.js";
import { DEFAULT_MODEL, contextWindowFor } from "./config/models.js";
import { PermissionManager } from "./permissions/permissions.js";
import { loadRules } from "./permissions/rules.js";
import { ProviderClient } from "./provider/client.js";
import { SessionStore } from "./session/store.js";
import { AuditLog } from "./audit/audit.js";
import { createTracer, cleanupOldTelemetry } from "./telemetry/tracer.js";
import { retentionDaysFor } from "./config/retention.js";
import { backgroundManager } from "./shell/background.js";
import { lspManager } from "./lsp/manager.js";
import { ALL_TOOLS } from "./tools/index.js";
import { loadHooks, HookRunner } from "./hooks/hooks.js";
import { gatedContentHash, isTrusted } from "./trust/trust.js";
import { installCrashHandlers } from "./crash.js";

export interface EngineSession {
  agent: Agent;
  session: SessionStore;
  workspace: string;
  model: string;
  dispose(): void;
}

/**
 * Frontend-agnostic session bootstrap shared by every UI that drives the
 * agent core (the Ink CLI builds its own richer version of this in
 * index.tsx for trust/MCP prompts; headless.ts has its own one-shot
 * variant). This is the version non-terminal frontends (e.g. the Electron
 * app) should call instead of duplicating the setup — a change to how
 * Agent is constructed or tools are wired only needs to happen here.
 */
export async function createEngineSession(dir: string): Promise<EngineSession> {
  const workspace = path.resolve(dir);
  loadDotEnv([path.join(CONFIG_DIR, ".env")]);

  const hash = gatedContentHash(workspace);
  const trustWorkspace = !hash || isTrusted(workspace, hash);
  if (trustWorkspace) loadDotEnv([path.join(workspace, ".env")]);

  const config = loadConfig();
  const provider = resolveProvider(config);
  if (!provider.apiKey) {
    throw new Error(
      `No API key found for provider "${provider.name}". Set it via env var, a .env file, or ~/.kritya/config.json.`
    );
  }

  const providerDefaultModel = config.providers?.[provider.name]?.model;
  const model = config.model || providerDefaultModel || DEFAULT_MODEL;
  const client = new ProviderClient(provider.apiKey, provider.baseUrl, {
    temperature: provider.temperature,
    topP: provider.topP,
    maxTokens: provider.maxTokens,
  });

  const session = new SessionStore(workspace);
  session.start([]);

  installCrashHandlers({
    cleanup: () => {
      backgroundManager.killAll();
      lspManager.disposeAll();
    },
    details: () => (session.path ? ["", `Transcript: ${session.path}`] : []),
  });

  const retentionDays = retentionDaysFor(config);
  SessionStore.cleanupOldSessions(retentionDays);
  AuditLog.cleanupOld(retentionDays);
  cleanupOldTelemetry(retentionDays);

  const permissions = new PermissionManager(loadRules(workspace, trustWorkspace));
  const agent = new Agent(
    client,
    () => model,
    ALL_TOOLS,
    { workspace, sandboxMode: config.sandboxExec ?? "auto" },
    permissions,
    session,
    []
  );
  agent.contextWindow = contextWindowFor(model, config);
  if (config.maxSteps && config.maxSteps > 0) agent.maxSteps = config.maxSteps;
  if (config.toolTimeoutSeconds !== undefined) {
    agent.toolTimeoutMs = config.toolTimeoutSeconds * 1000;
  }
  if (trustWorkspace) {
    agent.hooks = new HookRunner(loadHooks(workspace, trustWorkspace), workspace);
  }
  agent.audit = AuditLog.forSession(session.id, config.audit);
  agent.tracer = createTracer(session.id, config.otel);
  if (agent.hooks) agent.hooks.tracer = agent.tracer;

  return {
    agent,
    session,
    workspace,
    model,
    dispose() {
      backgroundManager.killAll();
      lspManager.disposeAll();
    },
  };
}
