import path from "node:path";
import { Agent } from "./agent/loop.js";
import {
  CONFIG_DIR,
  legacyGlobalModel,
  loadConfig,
  loadDotEnv,
  privacyModeFor,
  resolveProvider,
} from "./config/config.js";
import { DEFAULT_MODEL, contextWindowFor } from "./config/models.js";
import { PermissionManager } from "./permissions/permissions.js";
import { loadRules } from "./permissions/rules.js";
import { ProviderClient } from "./provider/client.js";
import { createSwitchyardClient } from "./provider/switchyardClient.js";
import {
  SWITCHYARD_ROUTE_ID,
  resolveEffectiveModel,
  stopSwitchyardSidecar,
} from "./provider/switchyardSidecar.js";
import { SessionStore } from "./session/store.js";
import { AuditLog } from "./audit/audit.js";
import { createTracer, cleanupOldTelemetry } from "./telemetry/tracer.js";
import { createMeter } from "./telemetry/metrics.js";
import { retentionDaysFor } from "./config/retention.js";
import { backgroundManager } from "./shell/background.js";
import { lspManager } from "./lsp/manager.js";
import { ALL_TOOLS } from "./tools/index.js";
import { loadHooks, HookRunner } from "./hooks/hooks.js";
import { gatedContentHash, isTrusted } from "./trust/trust.js";
import { installCrashHandlers } from "./crash.js";
import { defaultSandboxMode } from "./shell/sandbox.js";

export interface EngineSession {
  agent: Agent;
  session: SessionStore;
  workspace: string;
  provider: string;
  model: string;
  setModel(model: string): void;
  dispose(): Promise<void>;
}

/**
 * Frontend-agnostic session bootstrap shared by every UI that drives the
 * agent core (the Ink CLI builds its own richer version of this in
 * index.tsx for trust/MCP prompts; headless.ts has its own one-shot
 * variant). This is the version non-terminal frontends (e.g. the Electron
 * app) should call instead of duplicating the setup — a change to how
 * Agent is constructed or tools are wired only needs to happen here.
 */
export async function createEngineSession(
  dir: string,
  opts: { provider?: string; model?: string } = {}
): Promise<EngineSession> {
  const workspace = path.resolve(dir);
  loadDotEnv([path.join(CONFIG_DIR, ".env")]);

  const hash = gatedContentHash(workspace);
  const trustWorkspace = !hash || isTrusted(workspace, hash);
  if (trustWorkspace) loadDotEnv([path.join(workspace, ".env")]);

  const config = loadConfig();
  const privacyMode = privacyModeFor(config);
  const provider = resolveProvider(config, opts.provider);
  if (!provider.apiKey) {
    throw new Error(
      `No API key found for provider "${provider.name}". Set it via env var, a .env file, or ~/.kritya/config.json.`
    );
  }

  const providerDefaultModel = config.providers?.[provider.name]?.model;
  let currentModel = resolveEffectiveModel(
    provider.name,
    [opts.model, providerDefaultModel, legacyGlobalModel(config, provider.name)],
    provider.name === "switchyard" ? SWITCHYARD_ROUTE_ID : DEFAULT_MODEL
  );
  const sampling = {
    temperature: provider.temperature,
    topP: provider.topP,
    maxTokens: provider.maxTokens,
  };
  const client =
    provider.name === "switchyard"
      ? await createSwitchyardClient(provider.apiKey, sampling)
      : new ProviderClient(provider.apiKey, provider.baseUrl, sampling);

  const session = new SessionStore(workspace, privacyMode);
  session.start([]);
  const sessionMeter = privacyMode
    ? createMeter(session.id, "off")
    : createMeter(session.id, config.otel);

  // The crash path is fire-and-forget best-effort by Node's own constraints
  // (a crash handler can't reliably await async work), so this uses the
  // synchronous flush() rather than flushAndWait().
  installCrashHandlers({
    cleanup: () => {
      backgroundManager.killAll();
      lspManager.disposeAll();
      sessionMeter.flush();
      sessionMeter.stop();
    },
    details: () => (session.path ? ["", `Transcript: ${session.path}`] : []),
  });

  const retentionDays = retentionDaysFor(config);
  SessionStore.cleanupOldSessions(retentionDays);
  AuditLog.cleanupOld(retentionDays);
  cleanupOldTelemetry(retentionDays);

  const permissions = new PermissionManager(loadRules(workspace, trustWorkspace), workspace);
  const agent = new Agent(
    client,
    () => currentModel,
    ALL_TOOLS,
    { workspace, sandboxMode: config.sandboxExec ?? defaultSandboxMode(), trustWorkspace },
    permissions,
    session,
    []
  );
  agent.contextWindow = contextWindowFor(currentModel, config);
  if (config.maxSteps && config.maxSteps > 0) agent.maxSteps = config.maxSteps;
  if (config.toolTimeoutSeconds !== undefined) {
    agent.toolTimeoutMs = config.toolTimeoutSeconds * 1000;
  }
  if (trustWorkspace) {
    agent.hooks = new HookRunner(loadHooks(workspace, trustWorkspace), workspace);
  }
  agent.audit = privacyMode ? undefined : AuditLog.forSession(session.id, config.audit);
  agent.tracer = privacyMode
    ? createTracer(session.id, "off")
    : createTracer(session.id, config.otel);
  agent.meter = sessionMeter;
  if (agent.hooks) agent.hooks.tracer = agent.tracer;

  return {
    agent,
    session,
    workspace,
    provider: provider.name,
    get model() {
      return currentModel;
    },
    setModel(next: string) {
      currentModel = next;
      agent.contextWindow = contextWindowFor(next, config);
    },
    async dispose() {
      backgroundManager.killAll();
      lspManager.disposeAll();
      if (provider.name === "switchyard") stopSwitchyardSidecar();
      // Normal (non-crash) shutdown: give the final metrics export a real
      // chance to land, capped so a hung collector can't stall dispose().
      await Promise.race([
        sessionMeter.flushAndWait(),
        new Promise((resolve) => setTimeout(resolve, 2000).unref()),
      ]);
      sessionMeter.stop();
    },
  };
}
