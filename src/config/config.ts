import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { hardenWindowsDir } from "./winAcl.js";
import { debugLog } from "./debug.js";

/** A named, OpenAI-compatible model provider. */
export interface ProviderConfig {
  /**
   * OpenAI-compatible base URL, e.g. https://openrouter.ai/api/v1. Optional:
   * an entry that only overrides part of a built-in provider (say just
   * `model`) inherits the rest from BUILTIN_PROVIDERS — see resolveProvider,
   * which merges the two and falls back to NVIDIA_BASE_URL.
   */
  baseUrl?: string;
  /** Environment variable that holds the API key for this provider. */
  apiKeyEnv?: string;
  /** Literal API key (use apiKeyEnv or a .env file in preference). */
  apiKey?: string;
  /** Default model ID for this provider. */
  model?: string;
  /** Sampling temperature (default 0.2). Set null to omit from requests (some reasoning models reject it). */
  temperature?: number | null;
  /** Nucleus sampling top_p (default 0.95). Set null to omit from requests. */
  topP?: number | null;
  /** Max completion tokens (default 8192). Set null to omit from requests (let the model/provider default apply). */
  maxTokens?: number | null;
}

export interface CliConfig {
  apiKey?: string;
  /**
   * Legacy global default model, applied when the active provider has no
   * `providers.<name>.model` of its own. Prefer setting the model per
   * provider (via `/model`, which now persists to `providers.<name>.model`)
   * — a single global value here is shared by every provider, so a model id
   * meant for one provider can silently leak into another (e.g. bypassing
   * switchyard's routing). Kept only for backward compatibility.
   */
  model?: string;
  baseUrl?: string;
  /** Active provider name (a key of BUILTIN_PROVIDERS or `providers`). Default: nvidia. */
  provider?: string;
  /** Named providers; entries here override or extend BUILTIN_PROVIDERS. */
  providers?: Record<string, ProviderConfig>;
  customModels?: { id: string; label?: string }[];
  /** USD per 1M tokens, keyed by model ID, for /cost estimates. `cachedInput` is the
   * (discounted) rate for prompt tokens served from the provider's cache; when set,
   * /cost prices cached tokens at it and reports the savings. */
  pricing?: Record<string, { input: number; output: number; cachedInput?: number }>;
  /** Model context window in tokens; overrides the per-model default. Drives auto-compaction and the ctx meter. */
  contextWindow?: number;
  /** Max model round-trips per request before kritya stops and asks (default 40). */
  maxSteps?: number;
  /** Session token budget (prompt + completion tokens combined, across all turns/models). Default 1,000,000. */
  tokenBudget?: number;
  /**
   * How long any one tool call may run before it's abandoned and reported as a
   * failure to the model (default 120). Tools that enforce their own deadline
   * — `shell`, subagents, MCP calls — are exempt and keep theirs. 0 or
   * negative disables the cap entirely.
   */
  toolTimeoutSeconds?: number;
  /** MCP servers to launch/connect and expose as tools (stdio or Streamable HTTP). */
  mcpServers?: Record<string, McpServerConfig>;
  /**
   * OS-level sandboxing for shell commands, confining writes to the workspace
   * (bubblewrap on Linux, sandbox-exec on macOS; no effect on Windows). This
   * is a backstop for when destructive-command detection is evaded, not a
   * replacement for it. "auto" (default) sandboxes only commands flagged
   * by classifyDanger; "always" sandboxes every shell command, falling back
   * to unsandboxed execution with a warning if the required binary isn't on
   * PATH; "strict" is the same as "always" but refuses to run the command at
   * all instead of falling back — use this when the sandbox is a hard
   * requirement, not a best-effort one; "off" disables it.
   */
  sandboxExec?: "auto" | "always" | "strict" | "off";
  /**
   * Days to keep session transcripts, audit logs, and telemetry files before
   * they're auto-deleted on startup. Default 15. Set to 0 (or any
   * non-positive number) to keep everything forever (auto-delete disabled).
   * KRITYA_RETENTION_DAYS overrides this if set.
   */
  retentionDays?: number;
  /**
   * Persisted default for the audit log, so it can be turned off without
   * setting KRITYA_AUDIT every launch. "on" (default) records every
   * permission decision and tool execution locally; "off" disables it
   * entirely. KRITYA_AUDIT overrides this if set.
   */
  audit?: "on" | "off";
  /**
   * Persisted default for OpenTelemetry-shaped tracing (see KRITYA_OTEL in
   * the README). "off" (default) — tracing is opt-in. KRITYA_OTEL overrides
   * this if set.
   */
  otel?: "off" | "file" | "console" | "both";
}

