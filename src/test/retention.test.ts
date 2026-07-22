import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_RETENTION_DAYS, retentionDaysFor } from "../config/retention.js";

function withEnv(env: Record<string, string | undefined>, fn: () => void): void {
  const prev: Record<string, string | undefined> = {};
  for (const k of Object.keys(env)) prev[k] = process.env[k];
  try {
    for (const [k, v] of Object.entries(env)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test("retentionDaysFor defaults to 15 days with no config and no env var", () => {
  withEnv({ KRITYA_RETENTION_DAYS: undefined }, () => {
    assert.equal(retentionDaysFor({}), DEFAULT_RETENTION_DAYS);
    assert.equal(DEFAULT_RETENTION_DAYS, 15);
  });
});

test("retentionDaysFor honors config.retentionDays when set", () => {
  withEnv({ KRITYA_RETENTION_DAYS: undefined }, () => {
    assert.equal(retentionDaysFor({ retentionDays: 90 }), 90);
    assert.equal(retentionDaysFor({ retentionDays: 0 }), 0, "0 means keep forever, not '0 days'");
  });
});

test("retentionDaysFor: the env var wins over config.retentionDays", () => {
  withEnv({ KRITYA_RETENTION_DAYS: "3" }, () => {
    assert.equal(retentionDaysFor({ retentionDays: 90 }), 3);
  });
});

test("retentionDaysFor ignores a non-numeric env var and falls through", () => {
  withEnv({ KRITYA_RETENTION_DAYS: "not-a-number" }, () => {
    assert.equal(retentionDaysFor({ retentionDays: 7 }), 7);
    assert.equal(retentionDaysFor({}), DEFAULT_RETENTION_DAYS);
  });
});
