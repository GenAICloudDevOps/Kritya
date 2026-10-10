import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CURATED_MODELS,
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MODEL,
  contextWindowFor,
  curatedProviderFor,
  defaultModelFor,
  defaultModelForProvider,
  modelsForProvider,
  providerOfModel,
} from "../config/models.js";
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

test("a model without an explicit provider is treated as nvidia", () => {
  const nvidia = CURATED_MODELS.find((m) => m.id.startsWith("nvidia/"));
  assert.ok(nvidia);
  assert.equal(providerOfModel(nvidia), "nvidia");
  assert.equal(providerOfModel({ id: "x", label: "X" }), "nvidia");
});

test("modelsForProvider returns only that provider's entries", () => {
  const groq = modelsForProvider("groq");
  assert.deepEqual(groq.map((m) => m.id).sort(), [
    "openai/gpt-oss-120b",
    "openai/gpt-oss-20b",
  ]);
  assert.ok(groq.every((m) => m.provider === "groq"));
  assert.ok(modelsForProvider("nvidia").every((m) => providerOfModel(m) === "nvidia"));
});

test("curatedProviderFor reports the owner of a known id and undefined for an unknown one", () => {
  assert.equal(curatedProviderFor("openai/gpt-oss-120b"), "groq");
  assert.equal(curatedProviderFor("nvidia/nemotron-3-super-120b-a12b"), "nvidia");
  assert.equal(curatedProviderFor("acme/custom"), undefined);
});

test("defaultModelForProvider prefers the entry flagged as the default", () => {
  assert.equal(defaultModelForProvider("groq"), "openai/gpt-oss-120b");
  assert.equal(defaultModelForProvider("ollama"), undefined);
});

test("defaultModelFor gives a provider its own default, so -p groq does not send an NVIDIA id", () => {
  assert.equal(defaultModelFor("groq"), "openai/gpt-oss-120b");
  assert.equal(defaultModelFor("nvidia"), DEFAULT_MODEL);
});

test("defaultModelFor keeps the historical NVIDIA fallback for a provider with no curated models", () => {
  assert.equal(defaultModelFor("ollama"), DEFAULT_MODEL);
  assert.equal(defaultModelFor("together"), DEFAULT_MODEL);
});

test("the Groq entries carry the context window their docs state", () => {
  for (const m of modelsForProvider("groq")) {
    assert.equal(m.contextWindow, 131_072, `${m.id} context window`);
  }
});
