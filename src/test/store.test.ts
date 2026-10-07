import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { SessionMeta } from "../session/store.js";

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

test("shortSessionId is a stable 5-char code that differs per transcript", async () => {
  await freshHome();
  const { SessionStore, shortSessionId } = await import(
    `../session/store.js?t=${Date.now()}-shortid`
  );
  const workspace = "/tmp/some-workspace-shortid";

  const store = new SessionStore(workspace);
  store.start();
  store.append({ role: "user", content: "hi" });
  const [session] = SessionStore.listSessions(workspace);

  const code = shortSessionId(session.file);
  assert.match(code, /^[0-9a-z]{5}$/);
  assert.equal(shortSessionId(session.file), code, "deriving it twice must not drift");
  assert.equal(session.shortId, code, "listSessions must expose the same code");

  // The long timestamp id is untouched — it is still the audit/telemetry key.
  assert.notEqual(code, session.file);
  assert.ok(path.basename(session.file).startsWith("20"), "the file keeps its timestamp name");
});

test("resolveSession finds a session by full code, unique prefix, or full timestamp id", async () => {
  await freshHome();
  const { SessionStore } = await import(`../session/store.js?t=${Date.now()}-resolve`);
  const workspace = "/tmp/some-workspace-resolve";

  const store = new SessionStore(workspace);
  store.start();
  store.append({ role: "user", content: "hello there" });
  const [session] = SessionStore.listSessions(workspace);

  assert.deepEqual(SessionStore.resolveSession(workspace, session.shortId), { file: session.file });
  assert.deepEqual(SessionStore.resolveSession(workspace, session.shortId.slice(0, 3)), {
    file: session.file,
  });
  assert.deepEqual(SessionStore.resolveSession(workspace, path.basename(session.file, ".jsonl")), {
    file: session.file,
  });
  // Case and surrounding whitespace are the user's problem to not have.
  assert.deepEqual(SessionStore.resolveSession(workspace, `  ${session.shortId.toUpperCase()} `), {
    file: session.file,
  });
});

test("resolveSession explains a miss, an empty query, and an empty directory instead of guessing", async () => {
  await freshHome();
  const { SessionStore } = await import(`../session/store.js?t=${Date.now()}-resolve-miss`);
  const workspace = "/tmp/some-workspace-resolve-miss";

  const noDir = SessionStore.resolveSession(workspace, "zzzzz");
  assert.ok("error" in noDir && /No saved sessions/.test(noDir.error));

  const store = new SessionStore(workspace);
  store.start();
  store.append({ role: "user", content: "hi" });

  const miss = SessionStore.resolveSession(workspace, "zzzzz");
  assert.ok("error" in miss && /No session matching/.test(miss.error));

  const blank = SessionStore.resolveSession(workspace, "   ");
  assert.ok("error" in blank && /No session name/.test(blank.error));
});

test("resolveSession refuses an ambiguous prefix rather than opening the wrong conversation", async () => {
  await freshHome();
  const { SessionStore } = await import(`../session/store.js?t=${Date.now()}-resolve-amb`);
  const workspace = "/tmp/some-workspace-resolve-amb";

  const first = new SessionStore(workspace);
  first.start();
  first.append({ role: "user", content: "first" });
  // Distinct millisecond, or both stores would claim the same timestamp filename.
  await new Promise((resolve) => setTimeout(resolve, 5));
  const second = new SessionStore(workspace);
  second.start();
  second.append({ role: "user", content: "second" });

  assert.equal(SessionStore.listSessions(workspace).length, 2);

  // Every transcript basename starts with the year, so "20" matches both.
  const result = SessionStore.resolveSession(workspace, "20");
  assert.ok("error" in result, "an ambiguous prefix must not silently pick one");
  assert.match(result.error, /matches 2 sessions/);
});

test("messageCount tracks what is really on disk, through rewind and /clear", async () => {
  await freshHome();
  const { SessionStore } = await import(`../session/store.js?t=${Date.now()}-count`);
  const workspace = "/tmp/some-workspace-count";

  const store = new SessionStore(workspace);
  assert.equal(store.messageCount, 0, "nothing written yet");
  store.start();
  assert.equal(store.messageCount, 0);

  store.append({ role: "user", content: "one" });
  store.append({ role: "assistant", content: "two" });
  assert.equal(store.messageCount, 2);

  store.overwrite([{ role: "user", content: "one" }]);
  assert.equal(store.messageCount, 1, "/rewind must rewind the count too");

  store.rotate();
  assert.equal(store.messageCount, 0, "/clear starts a new file at zero");
});

