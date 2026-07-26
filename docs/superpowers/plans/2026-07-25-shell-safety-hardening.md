# Shell Safety Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close five related shell/permission gaps: an "always allow" scope that's too broad for interpreters, shell commands writing unrestricted outside the workspace, secrets leaking through shell output (foreground and background), a naming collision between the manual read-only toggle and the project workflow's own "plan" phase, and background processes bypassing sandboxing entirely.

**Architecture:** Five independent, self-contained changes. (1) tighten the in-session always-allow key from first-word to full-command in `permissions.ts`. (2) flip the sandbox's default posture from "only sandbox commands `classifyDanger` flags" to "sandbox every command", using the sandbox's existing read-only-outside-workspace bind-mount behavior, with a short list of extra writable cache/global-install directories. (3) add a redaction pass over shell output reusing the existing secret-detection patterns. (4) introduce a brand-new `dryRunMode` flag on `Agent`, fully independent from the existing `planMode` the project workflow already owns — same read-only enforcement shape, separate state, separate audit source, separate UI copy. (5) extend the same sandboxing (from Task 2) and secret redaction (from Task 3) to background processes, which today spawn completely outside both mechanisms.

**Tech Stack:** TypeScript, Node's built-in test runner (`node:test`), Ink (React for terminal UIs) for the CLI UI.

## Global Constraints

- Do not rename, remove, or alter behavior of `agent.planMode`, the `/plan` command, or any file under the project-workflow system (`src/agent/workflow.ts`, `src/commands/registry.ts`'s `runPhase`/`/plan` handling, `src/agent/systemPrompt.ts`'s existing `planMode` parameter). Task 4 adds a **new**, separate `dryRunMode` mechanism instead of touching these.
- Every task must leave `npx tsc --noEmit` clean and all existing tests passing, in addition to its own new tests.
- Windows (`os.platform() === "win32"`) has no sandbox binary. Task 2 must not introduce a per-command warning spam on Windows — Windows keeps today's danger-only sandboxing behavior.
- No new dependencies.

---

## Task 1: Tighten "always allow" to the full command, not just the first word

**Files:**

- Modify: `src/permissions/permissions.ts:17-23` (`alwaysAllowKey`)
- Test: `src/test/safety.test.ts`

**Interfaces:**

- Consumes: nothing new.
- Produces: no signature change — `alwaysAllowKey(toolName, args)` keeps the same signature and is only called internally by `PermissionManager`.

- [ ] **Step 1: Write the failing test**

Add to `src/test/safety.test.ts` (new imports needed: `PermissionManager` is already imported there):

```typescript
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test src/test/safety.test.ts`
Expected: FAIL — `evilArgs` currently returns `false` for `needsPrompt` because `alwaysAllowKey` only looks at the first word (`"python"`), so approving `train.py` silently approves the `-c` invocation too.

- [ ] **Step 3: Write minimal implementation**

Replace `src/permissions/permissions.ts:10-23`:

```typescript
/**
 * Key under which an "always allow" decision is recorded for a tool call.
 * For `shell`, this is scoped to the *exact* command string, so approving
 * one invocation (e.g. `python train.py`) only pre-approves that same
 * invocation again — not every future command starting with the same
 * program (`python -c "..."`, `python other_script.py`). Interpreters and
 * other general-purpose runners make a first-word-only key unsafe: the
 * first word tells you almost nothing about what the full command does.
 * Users who want broader pre-approval on purpose can still write a wildcard
 * rule (e.g. `shell(git *)`) into settings.json — see rules.ts.
 */
function alwaysAllowKey(toolName: string, args: Record<string, unknown>): string {
  if (toolName !== "shell") return toolName;
  const command = String(args.command ?? "").trim();
  return command ? `shell:${command}` : "shell";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test src/test/safety.test.ts`
Expected: PASS — all tests in the file, including the new one.

- [ ] **Step 5: Commit**

```bash
git add src/permissions/permissions.ts src/test/safety.test.ts
git commit -m "security: scope in-session shell always-allow to the exact command"
```

---

## Task 2: Sandbox every shell command by default, with a short exception path list

**Files:**

