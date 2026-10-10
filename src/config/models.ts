import type { CliConfig } from "./config.js";

export interface ModelInfo {
  id: string;
  label: string;
  note?: string;
  /** Context window in tokens; drives auto-compaction and the ctx meter. */
  contextWindow?: number;
  /**
   * Provider this model belongs to (matches a key in `BUILTIN_PROVIDERS`).
   * Models without one are the NVIDIA catalog, which is what this registry
   * started as — so an omitted `provider` means "nvidia" rather than
   * "any provider", and the picker can group without every entry needing
   * the field spelled out.
   */
  provider?: string;
}

/** The provider a `ModelInfo` belongs to, defaulting the historical NVIDIA catalog. */
export function providerOfModel(m: ModelInfo): string {
  return m.provider ?? "nvidia";
}

/** Fallback context window when neither config nor the registry knows the model. */
export const DEFAULT_CONTEXT_WINDOW = 120_000;

/**
 * Curated models on build.nvidia.com known to handle tool calling well.
 * Verified against the live /v1/models catalog on 2026-07-16. IDs change over
 * time — add newer ones via `customModels` in ~/.kritya/config.json rather
 * than editing this file.
 */
export const CURATED_MODELS: ModelInfo[] = [
  {
    id: "nvidia/nemotron-3.5-lightning-30b-a3b",
    label: "Nemotron 3.5 Lightning 30B",
    note: "default",
    contextWindow: 128_000,
  },
  {
    id: "nvidia/nemotron-3-super-120b-a12b",
    label: "Nemotron 3 Super 120B",
    contextWindow: 128_000,
  },
  {
    id: "nvidia/nemotron-3-ultra-550b-a55b",
    label: "Nemotron 3 Ultra 550B",
    contextWindow: 128_000,
  },
  {
    id: "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning",
    label: "Nemotron 3 Nano Omni 30B Reasoning",
    contextWindow: 128_000,
  },
  {
    id: "meta/muse-glimmer-30b",
    label: "Muse Glimmer 30B",
    contextWindow: 128_000,
  },
  {
    id: "deepseek-ai/deepseek-v4-flash-0731",
    label: "DeepSeek V4 Flash",
    note: "fast + cheap",
    contextWindow: 128_000,
  },
  {
    id: "moonshotai/kimi-k3",
    label: "Kimi K3",
    note: "strong agentic tool use",
    contextWindow: 256_000,
  },
  {
    id: "z-ai/glm-5.3",
    label: "GLM 5.3",
    note: "strong agentic tool use",
    contextWindow: 1_048_576,
  },
  {
    id: "z-ai/glm-5.3-flash",
    label: "GLM 5.3 Flash",
    note: "fast + cheap",
    contextWindow: 1_048_576,
  },
  {
    id: "deepseek-ai/deepseek-v4.1-flash",
    label: "DeepSeek V4.1 Flash",
    note: "fast + cheap",
    contextWindow: 1_048_576,
  },
  // Groq (https://console.groq.com/docs/models). Context windows verified
  // against the docs table; both are 131,072.
  {
    id: "openai/gpt-oss-120b",
    label: "GPT-OSS 120B",
    provider: "groq",
    note: "default",
    contextWindow: 131_072,
  },
  {
    id: "llama-3.3-70b-versatile",
    label: "Llama 3.3 70B Versatile",
    provider: "groq",
    contextWindow: 131_072,
  },
];

/** Models registered for one provider, in registry order. */
export function modelsForProvider(provider: string): ModelInfo[] {
  return CURATED_MODELS.filter((m) => providerOfModel(m) === provider);
}

/**
 * The provider a curated model belongs to, or undefined for a model this
 * registry doesn't know (custom models, arbitrary `-m` ids).
 */
export function curatedProviderFor(modelId: string): string | undefined {
  const m = CURATED_MODELS.find((x) => x.id === modelId);
  return m ? providerOfModel(m) : undefined;
}

/** The curated default model for a provider, if it has one. */
export function defaultModelForProvider(provider: string): string | undefined {
  const models = modelsForProvider(provider);
  if (models.length === 0) return undefined;
  // Prefer an entry flagged `note: "default"`, else the first registered.
  return (models.find((m) => m.note === "default") ?? models[0]).id;
}

export const DEFAULT_MODEL = CURATED_MODELS[0].id;

/**
 * The default model id for a given provider. Providers with a curated list use
 * their own default, so `-p groq` with no `-m` sends a Groq model id rather
 * than the NVIDIA default (which the Groq API would reject). Providers with no
 * curated models keep the historical behaviour of falling back to the NVIDIA
 * default, since those are callers passing an arbitrary provider/model pair.
 */
export function defaultModelFor(provider: string): string {
  return defaultModelForProvider(provider) ?? DEFAULT_MODEL;
}

/**
 * Context window for a model. Explicit config.contextWindow always wins; then
 * the curated registry; then the default. Custom models can carry a window via
 * config.pricing? no — via the registry lookup falling back to the default.
 */
export function contextWindowFor(modelId: string, config: CliConfig): number {
  if (config.contextWindow) return config.contextWindow;
  const known = CURATED_MODELS.find((m) => m.id === modelId)?.contextWindow;
  return known ?? DEFAULT_CONTEXT_WINDOW;
}

/**
 * A short display form of a model id for status-line use — the provider
 * prefix plus a slugified curated label, size/param suffix (30B, 550B, …)
 * dropped. Falls back to the raw id for anything not in the curated list
 * (custom models), since there's no label to slugify.
 */
export function modelDisplaySlug(modelId: string): string {
  const curated = CURATED_MODELS.find((m) => m.id === modelId);
  if (!curated) return modelId;
  const prefix = modelId.includes("/") ? modelId.slice(0, modelId.indexOf("/") + 1) : "";
  const slug = curated.label
    .replace(/\s+\d+B$/i, "")
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${prefix}${slug}`;
}

/**
 * "provider/model" for display, without the doubled prefix that comes from
 * naively joining them: several providers' model IDs already carry their own
 * namespace (NVIDIA's catalog is "nvidia/nemotron-...", so the "nvidia"
 * provider plus that model id would otherwise print "nvidia/nvidia/...").
 * Only skip the provider prefix when the model id already starts with it.
 */
export function displayModelId(providerName: string, modelId: string): string {
  return modelId.startsWith(`${providerName}/`) ? modelId : `${providerName}/${modelId}`;
}