/**
 * A Model Context Protocol server: local (stdio) via `command`, or remote
 * (Streamable HTTP) via `url`. Exactly one of the two. String values may
 * reference environment variables as ${VAR} (e.g. an Authorization header).
 */
export interface McpServerConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /**
   * Working directory for a stdio server, relative to the workspace root (or
   * absolute). Defaults to the workspace — NOT to kritya's launch directory,
   * which is arbitrary: a server configured with a relative root (e.g.
   * `server-filesystem .`) would otherwise scope itself to wherever the user
   * happened to be standing, which for `cd ~ && kritya ~/projects/app` means
   * the home directory rather than the project.
   */
  cwd?: string;
  /** Endpoint of a remote Streamable-HTTP server, e.g. https://mcp.linear.app/mcp */
  url?: string;
  /** Extra HTTP headers sent on every request (e.g. Authorization). */
  headers?: Record<string, string>;
  /**
   * Which of the server's tools to expose, by the server's own tool names
   * (`*` wildcards allowed). `deny` wins over `allow`; an omitted `allow`
   * means "everything the server offers".
   *
   * Not just tidiness: every exposed tool's schema is sent on every request,
   * so a 100-tool server costs tokens on each turn and buries the tools that
   * matter under ones the user never calls.
   */
  tools?: McpToolFilter;
  /**
   * Per-tool-call consent policy. `"always-confirm"` requires user approval
   * on every call regardless of the tool's read-only annotation; omitted (or
   * `"trust-hints"`) defers to the server's own read-only hints as today.
   */
  consent?: "trust-hints" | "always-confirm";
  /**
   * Opt in to the `io.modelcontextprotocol/tasks` extension: kritya declares
   * support for it on every `tools/call` to this server, letting the server
   * return a durable task handle instead of blocking. Off by default — a
   * server has no grounds to return a task unless the client declared it.
   */
  tasks?: boolean;
}

export interface McpToolFilter {
  allow?: string[];
  deny?: string[];
}

export const CONFIG_DIR = path.join(os.homedir(), ".kritya");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");

export const NVIDIA_BASE_URL = "https://integrate.api.nvidia.com/v1";

/**
 * Built-in OpenAI-compatible providers. Users select one with `provider` in
 * config (or --provider) and supply the key via the named env var or a .env
 * file. Entries in config.providers override these by name.
 */