- Modify: `src/shell/sandbox.ts` (writable-path lists, `shouldSandbox`)
- Modify: `src/test/sandbox.test.ts` (two existing tests assert today's "auto only sandboxes destructive commands" behavior and must be rewritten)

**Interfaces:**

- Consumes: nothing new.
- Produces: `shouldSandbox(mode, command)` keeps its signature `(mode: SandboxMode | undefined, command: string) => boolean` — callers (`src/tools/shell.ts`) are unchanged. `buildSandboxedCommand(command, workspace)` keeps its signature; only the set of writable paths it bind-mounts grows.

### Design

Today, `shouldSandbox` only returns `true` when `classifyDanger(command)` matches. The fix: sandbox **every** command by default on platforms with a sandbox binary (Linux/macOS), independent of `classifyDanger` — `classifyDanger` keeps its separate job of triggering the confirmation-prompt warning in `src/agent/loop.ts:814`, untouched by this task.

To keep everyday commands working (package manager global installs/caches), extend the sandbox's writable binds beyond `workspace` + `/tmp` with a fixed list of common tool-cache directories under `$HOME`:

```
~/.npm
~/.cache
~/.cargo
~/.rustup
~/.gem
```

git push/pull need no exception: they only write inside `.git/` (already inside the workspace) and over the network (already open in the sandbox — see the doc comment on `buildSandboxedCommand`).

Windows never has a sandbox binary (`sandboxTool()` returns `null` on `win32`), so `shouldSandbox` must special-case it: **on Windows, behave exactly as today** (only `classifyDanger`-flagged commands are marked for sandboxing) — since there is no sandbox to apply, marking every command "should be sandboxed" would print the `[sandbox unavailable ...]` fallback note on every single shell call. On Linux/macOS, "auto" now sandboxes everything; "always" is functionally the same as "auto" now (kept as a distinct config value for explicitness/back-compat, still always sandboxes); "off" still disables entirely on every platform.

- [ ] **Step 1: Write the failing tests**

Replace the two now-outdated tests in `src/test/sandbox.test.ts` (`"shouldSandbox: auto only sandboxes destructive commands"` and `"shell tool leaves ordinary commands unsandboxed in auto mode"`) with:

```typescript
test("shouldSandbox: auto sandboxes every command on platforms with a sandbox binary", () => {
  if (os.platform() === "win32") {
    // No sandbox binary exists on Windows — auto must not claim otherwise,
    // or every command would show a spurious "[sandbox unavailable]" note.
    assert.equal(shouldSandbox("auto", "npm test"), false);
    assert.equal(shouldSandbox("auto", "rm -rf /tmp/x"), true); // still flagged via classifyDanger fallback
    return;
  }
  assert.equal(shouldSandbox("auto", "npm test"), true);
  assert.equal(shouldSandbox("auto", "git status"), true);
  assert.equal(shouldSandbox("auto", "rm -rf /tmp/x"), true);
});

test("sandboxed non-destructive command can still write inside the workspace", async () => {
  if (!sandboxAvailable()) return;
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "kritya-sandbox-test-"));
  const ctx: ToolContext = { workspace, sandboxMode: "auto" };
  const out = await shellTool.execute({ command: "echo ok > inside.txt" }, ctx);
  assert.doesNotMatch(out, /sandbox unavailable/);
  assert.ok(await fs.readFile(path.join(workspace, "inside.txt"), "utf8"));
  await fs.rm(workspace, { recursive: true, force: true });
});

test("sandbox allows writes to known package-manager cache dirs outside the workspace", async () => {
  if (!sandboxAvailable() || os.platform() === "win32") return;
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const cacheDir = path.join(os.homedir(), ".npm");
  await fs.mkdir(cacheDir, { recursive: true });
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "kritya-sandbox-test-"));
  const ctx: ToolContext = { workspace, sandboxMode: "auto" };
  const target = path.join(cacheDir, `kritya-sandbox-cache-test-${Date.now()}.txt`);
  try {
    const out = await shellTool.execute({ command: `echo ok > "${target}"` }, ctx);
    assert.doesNotMatch(out, /sandbox unavailable/);
    assert.ok(await fs.readFile(target, "utf8"));
  } finally {
    await fs.rm(target, { force: true });
    await fs.rm(workspace, { recursive: true, force: true });
  }
});
```

Leave the other existing tests in the file (`"shouldSandbox: off never sandboxes"`, `"shouldSandbox: always sandboxes everything"`, `"buildSandboxedCommand returns null when unavailable..."`, `"shell tool sandboxes destructive commands in auto mode..."`, `"sandboxed command can write inside the workspace but is blocked outside it"`) as-is — they remain correct under the new behavior.

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `npx tsx --test src/test/sandbox.test.ts`
Expected: FAIL on the new `"shouldSandbox: auto sandboxes every command..."` test (non-Windows) since `shouldSandbox("auto", "npm test")` currently returns `false`. The cache-dir test also fails since `~/.npm` isn't in the writable bind list yet.

- [ ] **Step 3: Write minimal implementation**

In `src/shell/sandbox.ts`, add the extra writable paths and rewrite `shouldSandbox`:

```typescript
/**
 * Common tool-cache / global-install directories outside the workspace that
 * legitimate commands need to write to (package manager caches, toolchain
 * installs) even though sandboxing now applies to every command by default.
 * Kept short and explicit rather than trying to infer "safe" paths.
 */
function extraWritablePaths(): string[] {
  const home = os.homedir();
  return [".npm", ".cache", ".cargo", ".rustup", ".gem"].map((d) => path.join(home, d));
}
```

Update `macSandboxProfile` to also allow these paths:

```typescript
function macSandboxProfile(workspace: string): string {
  const esc = (p: string) => p.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const extra = extraWritablePaths()
    .map((p) => `(allow file-write* (subpath "${esc(p)}"))`)
    .join("\n");
  return `(version 1)
(allow default)
(deny file-write* (subpath "/"))
(allow file-write* (subpath "${esc(workspace)}"))
(allow file-write* (subpath "/tmp"))
(allow file-write* (subpath "/private/tmp"))
(allow file-write* (subpath "/private/var/folders"))
${extra}
`;
}
```

Update the `bwrap` branch of `buildSandboxedCommand` to bind each extra path read-write (only if it exists, so a fresh machine without e.g. `~/.cargo` doesn't error on a missing bind source):

```typescript
if (tool === "bwrap") {
  const args = ["--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp"];
  for (const p of extraWritablePaths()) {
    if (fs.existsSync(p)) args.push("--bind", p, p);
  }
  args.push(
    "--bind",
    workspace,
    workspace,
    "--chdir",
    workspace,
    "--unshare-pid",
    "--die-with-parent",
    "sh",
    "-c",
    command
  );
  return { cmd: "bwrap", args };
}
```

(macOS's `sandbox-exec` profile allows-by-subpath even for a directory that doesn't exist yet, so no existence check is needed there — the profile lines above are fine unconditionally.)

Rewrite `shouldSandbox`:

```typescript
/** Whether `command` should run sandboxed under the given mode. */
export function shouldSandbox(mode: SandboxMode | undefined, command: string): boolean {
  if (!mode || mode === "off") return false;
  // "always" means always, on every platform — including Windows, where
  // there's no sandbox binary to back it, so every command falls back to
  // the "[sandbox unavailable]" note. That's deliberate: it's the mode for
  // someone who wants maximum enforcement/visibility even without a real
  // sandbox backing it.
  if (mode === "always") return true;
  // "auto": Windows has no sandbox binary at all — falling back to "only
  // flagged commands" (today's behavior) avoids a spurious fallback note on
  // every single shell call, which "sandbox everything" would otherwise cause.
  if (os.platform() === "win32") return classifyDanger(command) !== null;
  return true;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx tsx --test src/test/sandbox.test.ts`
Expected: PASS — all tests in the file.

- [ ] **Step 5: Run the full suite to check for regressions**

Run: `npx tsc --noEmit && npx tsx --test src/test/*.test.ts`
Expected: PASS. Pay particular attention to any test that runs `shell` with `sandboxMode: "auto"` and asserts no sandbox note — those now need a real filesystem write inside the workspace or an existing cache dir, since "auto" sandboxes unconditionally.

- [ ] **Step 6: Commit**

```bash
git add src/shell/sandbox.ts src/test/sandbox.test.ts
git commit -m "security: sandbox every shell command by default, not just flagged ones"
```

---

## Task 3: Redact secrets from shell command output

**Files:**

- Modify: `src/tools/secretScan.ts` (new exported function `redactSecrets`)
- Modify: `src/tools/shell.ts` (`finish` helper)
- Test: `src/test/safety.test.ts` (or a new `src/test/secretScan.test.ts` if one doesn't already cover this file — check first)

**Interfaces:**

- Consumes: nothing new.
- Produces: `redactSecrets(content: string): { redacted: string; matches: SecretMatch[] }`, exported from `src/tools/secretScan.ts`, reusing the existing `SecretMatch` type already exported there.

- [ ] **Step 1: Check for an existing secretScan test file**

Run: `find src/test -iname "*secret*"`

If none exists, add the new tests to `src/test/safety.test.ts` (it already imports from `../permissions/danger.js` and tests security-adjacent behavior — add a new `import { redactSecrets } from "../tools/secretScan.js";` at the top). If one exists, add tests there instead and adjust the commit step's file list accordingly.

- [ ] **Step 2: Write the failing tests**

```typescript
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
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx tsx --test src/test/safety.test.ts`
Expected: FAIL — `redactSecrets` doesn't exist yet (import error / undefined).

- [ ] **Step 4: Write minimal implementation**

Append to `src/tools/secretScan.ts` (after `formatSecretWarning`):

```typescript
/**
 * Scans `content` the same way `scanForSecrets` does, but instead of
 * blocking, replaces each matched secret with a `[REDACTED: <kind>]`
 * placeholder. Used for shell output, which — unlike a file write — has
 * already happened by the time we see it; redacting the display is the
 * only lever left, so masking rather than throwing is the right shape here.
 */
export function redactSecrets(content: string): { redacted: string; matches: SecretMatch[] } {
  const matches = scanForSecrets(content);
  if (matches.length === 0) return { redacted: content, matches };

  let redacted = content;
  for (const { kind, re } of NAMED_PATTERNS) {
    redacted = redacted.replace(re, () => `[REDACTED: ${kind}]`);
  }
  redacted = redacted.replace(ASSIGNMENT_RE, (full, _label, value) => {
    if (looksLikePlaceholder(value) || shannonEntropy(value) < MIN_ENTROPY) return full;
    return (
      full.slice(0, full.length - value.length - (full.endsWith(value) ? 0 : 1)) + "[REDACTED]"
    );
  });

  return { redacted, matches };
}
```

Note: the `ASSIGNMENT_RE` replace above is deliberately conservative about which part of the match it redacts (only the captured value, not the whole `key=value` — keeping the key visible is useful context and the plan intentionally does not over-engineer this into a byte-precise replacement; if the redaction boundary looks off in step 5's test output, adjust the slice logic then, not before).

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx tsx --test src/test/safety.test.ts`
Expected: PASS. If the assignment-redaction slice arithmetic produces a wrong boundary, fix it here (this is exactly the kind of detail that's easier to get right by looking at real regex `match`/capture-group output than to predict statically) — re-run until both new tests pass.

- [ ] **Step 6: Wire redaction into the shell tool's output**

Modify `src/tools/shell.ts`. Add the import:

```typescript
import { redactSecrets } from "./secretScan.js";
```

Change the `finish` helper (around line 87-110) to redact the assembled output before resolving:

```typescript
const finish = (
  resolve: (v: string) => void,
  error: { killed?: boolean; code?: number | string | null } | null,
  stdout: string,
  stderr: string,
  note?: string
) => {
  const parts: string[] = [];
  if (note) parts.push(note);
  if (stdout) parts.push(stdout.trimEnd());
  if (stderr) parts.push(`[stderr]\n${stderr.trimEnd()}`);
  if (error) {
    if (signal?.aborted) {
      parts.push("[command cancelled by user]");
    } else if (error.killed) {
      parts.push(
        `[command timed out after ${timeoutS}s — for servers/watchers use background:true]`
      );
    } else {
      parts.push(`[exit code: ${error.code ?? "unknown"}]`);
    }
  }
  const joined = parts.join("\n") || "(no output)";
  const { redacted, matches } = redactSecrets(joined);
  const withNote =
    matches.length > 0
      ? `[${matches.length} secret(s) redacted from output: ${matches.map((m) => m.kind).join(", ")}]\n${redacted}`
      : redacted;
  resolve(truncateTail(withNote));
};
```

- [ ] **Step 7: Write a shell-tool-level test**

Add to `src/test/sandbox.test.ts` (it already imports `shellTool` and `ToolContext`) or `src/test/safety.test.ts`:

```typescript
test("shell tool redacts secrets from command output", async () => {
  const os = await import("node:os");
  const ctx: ToolContext = { workspace: os.tmpdir(), sandboxMode: "off" };
  const out = await shellTool.execute({ command: "echo AKIAABCDEFGHIJKLMNOP" }, ctx);
  assert.doesNotMatch(out, /AKIAABCDEFGHIJKLMNOP/);
  assert.match(out, /secret\(s\) redacted/);
});
```

(If added to `sandbox.test.ts`, the `os` import is already at the top level — use that instead of a dynamic import.)

- [ ] **Step 8: Run the full suite**

Run: `npx tsc --noEmit && npx tsx --test src/test/*.test.ts`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/tools/secretScan.ts src/tools/shell.ts src/test/safety.test.ts src/test/sandbox.test.ts
git commit -m "security: redact secrets from shell command output"
```

---

## Task 4: Add an independent `dryRunMode` (Shift+Tab manual toggle), separate from the workflow's `planMode`

**Files:**

- Modify: `src/agent/loop.ts` (new `dryRunMode` field + gate)
- Modify: `src/agent/systemPrompt.ts` (`buildSystemPrompt` gets a second, independent parameter)
- Modify: `src/audit/audit.ts` (new `PermissionSource` value)
- Modify: `src/ui/useAgent.ts` (new state, `cycleMode`/`onAcceptEditsConfirm` updated to use it instead of `planMode`)
- Modify: `src/ui/App.tsx` (statusline tag, confirm-mode dialog copy)
- Modify: `src/commands/registry.ts` (help text line only — NOT the `/plan` command or `runPhase`)
- Test: `src/test/loop.test.ts` (or wherever `Agent.planMode` gating is currently tested — check first), `src/test/useAgent.test.tsx`

**Interfaces:**

- Consumes: nothing from Tasks 1-3.
- Produces: `Agent.dryRunMode: boolean` (new field on the `Agent` class, alongside but independent of the existing `planMode`). `buildSystemPrompt(workspace: string, planMode = false, dryRunMode = false): string`.

### Design recap

`agent.planMode` stays **exactly as it is today** — owned entirely by the project workflow (`workflow.ts`, `registry.ts`'s `runPhase` and `/plan` command). This task adds a **second, independent** boolean, `agent.dryRunMode`, driven only by the Shift+Tab manual cycle. Both flags block mutating tools independently; if both happen to be true at once (e.g. user manually toggles dry-run while a workflow's plan phase is also active), either one blocks — no special interaction logic needed since they're just two independent gates checked in sequence.

- [ ] **Step 1: Find existing tests for the planMode tool-gate, to model the new test on them**

Run: `grep -rn "planMode" src/test/loop.test.ts src/test/loop.integration.test.ts`

Read whichever file has the existing "planMode blocks mutating tools" test — use its exact setup pattern (how it constructs an `Agent`, what tool call it drives through `runTurn`) as the template for Step 2's test, so the new test matches existing conventions in this file rather than inventing a new pattern.

- [ ] **Step 2: Write the failing test for the loop-level gate**

Add a test to whichever file Step 1 identified, following that file's existing `Agent` construction pattern, asserting:

```typescript
test("dryRunMode blocks mutating tools independently of planMode", async () => {
  // Construct the Agent exactly as the neighboring planMode test does in
  // this file (same client/model/tools/ctx/permissions/session setup).
  // Then:
  agent.dryRunMode = true;
  agent.planMode = false; // explicitly confirm this is NOT the workflow flag
  // Drive a write_file (or edit_file) tool call through the same path the
  // neighboring planMode test uses, and assert it's blocked with output
  // matching /dry-run mode/i — mirroring the existing assertion shape for
  // the /plan mode/i blocked-output test in this file.
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx tsx --test <the file from Step 1>`
Expected: FAIL — `agent.dryRunMode` doesn't exist yet (TypeScript will actually fail to compile this test file first; that compile failure counts as the expected failure here).

- [ ] **Step 4: Add the field and gate in `loop.ts`**

Add the field near `planMode` (`src/agent/loop.ts`, in the same block as line 99):

```typescript
/** When true, mutating tools are auto-denied (plan / read-only mode). */
planMode = false;
/**
 * When true, mutating tools are auto-denied — the manual Shift+Tab
 * read-only toggle. Independent of `planMode`, which the project
 * workflow's own PLAN phase owns; the two are separate gates that can be
 * on at the same time, each blocking on its own.
 */
dryRunMode = false;
```

Add the gate right after the existing `planMode` block (`src/agent/loop.ts:779-803`), before the deny-rule check:

```typescript
if (this.dryRunMode && tool.requiresPermission) {
  this.audit?.logPermission({ tool: name, summary, verdict: "denied", source: "dry-run-mode" });
  logToolOutcome("blocked");
  finishSpan("ERROR", "blocked: dry-run mode");
  handlers.onToolEnd(id, name, summary, "blocked: dry-run mode (read-only)", true);
  return (
    "Dry-run mode is ON (read-only). This mutating action was blocked. " +
    "Keep exploring with read-only tools and present a concrete plan to the user. " +
    "Do not attempt writes or shell commands until dry-run mode is turned off."
  );
}
```

Update the `buildSystemPrompt` call (`src/agent/loop.ts:464`):

```typescript
      content: buildSystemPrompt(this.ctx.workspace, this.planMode, this.dryRunMode),
```

- [ ] **Step 5: Add the `dry-run-mode` audit source**

In `src/audit/audit.ts`, extend the union (near the existing `"plan-mode"` entry):

```typescript
  | "plan-mode" // blocked because plan mode is on (read-only)
  | "dry-run-mode" // blocked because the manual dry-run toggle is on (read-only)
```

- [ ] **Step 6: Add the independent system-prompt section**

In `src/agent/systemPrompt.ts`, change the signature and add a second, independent section:

```typescript
export function buildSystemPrompt(workspace: string, planMode = false, dryRunMode = false): string {
  const planSection = planMode
    ? "\n# PLAN MODE (read-only)\nYou are in plan mode. Do NOT write, edit, or run shell commands — those are blocked. " +
      "Investigate with read-only tools and present a concrete, step-by-step plan for the user to approve. " +
      "The user will turn off plan mode when they want you to execute.\n"
    : "";
  const dryRunSection = dryRunMode
    ? "\n# DRY-RUN MODE (read-only)\nYou are in dry-run mode. Do NOT write, edit, or run shell commands — those are blocked. " +
      "Investigate with read-only tools and present a concrete, step-by-step plan for the user to approve. " +
      "The user will turn off dry-run mode when they want you to execute.\n"
    : "";
```

Then include `dryRunSection` in the final template-string assembly wherever `planSection` is currently interpolated (read the rest of the function below line 45 first — the exact interpolation point — and add `dryRunSection` immediately adjacent to `planSection` there, same position in the ordering, since both are equally volatile per-turn state per the file's own prompt-caching ordering rule at the top of the file).

- [ ] **Step 7: Run test to verify it passes**

Run: `npx tsc --noEmit && npx tsx --test <the file from Step 1>`
Expected: PASS.

- [ ] **Step 8: Commit the loop-level gate**

```bash
git add src/agent/loop.ts src/agent/systemPrompt.ts src/audit/audit.ts src/test/loop.test.ts
git commit -m "feat: add independent dry-run-mode gate, separate from the workflow's plan mode"
```

(Adjust the test file name in the `git add` to whichever file Step 1 actually used.)

- [ ] **Step 9: Wire the UI — read `useAgent.ts` around the existing cycle**

Read `src/ui/useAgent.ts:125-215` and `:690-710` fresh (line numbers may have drifted from earlier edits in this session) to confirm the exact current shape of `cycleMode`, `enterAcceptEdits`, `onAcceptEditsConfirm`, and the hook's return object before editing.

- [ ] **Step 10: Add `dryRunMode` state and rewrite `cycleMode`/`onAcceptEditsConfirm` in `useAgent.ts`**

Add a new state declaration next to the existing `planMode`/`acceptEdits` ones:

```typescript
const [dryRunMode, setDryRunMode] = useState(false);
```

Replace `cycleMode` (currently references `planMode`/`agent.planMode`) so it drives `dryRunMode`/`agent.dryRunMode` instead — `agent.planMode` must not appear anywhere in this function after the edit:

```typescript
/** Cycles normal → accept-edits → dry-run → normal. First entry into accept-edits this session pauses on a confirmation instead of switching immediately. */
const cycleMode = () => {
  if (dryRunMode) {
    agent.dryRunMode = false;
    setDryRunMode(false);
    addItem({ kind: "info", text: "Dry-run mode OFF — the agent can make changes again." });
    return;
  }
  if (acceptEdits) {
    agent.acceptEdits = false;
    setAcceptEdits(false);
    agent.dryRunMode = true;
    setDryRunMode(true);
    addItem({
      kind: "info",
      text: "Dry-run mode ON — read-only. The agent will explore and propose a plan; edits and shell are blocked.",
    });
    return;
  }
  if (!hasConfirmedAcceptEdits.current) {
    setPhase("confirmMode");
    return;
  }
  enterAcceptEdits();
};
```

`onAcceptEditsConfirm` and `enterAcceptEdits` are unchanged — they never referenced `planMode`.

In the hook's return object (Step 9's read will show the exact current list — it includes `planMode,` and `acceptEdits, setAcceptEdits,` among others), add `dryRunMode` alongside them **without removing `planMode`** (the workflow/`CommandContext` still needs it):

```typescript
    planMode,
    dryRunMode,
    acceptEdits,
    setAcceptEdits,
```

- [ ] **Step 11: Update `App.tsx`**

Destructure `dryRunMode` from the hook's return value alongside the existing `planMode`/`acceptEdits` destructuring (two call sites found earlier at lines ~242-248 and ~405-406 — read the file fresh to get exact current line numbers before editing, since earlier steps may shift them).

Update the statusline block (originally around line 781):

```typescript
          {dryRunMode ? (
            <Text color="cyan">dry-run · </Text>
          ) : planMode ? (
            <Text color="cyan">plan · </Text>
          ) : acceptEdits ? (
            <Text color="green">accept edits ({autoApprovedCount} auto-approved) · </Text>
          ) : (
            ""
          )}
```

Update the confirm-mode dialog copy (originally around line 672-687) — only the two lines of body text change, the structure and `onDecision`/key-handling stay identical:

```typescript
      {phase === "confirmMode" && (
        <Box flexDirection="column" borderStyle="round" borderColor="green" paddingX={1}>
          <Text bold color="green">
            Switch to accept-edits mode?
          </Text>
          <Text>File writes and edits will auto-approve without asking.</Text>
          <Text dimColor>
            Destructive shell commands (rm -rf, force-push, etc.) always still ask, in every mode.
          </Text>
          <Text dimColor>Shift+Tab again moves to dry-run mode; once more back to normal.</Text>
          <Box marginTop={1}>
            <Text>
              <Text color="green">Yes (y)</Text> · No (n/Esc)
            </Text>
          </Box>
        </Box>
      )}
```

- [ ] **Step 12: Update the help text in `registry.ts`**

In `src/commands/registry.ts`, the `HELP_TEXT` constant (around line 100) — change only this one line, nothing else in the file:

```typescript
Keys: Esc cancels · Tab completes · Shift+Tab cycles normal/accept-edits/dry-run
mode · ↑/↓ recalls history · Ctrl+O toggles full tool output · Ctrl+K is the
kill switch (stops everything until /kill off) · Ctrl+C exits`;
```

Do not touch the `/plan` command's own description (`"project workflow: plan from the spec · /plan on|off toggles plan mode"`) — that line correctly still refers to the workflow's `planMode`, unrelated to this task.

- [ ] **Step 13: Update or add UI tests**

Run: `grep -n "planMode\|cycleMode\|confirmMode" src/test/useAgent.test.tsx`

Read whichever existing test(s) exercise `cycleMode`/the accept-edits confirmation flow. Update any assertion that checks for `"Plan mode ON"` / `"plan mode"` text as a result of the _manual_ Shift+Tab cycle (not the workflow) to expect `"Dry-run mode ON"` instead — since that text now comes from `dryRunMode`, not `planMode`, after this task. Leave any test that exercises the workflow's own `/plan` command or `runPhase` untouched — those still produce `"plan mode"` text and still use `agent.planMode`.

- [ ] **Step 14: Run the full suite**

Run: `npx tsc --noEmit && npm run build && node scripts/run-tests.mjs`
Expected: PASS.

- [ ] **Step 15: Commit the UI wiring**

```bash
git add src/ui/useAgent.ts src/ui/App.tsx src/commands/registry.ts src/test/useAgent.test.tsx
git commit -m "feat: rewire the manual read-only toggle to dry-run mode, distinct from workflow plan mode"
```

---

## Task 5: Sandbox background processes and redact secrets from their output

**Files:**

- Modify: `src/shell/background.ts` (`BackgroundManager.start` takes a sandbox mode, wraps the spawn)
- Modify: `src/tools/shell.ts` (pass `ctx.sandboxMode` into `backgroundManager.start`)
- Modify: `src/tools/bg.ts` (`bgOutputTool.execute` redacts secrets)
- Test: `src/test/bg.test.ts`, `src/test/shell.test.ts`

**Interfaces:**

- Consumes: `shouldSandbox`, `buildSandboxedCommand`, `sandboxUnavailableReason` from `src/shell/sandbox.ts` (already used by Task 2's `shell.ts` code — same functions, same signatures). `redactSecrets` from `src/tools/secretScan.ts` (Task 3).
- Produces: `BackgroundManager.start(command: string, cwd: string, sandboxMode?: SandboxMode): { id: string }` — signature grows by one optional parameter, so every existing call site that omits it (all the tests in `bg.test.ts`) keeps compiling and behaving exactly as before (unsandboxed), since `shouldSandbox(undefined, command)` is `false`.

### Design

Mirror the foreground `shell.ts` pattern (`src/tools/shell.ts:112-138`) inside `background.ts`'s `start()`: if `shouldSandbox(sandboxMode, command)` and a wrapper is available, `spawn` the wrapped `cmd`/`args` instead of the plain `command` string with `shell: true`. Unlike the foreground path, the sandbox wrapper's `cleanup()` (deletes the temp macOS profile file) must run when the **process exits**, not immediately after spawning — the profile file has to stay on disk for the process's whole lifetime.

- [ ] **Step 1: Write the failing tests**

Add to `src/test/bg.test.ts` (new imports needed: `shouldSandbox`, `sandboxAvailable` from `"../shell/sandbox.js"`; `path` and `fs/promises`):

```typescript
import { sandboxAvailable } from "../shell/sandbox.js";

test("background process is sandboxed when sandboxMode requests it and writes outside the workspace are blocked", async () => {
  if (!sandboxAvailable() || os.platform() === "win32") return;
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "kritya-bg-sandbox-test-"));
  const outsideTarget = path.join(os.homedir(), `kritya-bg-sandbox-outside-${Date.now()}.txt`);
  const { id } = backgroundManager.start(
    `echo bad > "${outsideTarget}" ; sleep 1`,
    workspace,
    "always"
  );
  try {
    await new Promise((r) => setTimeout(r, 500));
    await assert.rejects(fs.access(outsideTarget));
  } finally {
    backgroundManager.kill(id);
    await fs.rm(outsideTarget, { force: true });
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("background process without a sandboxMode runs unsandboxed, unchanged from today", async () => {
  const { id } = backgroundManager.start(`node -e "console.log('bg-plain')"`, os.tmpdir());
  await new Promise((r) => setTimeout(r, 500));
  const info = backgroundManager.read(id);
  assert.match(info!.buffer, /bg-plain/);
});
```

Add to `src/test/bg.test.ts` (secret redaction on read):

```typescript
test("bg_output redacts secrets from a background process's captured output", async () => {
  const { id } = backgroundManager.start(
    `node -e "console.log('AKIAABCDEFGHIJKLMNOP')"`,
    os.tmpdir()
  );
  try {
    await new Promise((r) => setTimeout(r, 500));
    const out = await bgOutputTool.execute({ id }, ctx);
    assert.doesNotMatch(out, /AKIAABCDEFGHIJKLMNOP/);
    assert.match(out, /REDACTED/);
  } finally {
    backgroundManager.kill(id);
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx tsx --test src/test/bg.test.ts`
Expected: FAIL — `backgroundManager.start` doesn't accept a third argument yet (the sandboxed-write test will still succeed in writing outside the workspace, since nothing blocks it), and `bg_output`'s output isn't redacted yet.

- [ ] **Step 3: Write minimal implementation — `background.ts`**

Modify `src/shell/background.ts`:

```typescript
import { spawn, type ChildProcess } from "node:child_process";
import os from "node:os";
import { scrubbedShellEnv } from "../config/config.js";
import { buildSandboxedCommand, shouldSandbox, type SandboxMode } from "./sandbox.js";
```

Replace the `start` method:

```typescript
  start(command: string, cwd: string, sandboxMode?: SandboxMode): { id: string } {
    const id = `bg_${++this.counter}`;
    const isWindows = os.platform() === "win32";
    const spawnOpts = {
      cwd,
      env: scrubbedShellEnv(),
      windowsHide: true,
      detached: !isWindows,
    };

    let proc: ChildProcess;
    let cleanup: (() => void) | undefined;
    if (shouldSandbox(sandboxMode, command)) {
      const wrapped = buildSandboxedCommand(command, cwd);
      if (wrapped) {
        proc = spawn(wrapped.cmd, wrapped.args, spawnOpts);
        cleanup = wrapped.cleanup;
      } else {
        // Sandboxing was requested but no sandbox binary is available here —
        // fall back to a plain run, same as the foreground shell tool does.
        proc = spawn(command, { ...spawnOpts, shell: true });
      }
    } else {
      // shell:true lets Node pick the right shell and quoting per OS from a
      // single command string, same as the exec() used by the regular shell
      // tool -- manually building a cmd.exe "/c" args array (the previous
      // approach) mis-parses commands that themselves contain quotes.
      proc = spawn(command, { ...spawnOpts, shell: true });
    }

    const entry: BgProcess = { proc, command, buffer: "", exitCode: null, running: true };

    const append = (chunk: Buffer) => {
      entry.buffer += chunk.toString();
      if (entry.buffer.length > MAX_BUFFER_CHARS) {
        entry.buffer = entry.buffer.slice(-MAX_BUFFER_CHARS);
      }
    };
    proc.stdout?.on("data", append);
    proc.stderr?.on("data", append);
    // "exit" (not "close"): grandchildren may inherit the pipes and keep them
    // open after the direct child dies; exit still fires then.
    proc.on("exit", (code) => {
      entry.running = false;
      entry.exitCode = code;
      proc.stdout?.destroy();
      proc.stderr?.destroy();
      cleanup?.();
    });
    proc.on("error", (err) => {
      entry.running = false;
      entry.buffer += `\n[failed to start: ${err.message}]`;
    });

    this.procs.set(id, entry);
    return { id };
  }
```

(The `detached: !isWindows` / `windowsHide: true` / `cwd` / `env` options are unchanged from today — only pulled into a shared `spawnOpts` object so both the sandboxed and unsandboxed branches use the same base.)

- [ ] **Step 4: Wire `ctx.sandboxMode` through from `shell.ts`**

In `src/tools/shell.ts`, change the background branch (around line 67-72):

```typescript
if (args.background) {
  const { id } = backgroundManager.start(command, ctx.workspace, ctx.sandboxMode);
  return Promise.resolve(
    `Started background process ${id}: ${command}\nUse bg_output {"id":"${id}"} to read its output and bg_kill {"id":"${id}"} to stop it.`
  );
}
```

- [ ] **Step 5: Redact secrets in `bg.ts`**

In `src/tools/bg.ts`, add the import:

```typescript
import { redactSecrets } from "./secretScan.js";
```

Change `bgOutputTool.execute`'s specific-id branch:

```typescript
const info = backgroundManager.read(String(args.id));
if (!info) return Promise.resolve(`Error: no background process "${args.id}"`);
const status = info.running ? "still running" : `exited with code ${info.exitCode}`;
const { redacted, matches } = redactSecrets(info.output || "(no output yet)");
const note =
  matches.length > 0
    ? `[${matches.length} secret(s) redacted from output: ${matches.map((m) => m.kind).join(", ")}]\n`
    : "";
return Promise.resolve(
  `Process ${args.id} (${info.command}) — ${status}\n\n${note}${truncateTail(redacted, 10_000)}`
);
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx tsx --test src/test/bg.test.ts src/test/shell.test.ts`
Expected: PASS — all tests in both files.

- [ ] **Step 7: Run the full suite**

Run: `npx tsc --noEmit && npx tsx --test src/test/*.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/shell/background.ts src/tools/shell.ts src/tools/bg.ts src/test/bg.test.ts
git commit -m "security: sandbox background processes and redact secrets from their output"
```

---

## Final Verification

- [ ] Run the full project test command end to end: `npm test`
- [ ] Run `npx tsc --noEmit` one more time from a clean state to confirm no type errors slipped in across all five tasks.
- [ ] Manually smoke-test in a real session (not just automated tests) per this repo's convention for UI-affecting changes: launch Kritya, confirm Shift+Tab still cycles normal → accept-edits (with the one-time confirmation) → dry-run → normal, confirm the statusline shows `dry-run ·` correctly, and confirm `/plan` (the workflow command) still works and still shows `plan ·` — unaffected by this change.