test("messageCount includes resumed history and stays 0 for an ephemeral (--privacy) store", async () => {
  await freshHome();
  const { SessionStore } = await import(`../session/store.js?t=${Date.now()}-count-seed`);
  const workspace = "/tmp/some-workspace-count-seed";

  const store = new SessionStore(workspace);
  store.start([
    { role: "user", content: "a" },
    { role: "assistant", content: "b" },
  ]);
  assert.equal(store.messageCount, 2, "a resumed seed is already on disk");

  const ephemeral = new SessionStore(workspace, true);
  ephemeral.start([{ role: "user", content: "a" }]);
  ephemeral.append({ role: "assistant", content: "b" });
  assert.equal(ephemeral.messageCount, 0, "privacy mode persists nothing to count");
  assert.equal(ephemeral.path, undefined);
});

test("slugifySessionName turns a first message into a typeable slug", async () => {
  const { slugifySessionName } = await import(`../session/store.js?t=${Date.now()}-slug`);
  assert.equal(slugifySessionName("Fix the login bug!!"), "fix-the-login-bug");
  assert.equal(slugifySessionName("  /init  "), "init");
  assert.equal(slugifySessionName("a".repeat(100)), "a".repeat(40));
  assert.equal(slugifySessionName("!!!"), "");
  assert.equal(slugifySessionName(""), "");
});

test("append names the session from the first real user message, then never renames", async () => {
  await freshHome();
  const { SessionStore } = await import(`../session/store.js?t=${Date.now()}-name`);
  const workspace = "/tmp/some-workspace-name";

  const store = new SessionStore(workspace);
  store.start();
  store.append({ role: "user", content: "[undo] reverted 1 file" }); // synthetic note: skipped
  store.append({ role: "assistant", content: "ok" }); // not a user message: skipped
  assert.equal(SessionStore.listSessions(workspace)[0].name, "", "no name yet");

  store.append({ role: "user", content: "Fix the login bug" });
  const [session] = SessionStore.listSessions(workspace);
  assert.equal(session.name, "fix-the-login-bug");
  assert.equal(SessionStore.displayName(session.file), "fix-the-login-bug");

  store.append({ role: "user", content: "Also update the docs" });
  assert.equal(
    SessionStore.listSessions(workspace)[0].name,
    "fix-the-login-bug",
    "a later message must not rename the session"
  );
});

test("the name comes from text parts when the first message carries images", async () => {
  await freshHome();
  const { SessionStore } = await import(`../session/store.js?t=${Date.now()}-nameimg`);
  const workspace = "/tmp/some-workspace-nameimg";

  const store = new SessionStore(workspace);
  store.start();
  store.append({
    role: "user",
    content: [
      { type: "text", text: "Describe this screenshot" },
      { type: "image_url", image_url: { url: "data:image/png;base64,xx" } },
    ],
  });
  assert.equal(SessionStore.listSessions(workspace)[0].name, "describe-this-screenshot");
});

test("displayName falls back to the short code for an unnamed session", async () => {
  await freshHome();
  const { SessionStore, shortSessionId } = await import(
    `../session/store.js?t=${Date.now()}-noname`
  );
  const workspace = "/tmp/some-workspace-noname";

  const store = new SessionStore(workspace);
  store.start();
  store.append({ role: "assistant", content: "hello" });
  const [session] = SessionStore.listSessions(workspace);
  assert.equal(session.name, "");
  assert.equal(SessionStore.displayName(session.file), shortSessionId(session.file));
});

test("resolveSession finds a session by its auto-derived name", async () => {
  await freshHome();
  const { SessionStore } = await import(`../session/store.js?t=${Date.now()}-resolvename`);
  const workspace = "/tmp/some-workspace-resolvename";

  const store = new SessionStore(workspace);
  store.start();
  store.append({ role: "user", content: "Fix the login bug" });
  const [session] = SessionStore.listSessions(workspace);

  assert.deepEqual(SessionStore.resolveSession(workspace, "fix-the-login-bug"), {
    file: session.file,
  });
  assert.deepEqual(SessionStore.resolveSession(workspace, "fix-the-login"), {
    file: session.file,
  });
  assert.deepEqual(SessionStore.resolveSession(workspace, "FIX-THE-LOGIN-BUG"), {
    file: session.file,
  });
});

