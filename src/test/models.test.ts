import assert from "node:assert/strict";
import { test } from "node:test";
import { CURATED_MODELS, DEFAULT_CONTEXT_WINDOW, contextWindowFor } from "../config/models.js";
import type { CliConfig } from "../config/config.js";

test("contextWindowFor prefers an explicit config.contextWindow over everything else", () => {
  const config = { contextWindow: 42_000 } as CliConfig;
  assert.equal(contextWindowFor(CURATED_MODELS[0].id, config), 42_000);
  assert.equal(contextWindowFor("some/unknown-model", config), 42_000);
});

test("contextWindowFor falls back to the curated registry's window for a known model", () => {
  const known = CURATED_MODELS[0];
  assert.equal(contextWindowFor(known.id, {} as CliConfig), known.contextWindow);
});

test("contextWindowFor falls back to the default window for an unknown model with no config override", () => {
  assert.equal(
    contextWindowFor("totally/unknown-model-id", {} as CliConfig),
    DEFAULT_CONTEXT_WINDOW
  );
});
