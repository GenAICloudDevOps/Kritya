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

test("loadFile recovers all complete messages when the last line was truncated mid-write (crash simulation)", async () => {
  await freshHome();
  const { SessionStore } = await import(`../session/store.js?t=${Date.now()}-5`);
  const workspace = "/tmp/some-workspace-e";

  const store = new SessionStore(workspace);
  store.start();
  store.append({ role: "user", content: "first message" });
  store.append({ role: "assistant", content: "second message" });

  const [session] = SessionStore.listSessions(workspace);
  const full = await fs.readFile(session.file, "utf8");
  // Simulate a crash mid-append: chop the trailing line partway through,
  // like a process killed mid-write to the last JSON line.
  const truncated = full.slice(0, full.length - 10);
  await fs.writeFile(session.file, truncated, "utf8");

  const messages = SessionStore.loadFile(session.file);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].content, "first message");
});

test("overwrite rewrites the session to exactly the given messages (used by /rewind)", async () => {
  await freshHome();
  const { SessionStore } = await import(`../session/store.js?t=${Date.now()}-rewind`);
  const workspace = "/tmp/some-workspace-rewind";

  const store = new SessionStore(workspace);
  store.start();
  store.append({ role: "user", content: "one" });
  store.append({ role: "assistant", content: "two" });
  store.append({ role: "user", content: "three" });

  // Rewind: keep only the first message.
  store.overwrite([{ role: "user", content: "one" }]);

  const [session] = SessionStore.listSessions(workspace);
  const messages = SessionStore.loadFile(session.file);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].content, "one");

  // No leftover .tmp-* file — overwrite renames atomically like the rest.
  const dirFiles = await fs.readdir(path.dirname(session.file));
  assert.ok(!dirFiles.some((f) => f.includes(".tmp-")));
});

test("saveTasks/loadTasksForSession round-trip and never leave a partial file (rename is atomic)", async () => {
  await freshHome();
  const { SessionStore } = await import(`../session/store.js?t=${Date.now()}-6`);
  const workspace = "/tmp/some-workspace-f";

  const store = new SessionStore(workspace);
  store.start();
  store.append({ role: "user", content: "hi" });
  const [session] = SessionStore.listSessions(workspace);

  store.saveTasks([{ text: "do the thing", status: "pending" }]);
  const loaded = SessionStore.loadTasksForSession(session.file);
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].text, "do the thing");

  // No leftover .tmp-* file should remain in the session directory after a
  // successful save — writeFileAtomic renames it into place.
  const dirFiles = await fs.readdir(path.dirname(session.file));
  assert.ok(!dirFiles.some((f) => f.includes(".tmp-")));
});

test("isSessionFile accepts a real file inside that workspace's session directory", async () => {
  await freshHome();
  const { SessionStore } = await import(`../session/store.js?t=${Date.now()}-7`);
  const workspace = "/tmp/some-workspace-g";

  const store = new SessionStore(workspace);
  store.start();
  store.append({ role: "user", content: "hi" });
  const [session] = SessionStore.listSessions(workspace);

  assert.equal(SessionStore.isSessionFile(workspace, session.file), true);
});

test("isSessionFile rejects a path outside the workspace's session directory (traversal / arbitrary file read)", async () => {
  const home = await freshHome();
  const { SessionStore } = await import(`../session/store.js?t=${Date.now()}-8`);
  const workspace = "/tmp/some-workspace-h";

  const outside = path.join(home, "not-a-session.jsonl");
  await fs.writeFile(outside, JSON.stringify({ role: "user", content: "secret" }) + "\n");

  assert.equal(SessionStore.isSessionFile(workspace, outside), false);
  assert.equal(SessionStore.isSessionFile(workspace, "/etc/passwd"), false);
  assert.equal(SessionStore.isSessionFile(workspace, "../../etc/passwd"), false);
});

test("isSessionFile rejects a path from a different workspace's session directory", async () => {
  await freshHome();
  const { SessionStore } = await import(`../session/store.js?t=${Date.now()}-9`);
  const workspaceA = "/tmp/some-workspace-i";
  const workspaceB = "/tmp/some-workspace-j";

  const storeB = new SessionStore(workspaceB);
  storeB.start();
  storeB.append({ role: "user", content: "hi" });
  const [sessionB] = SessionStore.listSessions(workspaceB);

  assert.equal(SessionStore.isSessionFile(workspaceA, sessionB.file), false);
});

test("loadFile caps how much of an oversized session file it reads into memory, keeping the most recent messages", async () => {
  await freshHome();
  const { SessionStore, readSessionFileCapped } = await import(
    `../session/store.js?t=${Date.now()}-cap`
  );
  const workspace = "/tmp/some-workspace-cap";

  const store = new SessionStore(workspace);
  store.start();
  for (let i = 0; i < 50; i++) {
    store.append({ role: "user", content: `message ${i}` });
  }
  const [session] = SessionStore.listSessions(workspace);

  // Exercise the cap directly with a tiny budget rather than growing a real
  // file to the production-sized cap — same code path, far faster.
  const capped = readSessionFileCapped(session.file, 200);
  assert.ok(capped.length <= 200);
  assert.ok(!capped.includes("message 0\n"), "the oldest messages should have been dropped");
  assert.ok(capped.includes("message 49"), "the newest message should still be present");

  // A leading partial line (cut off mid-JSON by the byte boundary) must not
  // be handed to the JSON.parse loop as if it were a whole message.
  for (const line of capped.split("\n").filter((l: string) => l.trim())) {
    assert.doesNotThrow(() => JSON.parse(line), `expected valid JSON, got: ${line}`);
  }
});

test("append caps an oversized string message body before persisting it", async () => {
  await freshHome();
  const { SessionStore } = await import(`../session/store.js?t=${Date.now()}-huge-msg`);
  const workspace = "/tmp/some-workspace-huge-msg";

  const store = new SessionStore(workspace);
  store.start();
  const huge = "x".repeat(10_000_000);
  store.append({ role: "assistant", content: huge });

  const [session] = SessionStore.listSessions(workspace);
  const messages = SessionStore.loadFile(session.file);
  assert.equal(messages.length, 1);
  assert.ok(
    typeof messages[0].content === "string" && messages[0].content.length < huge.length,
    "an oversized message body should have been truncated before it was written to disk"
  );
});

test("isSessionFile rejects a symlink inside the session dir that points outside it", async () => {
  const home = await freshHome();
  const { SessionStore } = await import(`../session/store.js?t=${Date.now()}-10`);
  const workspace = "/tmp/some-workspace-k";

  const store = new SessionStore(workspace);
  store.start();
  store.append({ role: "user", content: "hi" });
  const [session] = SessionStore.listSessions(workspace);
  const dir = path.dirname(session.file);

  const secret = path.join(home, "secret.jsonl");
  await fs.writeFile(secret, JSON.stringify({ role: "user", content: "top secret" }) + "\n");

  const link = path.join(dir, "escape.jsonl");
  await fs.symlink(secret, link);

  assert.equal(SessionStore.isSessionFile(workspace, link), false);
});