test("resolveSession reports ambiguity when two sessions share a name", async () => {
  await freshHome();
  const { SessionStore } = await import(`../session/store.js?t=${Date.now()}-nameamb`);
  const workspace = "/tmp/some-workspace-nameamb";

  const first = new SessionStore(workspace);
  first.start();
  first.append({ role: "user", content: "Fix the login bug" });
  await new Promise((resolve) => setTimeout(resolve, 5));
  const second = new SessionStore(workspace);
  second.start();
  second.append({ role: "user", content: "Fix the login bug" });

  const result = SessionStore.resolveSession(workspace, "fix-the-login-bug");
  assert.ok("error" in result, "a shared name must not silently pick one");
  assert.match(result.error, /matches 2 sessions/);
});

test("rotate() lets the new session earn its own name (/clear)", async () => {
  await freshHome();
  const { SessionStore } = await import(`../session/store.js?t=${Date.now()}-rotatename`);
  const workspace = "/tmp/some-workspace-rotatename";

  const store = new SessionStore(workspace);
  store.start();
  store.append({ role: "user", content: "Fix the login bug" });
  await new Promise((resolve) => setTimeout(resolve, 5));
  store.rotate();
  store.append({ role: "user", content: "Write the release notes" });

  const names = SessionStore.listSessions(workspace)
    .map((s: SessionMeta) => s.name)
    .sort();
  assert.deepEqual(names, ["fix-the-login-bug", "write-the-release-notes"]);
});

test("cleanupOldSessions removes the name sidecar with the transcript", async () => {
  await freshHome();
  const { SessionStore } = await import(`../session/store.js?t=${Date.now()}-cleanupname`);
  const workspace = "/tmp/some-workspace-cleanupname";

  const store = new SessionStore(workspace);
  store.start();
  store.append({ role: "user", content: "Fix the login bug" });
  const [session] = SessionStore.listSessions(workspace);
  assert.equal(session.name, "fix-the-login-bug");

  // Age the transcript 60 days; the sidecar follows the transcript.
  const old = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
  await fs.utimes(session.file, old, old);
  SessionStore.cleanupOldSessions(30);

  assert.equal(SessionStore.listSessions(workspace).length, 0);
  // path.dirname, not a "/"-anchored regex: on Windows the transcript path is
  // backslash-separated, so stripping "[^/]+$" would eat the whole string and
  // leave "" — which readdir then rejects with ENOENT.
  const dir = path.dirname(session.file);
  const leftovers = (await fs.readdir(dir)).filter((f) => f.endsWith(".name"));
  assert.equal(leftovers.length, 0, "no orphaned .name sidecars");
});

test("setName overrides the auto-derived name and slugifies the input", async () => {
  await freshHome();
  const { SessionStore } = await import(`../session/store.js?t=${Date.now()}-setname`);
  const workspace = "/tmp/some-workspace-setname";

  const store = new SessionStore(workspace);
  store.start();
  store.append({ role: "user", content: "Fix the login bug" });
  assert.equal(SessionStore.listSessions(workspace)[0].name, "fix-the-login-bug");

  const slug = store.setName("Actually it's the signup flow!!");
  assert.equal(slug, "actually-it-s-the-signup-flow");
  assert.equal(SessionStore.listSessions(workspace)[0].name, "actually-it-s-the-signup-flow");
  assert.equal(store.displayName, "actually-it-s-the-signup-flow");

  // Renaming twice keeps the latest; -r resolves the new name.
  store.setName("signup flow");
  const [session] = SessionStore.listSessions(workspace);
  assert.equal(session.name, "signup-flow");
  assert.deepEqual(SessionStore.resolveSession(workspace, "signup-flow"), {
    file: session.file,
  });
});

test("setName returns undefined when nothing usable remains, keeping the old name", async () => {
  await freshHome();
  const { SessionStore } = await import(`../session/store.js?t=${Date.now()}-setname-junk`);
  const workspace = "/tmp/some-workspace-setname-junk";

  const store = new SessionStore(workspace);
  store.start();
  store.append({ role: "user", content: "Fix the login bug" });

  assert.equal(store.setName("!!!"), undefined);
  assert.equal(
    SessionStore.listSessions(workspace)[0].name,
    "fix-the-login-bug",
    "a junk rename must not clobber the existing name"
  );
});

test("setName is a no-op for ephemeral (--privacy) sessions", async () => {
  await freshHome();
  const { SessionStore } = await import(`../session/store.js?t=${Date.now()}-setname-eph`);
  const workspace = "/tmp/some-workspace-setname-eph";

  const store = new SessionStore(workspace, true);
  store.start();
  store.append({ role: "user", content: "Fix the login bug" });
  assert.equal(store.setName("renamed"), undefined);
  assert.equal(SessionStore.listSessions(workspace).length, 0, "nothing persisted");
});
