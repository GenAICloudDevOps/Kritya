import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { hardenWindowsDir } from "./winAcl.js";

/** A named, OpenAI-compatible model provider. */
export interface ProviderConfig {
  /** OpenAI-compatible base URL, e.g. https://openrouter.ai/api/v1 */
  baseUrl: string;
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
  /** MCP servers to launch/connect and expose as tools (stdio or Streamable HTTP). */
  mcpServers?: Record<string, McpServerConfig>;
  /**
   * OS-level sandboxing for shell commands, confining writes to the workspace
   * (bubblewrap on Linux, sandbox-exec on macOS; no effect on Windows). This
   * is a backstop for when destructive-command detection is evaded, not a
   * replacement for it. "auto" (recommended) sandboxes only commands flagged
   * by classifyDanger; "always" sandboxes every shell command; "off" (default)
   * disables it. Falls back to unsandboxed execution with a warning if the
   * required binary isn't on PATH.
   */
  sandboxExec?: "auto" | "always" | "off";
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
  /** Endpoint of a remote Streamable-HTTP server, e.g. https://mcp.linear.app/mcp */
  url?: string;
  /** Extra HTTP headers sent on every request (e.g. Authorization). */
  headers?: Record<string, string>;
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
  } as ProviderConfig;

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
  } catch {
    return {};
  }
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
  } catch {
    // best-effort
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
export function scrubbedShellEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/_API_KEY$/i.test(key)) continue;
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
