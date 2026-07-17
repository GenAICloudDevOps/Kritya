export interface ModelInfo {
  id: string;
  label: string;
  note?: string;
}

/**
 * Curated models on build.nvidia.com known to handle tool calling well.
 * Verified against the live /v1/models catalog on 2026-07-16. IDs change over
 * time — add newer ones via `customModels` in ~/.code-cli/config.json rather
 * than editing this file.
 */
export const CURATED_MODELS: ModelInfo[] = [
  { id: "nvidia/nemotron-3-super-120b-a12b", label: "Nemotron 3 Super 120B", note: "default" },
  { id: "nvidia/nemotron-3-ultra-550b-a55b", label: "Nemotron 3 Ultra 550B" },
  { id: "thinkingmachines/inkling", label: "Inkling" },
  { id: "z-ai/glm-5.2", label: "GLM 5.2", note: "strong agentic coder" },
  { id: "qwen/qwen3.5-397b-a17b", label: "Qwen3.5 397B", note: "strong coding + tool use" },
  { id: "moonshotai/kimi-k2.6", label: "Kimi K2.6", note: "strong agentic tool use" },
  { id: "deepseek-ai/deepseek-v4-pro", label: "DeepSeek V4 Pro" },
  { id: "deepseek-ai/deepseek-v4-flash", label: "DeepSeek V4 Flash", note: "fast + cheap" },
];

export const DEFAULT_MODEL = CURATED_MODELS[0].id;
