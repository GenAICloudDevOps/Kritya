import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

async function freshHome(): Promise<string> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "kritya-home-"));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  return home;
}

test("listSessions returns the first non-synthetic user message as preview/title, and an accurate count", async () => {
  await freshHome();
  const { SessionStore } = await import(`../session/store.js?t=${Date.now()}-1`);
  const workspace = "/tmp/some-workspace-a";

  const store = new SessionStore(workspace);
  store.start();
  store.append({ role: "user", content: "[undo] reverted 1 file" });
  store.append({ role: "assistant", content: "ok" });
  store.append({ role: "user", content: "  Fix the flaky test in CI   " });
  store.append({ role: "assistant", content: "sure, looking into it" });

  const sessions = SessionStore.listSessions(workspace);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].preview, "Fix the flaky test in CI");
  assert.equal(sessions[0].title, "Fix the flaky test in CI");
  assert.equal(sessions[0].count, 4);
});

test("listSessions falls back to a placeholder when there is no real user message", async () => {
  await freshHome();
  const { SessionStore } = await import(`../session/store.js?t=${Date.now()}-2`);
  const workspace = "/tmp/some-workspace-b";

  const store = new SessionStore(workspace);
  store.start();
  store.append({ role: "user", content: "[undo] reverted 1 file" });

  const sessions = SessionStore.listSessions(workspace);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].preview, "(no preview)");
  assert.equal(sessions[0].title, "(untitled session)");
  assert.equal(sessions[0].count, 1);
});

test("matchesContent finds a query buried later in the session, past the title preview", async () => {
  await freshHome();
  const { SessionStore } = await import(`../session/store.js?t=${Date.now()}-3`);
  const workspace = "/tmp/some-workspace-c";

  const store = new SessionStore(workspace);
  store.start();
  store.append({ role: "user", content: "Fix the flaky test in CI" });
  store.append({ role: "assistant", content: "Sure, digging into the retry logic." });
  store.append({ role: "user", content: "It's the exponential backoff jitter" });

  const [session] = SessionStore.listSessions(workspace);
  assert.equal(SessionStore.matchesContent(session.file, "backoff jitter"), true);
  assert.equal(SessionStore.matchesContent(session.file, "nonexistent phrase"), false);
});

test("matchesContent is case-insensitive and treats an empty query as always matching", async () => {
  await freshHome();
  const { SessionStore } = await import(`../session/store.js?t=${Date.now()}-4`);
  const workspace = "/tmp/some-workspace-d";

  const store = new SessionStore(workspace);
  store.start();
  store.append({ role: "user", content: "Refactor the AUTH module" });

  const [session] = SessionStore.listSessions(workspace);
  assert.equal(SessionStore.matchesContent(session.file, "auth module"), true);
  assert.equal(SessionStore.matchesContent(session.file, ""), true);
});
