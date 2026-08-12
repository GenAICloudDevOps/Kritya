import assert from "node:assert/strict";
import { test } from "node:test";
import {
  SWITCHYARD_ROUTE_ID,
  SWITCHYARD_STRONG_MODEL,
  SWITCHYARD_WEAK_MODEL,
  resolveEffectiveModel,
  routesToml,
  staleSwitchyardModelWarning,
} from "../provider/switchyardSidecar.js";

test("routesToml wires the weak/strong targets and a capability-mode route", () => {
  const toml = routesToml("https://integrate.api.nvidia.com/v1");

  assert.match(toml, /schema_version = 1/);
  assert.match(toml, /base_url = "https:\/\/integrate\.api\.nvidia\.com\/v1"/);
  assert.match(toml, /api_key_env = "NVIDIA_API_KEY"/);

  assert.match(toml, new RegExp(`\\[targets\\.weak\\]\\nid = "${SWITCHYARD_WEAK_MODEL}"`));
  assert.match(toml, new RegExp(`\\[targets\\.strong\\]\\nid = "${SWITCHYARD_STRONG_MODEL}"`));

  assert.match(toml, new RegExp(`\\[routes\\.${SWITCHYARD_ROUTE_ID}\\]`));
  assert.match(toml, /type = "llm_classifier"/);
  assert.match(toml, /mode = "capability"/);
  assert.match(toml, /classifier_target = "weak"/);
  assert.match(toml, /strong_target = "strong"/);
  assert.match(toml, /weak_target = "weak"/);
  assert.match(toml, /base_threshold = 0\.5/);

  // Escalation-mode fields must not linger from the earlier design (see the
  // conversation history: mode=escalation with classifier_target=weak never
  // escalated, since the weak model was grading its own answers).
  assert.doesNotMatch(toml, /mode = "escalation"/);
  assert.doesNotMatch(toml, /escalation = /);
});

test("resolveEffectiveModel skips a stale switchyard route id for any other provider", () => {
  assert.equal(
    resolveEffectiveModel("nvidia", [SWITCHYARD_ROUTE_ID, "nvidia/some-model"], "fallback-model"),
    "nvidia/some-model",
    "the route id candidate is skipped, the next real model wins"
  );
  assert.equal(
    resolveEffectiveModel("nvidia", [SWITCHYARD_ROUTE_ID], "fallback-model"),
    "fallback-model",
    "with nothing but the route id to offer, it falls through to the fallback"
  );
});

test("resolveEffectiveModel accepts the switchyard route id when switchyard is active", () => {
  assert.equal(
    resolveEffectiveModel("switchyard", [SWITCHYARD_ROUTE_ID], "fallback-model"),
    SWITCHYARD_ROUTE_ID
  );
});

test("resolveEffectiveModel tries candidates in order and skips empty ones", () => {
  assert.equal(
    resolveEffectiveModel("nvidia", [undefined, "", "real-model", "later-model"], "fallback-model"),
    "real-model"
  );
});

test("resolveEffectiveModel falls back when every candidate is empty", () => {
  assert.equal(
    resolveEffectiveModel("nvidia", [undefined, undefined], "fallback-model"),
    "fallback-model"
  );
});

test("staleSwitchyardModelWarning is silent off switchyard, with an explicit --model, or on the route id", () => {
  assert.equal(staleSwitchyardModelWarning("nvidia", "nvidia/some-model", undefined), undefined);
  assert.equal(
    staleSwitchyardModelWarning("switchyard", "nvidia/some-model", "nvidia/some-model"),
    undefined
  );
  assert.equal(staleSwitchyardModelWarning("switchyard", undefined, undefined), undefined);
  assert.equal(
    staleSwitchyardModelWarning("switchyard", SWITCHYARD_ROUTE_ID, undefined),
    undefined
  );
});

test("staleSwitchyardModelWarning fires when a raw model id resolves under switchyard", () => {
  const warning = staleSwitchyardModelWarning(
    "switchyard",
    "nvidia/nemotron-3-ultra-550b-a55b",
    undefined
  );
  assert.ok(warning);
  assert.match(warning, /nvidia\/nemotron-3-ultra-550b-a55b/);
  assert.match(warning, /\/model switchyard/);
});