export const BUILTIN_PROVIDERS: Record<string, ProviderConfig> = {
  nvidia: { baseUrl: NVIDIA_BASE_URL, apiKeyEnv: "NVIDIA_API_KEY" },
  openai: { baseUrl: "https://api.openai.com/v1", apiKeyEnv: "OPENAI_API_KEY" },
  openrouter: { baseUrl: "https://openrouter.ai/api/v1", apiKeyEnv: "OPENROUTER_API_KEY" },
  groq: { baseUrl: "https://api.groq.com/openai/v1", apiKeyEnv: "GROQ_API_KEY" },
  deepseek: { baseUrl: "https://api.deepseek.com", apiKeyEnv: "DEEPSEEK_API_KEY" },
  mistral: { baseUrl: "https://api.mistral.ai/v1", apiKeyEnv: "MISTRAL_API_KEY" },
  together: { baseUrl: "https://api.together.xyz/v1", apiKeyEnv: "TOGETHER_API_KEY" },
  ollama: { baseUrl: "http://localhost:11434/v1", apiKey: "ollama" },
  // Anthropic and Google both expose OpenAI-compatible endpoints, so they ride
  // the same ProviderClient path as the rest — no native SDK required.
  anthropic: { baseUrl: "https://api.anthropic.com/v1/", apiKeyEnv: "ANTHROPIC_API_KEY" },
  gemini: {
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/",
    apiKeyEnv: "GEMINI_API_KEY",
  },
  // Not a real network target: `baseUrl` here is a placeholder. The actual
  // client is built by createSwitchyardClient (switchyardClient.ts), which
  // launches a local switchyard-server sidecar on a free port and points at
  // that instead. Needs NVIDIA_API_KEY — the sidecar's own outbound calls
  // and kritya's cross-model fallback both use it directly.
  switchyard: { baseUrl: "http://127.0.0.1/v1", apiKeyEnv: "NVIDIA_API_KEY" },
};

export interface ResolvedProvider {
  name: string;
  baseUrl: string;
  apiKey?: string;
  temperature?: number | null;
  topP?: number | null;
  maxTokens?: number | null;
}

/**
 * Resolve the active provider's base URL and API key. Precedence for the
 * provider name: explicit override (--provider) > config.provider > "nvidia".
 * Legacy top-level apiKey/baseUrl and NVIDIA_API_KEY continue to work for the
 * default nvidia provider.
 */
export function resolveProvider(config: CliConfig, override?: string): ResolvedProvider {
  const name = override || config.provider || "nvidia";
  const merged: ProviderConfig = {
    ...BUILTIN_PROVIDERS[name],
    ...config.providers?.[name],
  };

  let baseUrl = merged.baseUrl;
  if (name === "nvidia" && config.baseUrl) baseUrl = config.baseUrl;
  if (!baseUrl) baseUrl = NVIDIA_BASE_URL;

  let apiKey: string | undefined;
  if (merged.apiKeyEnv) apiKey = process.env[merged.apiKeyEnv];
  if (!apiKey) apiKey = merged.apiKey;
  if (!apiKey && name === "nvidia") apiKey = process.env.NVIDIA_API_KEY || config.apiKey;

  return {
    name,
    baseUrl,
    apiKey,
    temperature: merged.temperature,
    topP: merged.topP,
    maxTokens: merged.maxTokens,
  };
}

/**
 * The legacy top-level `config.model`, but only for the provider it was
 * actually chosen on.
 *
 * That field predates per-provider models and is shared by every provider, so
 * a value saved while (say) nvidia was active would otherwise be applied to
 * every other provider too — which is how an nvidia model id ends up
 * bypassing switchyard's routing and 404-ing. `config.provider` records which
 * provider was active when it was written, so scoping it there keeps existing
 * configs working for their own provider without leaking anywhere else.
 * Returns undefined for every other provider, letting them fall through to
 * their own default.
 */
export function legacyGlobalModel(config: CliConfig, providerName: string): string | undefined {
  const savedUnder = config.provider || "nvidia";
  return providerName === savedUnder ? config.model : undefined;
}

export interface ProviderStatus {
  name: string;
  hasKey: boolean;
}

/**
 * All providers kritya knows about — builtins plus anything named under
 * `config.providers` — with whether each currently resolves to a usable API
 * key. This is the fallback chain offered when the active provider's
 * requests keep failing (see RetryExhaustedError / the /provider command):
 * only entries with `hasKey: true` are actually switchable right now.
 */
export function listProviders(config: CliConfig): ProviderStatus[] {
  const names = new Set([
    ...Object.keys(BUILTIN_PROVIDERS),
    ...Object.keys(config.providers ?? {}),
  ]);
  return [...names]
    .sort()
    .map((name) => ({ name, hasKey: !!resolveProvider(config, name).apiKey }));
}

