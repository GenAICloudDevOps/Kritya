import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface CliConfig {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  customModels?: { id: string; label?: string }[];
  /** USD per 1M tokens, keyed by model ID, for /cost estimates. */
  pricing?: Record<string, { input: number; output: number }>;
}

export const CONFIG_DIR = path.join(os.homedir(), ".code-cli");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");

export const NVIDIA_BASE_URL = "https://integrate.api.nvidia.com/v1";

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
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2) + "\n");
}

export function resolveApiKey(config: CliConfig): string | undefined {
  return process.env.NVIDIA_API_KEY || config.apiKey;
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
