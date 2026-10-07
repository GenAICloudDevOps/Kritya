import assert from "node:assert/strict";
import { test } from "node:test";
import { exitNotice } from "../session/exitNotice.js";
import { shortSessionId } from "../session/store.js";

const FILE = "/home/u/.kritya/sessions/abc/2026-10-06T19-08-39-123Z.jsonl";
const CODE = shortSessionId(FILE);

test("exitNotice points at the session by its short code, not the timestamp filename", () => {
  const text = exitNotice({
    privacyMode: false,
    messageCount: 24,
    file: FILE,
    workspace: "/work/proj",
    cwd: "/work/proj",
    isTTY: false,
  });
  assert.ok(text);
  assert.match(text, /Session saved · 24 messages/);
  assert.match(text, new RegExp(`kritya -r ${CODE}`));
  assert.ok(!text.includes("2026-10-06"), "the long timestamp id must stay hidden");
  assert.ok(text.endsWith("kritya -r"), "the list line stays a bare -r");
  assert.ok(!text.includes("/work/proj"), "no path when that is already the current directory");
});

test("exitNotice says where to run the resume command when it is a different directory", () => {
  const text = exitNotice({
    privacyMode: false,
    messageCount: 2,
    file: FILE,
    workspace: "/work/proj",
    cwd: "/elsewhere",
    isTTY: false,
  });
  assert.ok(text);
  assert.match(text, new RegExp(`kritya -r ${CODE} /work/proj`));
});

test("exitNotice says 'message', not 'messages', for a single-message session", () => {
  const text = exitNotice({
    privacyMode: false,
    messageCount: 1,
    file: FILE,
    workspace: "/w",
    cwd: "/w",
    isTTY: false,
  });
  assert.ok(text);
  assert.match(text, /Session saved · 1 message$/m);
  assert.ok(!text.includes("1 messages"));
});

test("exitNotice stays silent when nothing was written", () => {
  assert.equal(
    exitNotice({
      privacyMode: false,
      messageCount: 0,
      file: FILE,
      workspace: "/w",
      cwd: "/w",
      isTTY: false,
    }),
    null
  );
  // A count with no file on disk means the write failed — no resume to promise.
  assert.equal(
    exitNotice({
      privacyMode: false,
      messageCount: 5,
      file: undefined,
      workspace: "/w",
      cwd: "/w",
      isTTY: false,
    }),
    null
  );
});

test("exitNotice says so in --privacy mode rather than promising a resume", () => {
  const text = exitNotice({
    privacyMode: true,
    messageCount: 0,
    file: undefined,
    workspace: "/w",
    cwd: "/w",
    isTTY: true,
  });
  assert.equal(text, "Session not saved (--privacy).");
});

test("exitNotice dims only when stdout is a terminal", () => {
  const base = { privacyMode: false, messageCount: 3, file: FILE, workspace: "/w", cwd: "/w" };
  const tty = exitNotice({ ...base, isTTY: true });
  assert.ok(tty && tty.includes("\x1b[2m") && tty.includes("\x1b[22m"));

  const piped = exitNotice({ ...base, isTTY: false });
  assert.ok(piped && !piped.includes("\x1b["), "a pipe must not receive escape codes");
});

test("exitNotice shows the auto-derived session name when the session has one", async () => {
  const { default: fs } = await import("node:fs/promises");
  const { default: os } = await import("node:os");
  const { default: path } = await import("node:path");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "kritya-exit-"));
  const file = path.join(dir, "2026-10-06T19-08-39-123Z.jsonl");
  await fs.writeFile(file, "");
  await fs.writeFile(file.replace(/\.jsonl$/, ".name"), "fix-the-login-bug\n");
  const text = exitNotice({
    privacyMode: false,
    messageCount: 3,
    file,
    workspace: "/w",
    cwd: "/w",
    isTTY: false,
  });
  assert.ok(text);
  assert.match(text, /kritya -r fix-the-login-bug/);
});
