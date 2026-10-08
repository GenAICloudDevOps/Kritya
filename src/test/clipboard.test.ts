import assert from "node:assert/strict";
import os from "node:os";
import { test } from "node:test";
import { copyToClipboard, linuxClipboardCandidates } from "../ui/clipboard.js";

test("linuxClipboardCandidates: Wayland first, then X11 tools", () => {
  // Order matters: a Wayland session is the modern default, and probing
  // wl-copy first means the copy lands on the session the user is actually in
  // rather than an X11 selection nothing reads.
  const cmds = linuxClipboardCandidates().map((c) => c.cmd);
  assert.deepEqual(cmds, ["wl-copy", "xclip", "xsel"]);
  const xclip = linuxClipboardCandidates().find((c) => c.cmd === "xclip")!;
  assert.deepEqual(xclip.args, ["-selection", "clipboard"]);
});

test("copyToClipboard never rejects, whatever the platform", async () => {
  // The contract a keybinding needs: a boolean, never a thrown error — a
  // missing clipboard tool must degrade to "couldn't copy", not crash the TUI.
  const ok = await copyToClipboard("kritya clipboard test");
  assert.equal(typeof ok, "boolean");
});

test("copyToClipboard succeeds on a platform with a built-in clipboard tool", async () => {
  // macOS (pbcopy) and Windows (clip) always have one; Linux depends on the
  // session, so there it may legitimately be false and this asserts nothing.
  if (os.platform() === "linux") return;
  const ok = await copyToClipboard("kritya clipboard test");
  assert.equal(ok, true, `${os.platform()} ships a clipboard command, so copying must succeed`);
});
