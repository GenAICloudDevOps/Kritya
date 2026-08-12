import type { CliConfig } from "./config.js";

export interface ModelInfo {
  id: string;
  label: string;
  note?: string;
  /** Context window in tokens; drives auto-compaction and the ctx meter. */
  contextWindow?: number;
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
    id: "meta/muse-glimmer-30b",
    label: "Muse Glimmer 30B",
    contextWindow: 128_000,
  },
  { id: "thinkingmachines/inkling", label: "Inkling", contextWindow: 128_000 },
  { id: "z-ai/glm-5.2", label: "GLM 5.2", note: "strong agentic coder", contextWindow: 200_000 },
  {
    id: "qwen/qwen3.5-397b-a17b",
    label: "Qwen3.5 397B",
    note: "strong coding + tool use",
    contextWindow: 256_000,
  },
  {
    id: "moonshotai/kimi-k2.6",
    label: "Kimi K2.6",
    note: "strong agentic tool use",
    contextWindow: 256_000,
  },
  { id: "deepseek-ai/deepseek-v4-pro", label: "DeepSeek V4 Pro", contextWindow: 128_000 },
  {
    id: "deepseek-ai/deepseek-v4-flash",
    label: "DeepSeek V4 Flash",
    note: "fast + cheap",
    contextWindow: 128_000,
  },
];

export const DEFAULT_MODEL = CURATED_MODELS[0].id;

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
