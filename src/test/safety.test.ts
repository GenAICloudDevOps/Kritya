import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyDanger } from "../permissions/danger.js";
import { PermissionManager } from "../permissions/permissions.js";
import { matchesRule } from "../permissions/rules.js";
import { ALL_TOOLS } from "../tools/index.js";

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

test("path patterns match file tools", () => {
  assert.equal(matchesRule("edit_file(*secret*)", "edit_file", { path: "config/secret.ts" }), true);
  assert.equal(matchesRule("edit_file(*secret*)", "edit_file", { path: "config/app.ts" }), false);
  assert.equal(matchesRule("shell(git *)", "shell", { command: "git status" }), true);
});
