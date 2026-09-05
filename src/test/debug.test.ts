import assert from "node:assert/strict";
import { test } from "node:test";

/** Each test needs a fresh module instance since warnedContexts/persistenceWarnings are module-level state. */
async function freshDebugModule() {
  return import(`../config/debug.js?t=${Date.now()}-${Math.random()}`) as Promise<
    typeof import("../config/debug.js")
  >;
}

test("warnPersistenceFailure records the failure so the UI can show it", async () => {
  const { warnPersistenceFailure, activePersistenceWarnings } = await freshDebugModule();
  warnPersistenceFailure("SessionStore.append(/tmp/x.jsonl)", new Error("ENOSPC"));
  const warnings = activePersistenceWarnings();
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].context, "SessionStore.append(/tmp/x.jsonl)");
  assert.equal(warnings[0].message, "ENOSPC");
});

test("warnPersistenceFailure notifies subscribers with the updated list", async () => {
  const { warnPersistenceFailure, onPersistenceWarning } = await freshDebugModule();
  const seen: string[][] = [];
  const unsubscribe = onPersistenceWarning((warnings) => {
    seen.push(warnings.map((w) => w.context));
  });
  warnPersistenceFailure("AuditLog.write(/tmp/audit.jsonl)", new Error("EACCES"));
  unsubscribe();
  assert.deepEqual(seen, [["AuditLog.write(/tmp/audit.jsonl)"]]);
});

test("a second failure in the same context doesn't duplicate the warning", async () => {
  const { warnPersistenceFailure, activePersistenceWarnings } = await freshDebugModule();
  warnPersistenceFailure("tracer.fileSink(/tmp/trace.jsonl)", new Error("EACCES"));
  warnPersistenceFailure("tracer.fileSink(/tmp/trace.jsonl)", new Error("EACCES again"));
  assert.equal(activePersistenceWarnings().length, 1);
});

test("an unsubscribed listener stops receiving updates", async () => {
  const { warnPersistenceFailure, onPersistenceWarning } = await freshDebugModule();
  let calls = 0;
  const unsubscribe = onPersistenceWarning(() => calls++);
  unsubscribe();
  warnPersistenceFailure("postOtlp(/v1/traces)", new Error("fetch failed"));
  assert.equal(calls, 0);
});