export function loadConfig(): CliConfig {
  try {
    const raw = fs.readFileSync(CONFIG_FILE, "utf8");
    return JSON.parse(raw) as CliConfig;
  } catch (err) {
    // A missing file is normal on first run; a malformed one is worth being
    // able to see when someone reports "my config isn't taking effect".
    debugLog(`loadConfig(${CONFIG_FILE})`, err);
    return {};
  }
}

/**
 * Persist `model` as the default for one provider, leaving every other
 * provider's entry — and that provider's own other fields (apiKey, baseUrl…)
 * — intact. Merges against what's currently on disk rather than an in-memory
 * snapshot, so a provider added to config.json after startup isn't dropped.
 *
 * This is the per-provider replacement for writing the top-level
 * `config.model`, which every provider shared; see legacyGlobalModel.
 */
export function saveProviderModel(providerName: string, model: string): void {
  const providers = loadConfig().providers ?? {};
  saveConfig({
    providers: {
      ...providers,
      [providerName]: { ...providers[providerName], model },
    },
  });
}

export function saveConfig(patch: Partial<CliConfig>): void {
  const current = loadConfig();
  const next = { ...current, ...patch };
  // config.json can hold a literal apiKey — keep it readable only by the owner.
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  hardenWindowsDir(CONFIG_DIR);
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
  // `mode` on writeFileSync only applies when creating a new file; enforce it
  // even if config.json pre-existed with looser permissions.
  try {
    fs.chmodSync(CONFIG_FILE, 0o600);
  } catch (err) {
    debugLog(`saveConfig chmod(${CONFIG_FILE})`, err);
  }
}

/**
 * A copy of process.env with kritya-managed secrets removed. Every built-in
 * provider key and the web-search key end in _API_KEY; commands the agent runs
 * (and user hooks) have no business reading them, and under prompt injection
 * an approved-looking shell command is an easy exfiltration channel. Commands
 * that genuinely need such a key must receive it explicitly (e.g. inline in
 * the command), same as MCP servers declare theirs via `env`.
 */
// Provider credentials (and anything shaped like a credential) that shell
// commands and background processes must not inherit. Beyond the provider
// *_API_KEY vars this always covered, this also strips *_TOKEN, *_SECRET,
// *_PASSWORD (common CI/CD and package-registry credential shapes — GitHub,
// npm, Docker Hub tokens; DB passwords) and the AWS credential trio, which
// were previously passed through intact. AWS_REGION/AWS_PROFILE etc. are
// left alone — they're not secrets and ordinary `aws` CLI calls need them.
const SCRUBBED_ENV_RE = /_(API_KEY|TOKEN|SECRET|PASSWORD)$/i;
const SCRUBBED_AWS_ENV_RE = /^AWS_(ACCESS_KEY_ID|SECRET_ACCESS_KEY|SESSION_TOKEN|SECURITY_TOKEN)$/i;

export function scrubbedShellEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (SCRUBBED_ENV_RE.test(key)) continue;
    if (SCRUBBED_AWS_ENV_RE.test(key)) continue;
    env[key] = value;
  }
  return env;
}

/** Parse simple KEY=VALUE lines; ignores comments, blanks, and export prefixes. */
export function parseDotEnv(raw: string): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(trimmed);
    if (!match) continue;
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    vars[match[1]] = value;
  }
  return vars;
}

/**
 * Load .env files into process.env without overriding variables that are
 * already set. Missing files are skipped silently.
 */
export function loadDotEnv(paths: string[]): void {
  for (const p of paths) {
    let raw: string;
    try {
      raw = fs.readFileSync(p, "utf8");
    } catch {
      continue;
    }
    for (const [key, value] of Object.entries(parseDotEnv(raw))) {
      if (process.env[key] === undefined) process.env[key] = value;
    }
  }
}
