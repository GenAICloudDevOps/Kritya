# Agent Skills Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add project-local Agent Skills support to kritya — discover `.kritya/skills/*/SKILL.md`, list them cheaply in the system prompt, and let the model load a skill's full instructions on demand via a new `load_skill` tool.

**Architecture:** A discovery module (`src/agent/skills.ts`) scans skill folders and parses minimal frontmatter with a small regex parser (no YAML dependency). `systemPrompt.ts` injects a name+description list built from that module. A new `load_skill` tool (`src/tools/skills.ts`) re-scans on each call, returns a matched skill's full body plus any bundled `scripts/`/`references/`/`assets/` listing, and throws (matching the codebase's existing error convention) when the name doesn't match.

**Tech Stack:** TypeScript/Node (ESM), `node:fs`/`node:path`, `node --test` (via `tsx` for fast iteration, compiled through `tsc` for the full suite).

## Global Constraints

- Skill folders live under `.kritya/skills/<name>/SKILL.md` in the workspace root — project-local only, no user-level directory yet.
- Discovery re-scans on every `load_skill` call — no session-start caching.
- Frontmatter is parsed by a small regex-based parser into `Record<string, string>` — no YAML library.
- `scanSkills` takes `roots: string[]` even though it is only ever called with one root today.
- `load_skill` never executes bundled scripts — it only lists `scripts/`/`references/`/`assets/` contents; the model runs anything via the existing `shellTool`.
- Unknown skill name → `throw new Error(...)`, not a returned string — matches `resolveSafe`'s convention and ensures the agent loop's catch path marks the call `isError` automatically.
- No new tracer/telemetry plumbing — `ToolContext` has no tracer, and the loop's existing automatic `tool.<name>` span (with `kritya.summary` from `tool.summarize(args)`) already gives per-skill visibility.
- System prompt section is omitted entirely (not an empty header) when no skills are discovered.

---

### Task 1: Skill discovery module

**Files:**

- Create: `src/agent/skills.ts`
- Test: `src/test/skills.test.ts`

**Interfaces:**

- Produces:
  - `export interface DiscoveredSkill { name: string; description: string; dir: string; meta: Record<string, string>; }`
  - `export function parseSkillFrontmatter(raw: string): { meta: Record<string, string>; body: string } | null`
  - `export function scanSkills(roots: string[]): DiscoveredSkill[]`
  - `export function skillsDir(workspace: string): string`
  - `export function buildSkillsSection(workspace: string): string`

- [ ] **Step 1: Write the failing tests**

Create `src/test/skills.test.ts`:

```typescript
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  buildSkillsSection,
  parseSkillFrontmatter,
  scanSkills,
  skillsDir,
} from "../agent/skills.js";

function tmpWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "kritya-skills-"));
}

function writeSkill(
  root: string,
  name: string,
  opts: { description?: string; body?: string; extraFrontmatter?: string; skipName?: boolean } = {}
): string {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  const lines = ["---"];
  if (!opts.skipName) lines.push(`name: ${name}`);
  if (opts.description !== undefined) lines.push(`description: ${opts.description}`);
  if (opts.extraFrontmatter) lines.push(opts.extraFrontmatter);
  lines.push("---", "", opts.body ?? `Instructions for ${name}.`);
  fs.writeFileSync(path.join(dir, "SKILL.md"), lines.join("\n"));
  return dir;
}

test("parseSkillFrontmatter extracts meta fields and trims the body", () => {
  const raw = "---\nname: foo\ndescription: does foo things\n---\n\nBody text here.\n";
  const parsed = parseSkillFrontmatter(raw);
  assert.ok(parsed);
  assert.equal(parsed!.meta.name, "foo");
  assert.equal(parsed!.meta.description, "does foo things");
  assert.equal(parsed!.body, "Body text here.");
});

test("parseSkillFrontmatter preserves extra frontmatter fields", () => {
  const raw = "---\nname: foo\ndescription: does foo\nlicense: MIT\n---\nbody\n";
  const parsed = parseSkillFrontmatter(raw);
  assert.equal(parsed!.meta.license, "MIT");
});

test("parseSkillFrontmatter returns null when there is no frontmatter block", () => {
  assert.equal(parseSkillFrontmatter("just a plain markdown file\n"), null);
});

test("scanSkills finds a valid skill", () => {
  const root = tmpWorkspace();
  writeSkill(root, "ratio-analysis", { description: "Compute financial ratios" });
  const found = scanSkills([root]);
  assert.equal(found.length, 1);
  assert.equal(found[0].name, "ratio-analysis");
  assert.equal(found[0].description, "Compute financial ratios");
  assert.equal(found[0].dir, path.join(root, "ratio-analysis"));
});

test("scanSkills skips a folder missing description, with the rest still found", () => {
  const root = tmpWorkspace();
  writeSkill(root, "broken", { skipName: false, description: undefined });
  writeSkill(root, "ok", { description: "fine" });
  const found = scanSkills([root]);
  assert.deepEqual(
    found.map((s) => s.name),
    ["ok"]
  );
});

test("scanSkills skips a folder with no SKILL.md", () => {
  const root = tmpWorkspace();
  fs.mkdirSync(path.join(root, "not-a-skill"), { recursive: true });
  fs.writeFileSync(path.join(root, "not-a-skill", "README.md"), "hi");
  assert.deepEqual(scanSkills([root]), []);
});

test("scanSkills returns [] for a missing root directory", () => {
  assert.deepEqual(scanSkills([path.join(os.tmpdir(), "does-not-exist-" + Date.now())]), []);
});

test("scanSkills scans multiple roots and keeps the first match on a name collision", () => {
  const rootA = tmpWorkspace();
  const rootB = tmpWorkspace();
  writeSkill(rootA, "dup", { description: "from A" });
  writeSkill(rootB, "dup", { description: "from B" });
  const found = scanSkills([rootA, rootB]);
  assert.equal(found.length, 1);
  assert.equal(found[0].description, "from A");
});

test("skillsDir joins the workspace with .kritya/skills", () => {
  assert.equal(skillsDir("/ws"), path.join("/ws", ".kritya", "skills"));
});

test("buildSkillsSection lists discovered skills", () => {
  const ws = tmpWorkspace();
  writeSkill(skillsDir(ws), "ratio-analysis", { description: "Compute financial ratios" });
  const section = buildSkillsSection(ws);
  assert.match(section, /# Available skills/);
  assert.match(section, /ratio-analysis: Compute financial ratios/);
  assert.match(section, /load_skill/);
});

test("buildSkillsSection returns empty string when there are no skills", () => {
  const ws = tmpWorkspace();
  assert.equal(buildSkillsSection(ws), "");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx tsx --test src/test/skills.test.ts`
Expected: FAIL — `Cannot find module '../agent/skills.js'`

- [ ] **Step 3: Implement `src/agent/skills.ts`**

```typescript
import fs from "node:fs";
import path from "node:path";

export interface DiscoveredSkill {
  name: string;
  description: string;
  /** Absolute path to the skill's folder. */
  dir: string;
  /** All frontmatter fields, including name/description, for forward-compatible reads. */
  meta: Record<string, string>;
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;
const KEY_VALUE_RE = /^([A-Za-z0-9_-]+):\s*(.*)$/;

/**
 * Parses a SKILL.md's leading `---`-delimited frontmatter block into a flat
 * key/value map, plus the trimmed body that follows it. Returns null when
 * there is no frontmatter block at all -- a plain markdown file, not a skill.
 */
export function parseSkillFrontmatter(
  raw: string
): { meta: Record<string, string>; body: string } | null {
  const match = FRONTMATTER_RE.exec(raw);
  if (!match) return null;
  const [, frontmatter, body] = match;
  const meta: Record<string, string> = {};
  for (const line of frontmatter.split(/\r?\n/)) {
    const kv = KEY_VALUE_RE.exec(line);
    if (kv) meta[kv[1]] = kv[2].trim();
  }
  return { meta, body: body.trim() };
}

function warn(message: string): void {
  process.stderr.write(`kritya: ${message}\n`);
}

/**
 * Scans each root for `<name>/SKILL.md` folders, in name order. Roots that
 * don't exist are skipped silently -- an unconfigured skills directory is not
 * a warning-worthy condition. A folder without a SKILL.md is not a skill and
 * is skipped without comment; a SKILL.md that IS present but malformed (no
 * frontmatter, or missing name/description) is skipped with a warning, since
 * that's a mistake in the user's own skill file they'd want to know about.
 * On a name collision across or within roots, the first one found wins and
 * the rest are skipped with a warning.
 */
export function scanSkills(roots: string[]): DiscoveredSkill[] {
  const seen = new Map<string, DiscoveredSkill>();
  for (const root of roots) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    const dirs = entries
      .filter((e) => e.isDirectory())
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of dirs) {
      const dir = path.join(root, entry.name);
      const skillFile = path.join(dir, "SKILL.md");
      let raw: string;
      try {
        raw = fs.readFileSync(skillFile, "utf8");
      } catch {
        continue;
      }
      const parsed = parseSkillFrontmatter(raw);
      if (!parsed) {
        warn(`skipping ${skillFile}: missing frontmatter block`);
        continue;
      }
      const { meta } = parsed;
      if (!meta.name || !meta.description) {
        warn(`skipping ${skillFile}: frontmatter must include "name" and "description"`);
        continue;
      }
      const existing = seen.get(meta.name);
      if (existing) {
        warn(
          `skipping ${skillFile}: duplicate skill name "${meta.name}" (already loaded from ${existing.dir})`
        );
        continue;
      }
      seen.set(meta.name, { name: meta.name, description: meta.description, dir, meta });
    }
  }
  return [...seen.values()];
}

export function skillsDir(workspace: string): string {
  return path.join(workspace, ".kritya", "skills");
}

/**
 * The system-prompt fragment listing discovered skills by name+description
 * only (progressive disclosure -- full instructions load via load_skill).
 * Returns "" when there are none, so non-skill workspaces pay zero prompt cost.
 */
export function buildSkillsSection(workspace: string): string {
  const skills = scanSkills([skillsDir(workspace)]);
  if (!skills.length) return "";
  const lines = skills.map((s) => `- ${s.name}: ${s.description}`).join("\n");
  return `\n# Available skills\n${lines}\nCall load_skill with the skill name when a task matches one of these.\n`;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx tsx --test src/test/skills.test.ts`
Expected: PASS (all 11 tests)

- [ ] **Step 5: Commit**

```bash
git add src/agent/skills.ts src/test/skills.test.ts
git commit -m "feat(skills): add skill discovery and system-prompt section"
```

---

### Task 2: Wire the skills section into the system prompt

**Files:**

- Modify: `src/agent/systemPrompt.ts`
- Test: `src/test/skills.test.ts` (extend with a `buildSystemPrompt` integration check)

**Interfaces:**

- Consumes: `buildSkillsSection(workspace: string): string` from Task 1 (`src/agent/skills.js`)
- Produces: no new exports — `buildSystemPrompt`'s existing signature (`buildSystemPrompt(workspace: string, planMode = false, dryRunMode = false): string`) is unchanged, it just includes the skills section in its output now.

- [ ] **Step 1: Write the failing test**

Add `import { buildSystemPrompt } from "../agent/systemPrompt.js";` to the top of `src/test/skills.test.ts`, grouped with its existing imports (not appended later in the file — `eslint --fix` runs on commit and expects imports at the top). Then append these two `test()` blocks at the end of the file:

```typescript
test("buildSystemPrompt includes the skills section when a skill exists", () => {
  const ws = tmpWorkspace();
  writeSkill(skillsDir(ws), "ratio-analysis", { description: "Compute financial ratios" });
  const prompt = buildSystemPrompt(ws);
  assert.match(prompt, /# Available skills/);
  assert.match(prompt, /ratio-analysis: Compute financial ratios/);
});

test("buildSystemPrompt omits the skills section when there are none", () => {
  const ws = tmpWorkspace();
  const prompt = buildSystemPrompt(ws);
  assert.doesNotMatch(prompt, /# Available skills/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsx --test src/test/skills.test.ts`
Expected: FAIL — first assertion fails (`# Available skills` not found in prompt output)

- [ ] **Step 3: Wire it in**

In `src/agent/systemPrompt.ts`, add the import at the top with the other relative imports:

```typescript
import { buildSkillsSection } from "./skills.js";
```

Then insert the call between the memory block and the `# Environment` block (same cache-ordering rationale as the existing comment: skills change about as rarely as project memory, not per-turn). Change:

```typescript
${memory}
# Environment
```

to:

```typescript
${memory}${buildSkillsSection(workspace)}
# Environment
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx tsx --test src/test/skills.test.ts`
Expected: PASS (all 13 tests)

- [ ] **Step 5: Commit**

```bash
git add src/agent/systemPrompt.ts src/test/skills.test.ts
git commit -m "feat(skills): inject available-skills section into system prompt"
```

---

### Task 3: `load_skill` tool

**Files:**

- Create: `src/tools/skills.ts`
- Modify: `src/tools/index.ts`
- Test: `src/test/toolsSkills.test.ts`

**Interfaces:**

- Consumes: `scanSkills`, `skillsDir`, `parseSkillFrontmatter`, `DiscoveredSkill` from `../agent/skills.js` (Task 1); `ToolDef`, `ToolContext` from `../types.js`; `truncateResult` from `./common.js`.
- Produces: `export const loadSkillTool: ToolDef` from `src/tools/skills.ts`, added to `ALL_TOOLS` and `READONLY_TOOLS` in `src/tools/index.ts`.

- [ ] **Step 1: Write the failing tests**

Create `src/test/toolsSkills.test.ts`:

```typescript
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { loadSkillTool } from "../tools/skills.js";
import { skillsDir } from "../agent/skills.js";
import type { ToolContext } from "../types.js";

function tmpWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "kritya-loadskill-"));
}

function writeSkill(
  ws: string,
  name: string,
  opts: { description?: string; body?: string } = {}
): string {
  const dir = path.join(skillsDir(ws), name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${opts.description ?? "a skill"}\n---\n\n${opts.body ?? "Do the thing."}\n`
  );
  return dir;
}

function ctx(workspace: string): ToolContext {
  return { workspace };
}

test("load_skill returns the skill body for a valid name", async () => {
  const ws = tmpWorkspace();
  writeSkill(ws, "ratio-analysis", { body: "Step 1: gather the balance sheet." });
  const output = await loadSkillTool.execute({ name: "ratio-analysis" }, ctx(ws));
  assert.match(output, /Step 1: gather the balance sheet\./);
});

test("load_skill lists bundled scripts/references/assets", async () => {
  const ws = tmpWorkspace();
  const dir = writeSkill(ws, "ratio-analysis");
  fs.mkdirSync(path.join(dir, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(dir, "scripts", "compute.py"), "# compute");
  fs.mkdirSync(path.join(dir, "references"), { recursive: true });
  fs.writeFileSync(path.join(dir, "references", "formulas.md"), "# formulas");
  const output = await loadSkillTool.execute({ name: "ratio-analysis" }, ctx(ws));
  assert.match(output, /scripts\/[\s\S]*compute\.py/);
  assert.match(output, /references\/[\s\S]*formulas\.md/);
});

test("load_skill throws a clear error for an unknown name", async () => {
  const ws = tmpWorkspace();
  writeSkill(ws, "ratio-analysis");
  await assert.rejects(
    () => loadSkillTool.execute({ name: "does-not-exist" }, ctx(ws)),
    /skill "does-not-exist" not found.*ratio-analysis/s
  );
});

test("load_skill throws when no skills exist at all", async () => {
  const ws = tmpWorkspace();
  await assert.rejects(
    () => loadSkillTool.execute({ name: "anything" }, ctx(ws)),
    /skill "anything" not found.*\(none\)/s
  );
});

test("load_skill does not treat the name argument as a path", async () => {
  const ws = tmpWorkspace();
  writeSkill(ws, "ratio-analysis");
  // A hallucinated/malicious name must not escape the lookup-by-discovered-name
  // path and read something outside the skill folders.
  await assert.rejects(
    () => loadSkillTool.execute({ name: "../../etc/passwd" }, ctx(ws)),
    /not found/
  );
});

test("load_skill is registered with requiresPermission: false", () => {
  assert.equal(loadSkillTool.requiresPermission, false);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx tsx --test src/test/toolsSkills.test.ts`
Expected: FAIL — `Cannot find module '../tools/skills.js'`

- [ ] **Step 3: Implement `src/tools/skills.ts`**

```typescript
import fs from "node:fs";
import path from "node:path";
import { parseSkillFrontmatter, scanSkills, skillsDir } from "../agent/skills.js";
import type { ToolDef } from "../types.js";
import { truncateResult } from "./common.js";

const BUNDLE_DIRS = ["scripts", "references", "assets"] as const;

function listBundledFiles(skillDir: string): string {
  const sections: string[] = [];
  for (const sub of BUNDLE_DIRS) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(path.join(skillDir, sub), { withFileTypes: true });
    } catch {
      continue;
    }
    if (!entries.length) continue;
    const names = entries.map((e) => `  ${e.name}${e.isDirectory() ? "/" : ""}`).join("\n");
    sections.push(`${sub}/\n${names}`);
  }
  return sections.join("\n\n");
}

export const loadSkillTool: ToolDef = {
  name: "load_skill",
  description:
    "Load the full instructions for an available skill by name. Call this when a task matches a skill listed in the system prompt.",
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: "The skill's name, as listed in the system prompt" },
    },
    required: ["name"],
  },
  requiresPermission: false,
  summarize: (args) => `Load skill "${args.name}"`,
  async execute(args, ctx) {
    const name = String(args.name ?? "");
    // Re-scan on every call (no session-start caching) so a skill added
    // mid-session is usable immediately -- cheap since these are a handful
    // of small file reads.
    const skills = scanSkills([skillsDir(ctx.workspace)]);
    const skill = skills.find((s) => s.name === name);
    if (!skill) {
      const available = skills.map((s) => s.name).join(", ") || "(none)";
      // Throwing (rather than returning an "Error: ..." string) matches this
      // codebase's convention (see resolveSafe): the agent loop's catch path
      // marks the call failed and formats the message for the model.
      throw new Error(`skill "${name}" not found. Available: ${available}`);
    }
    // skill.dir came from scanSkills' own directory listing, never from the
    // model-supplied `name` -- a hallucinated/malicious name can only fail
    // the lookup above, never build a path.
    const raw = fs.readFileSync(path.join(skill.dir, "SKILL.md"), "utf8");
    const parsed = parseSkillFrontmatter(raw);
    const body = parsed?.body ?? "";
    const bundled = listBundledFiles(skill.dir);
    return truncateResult(bundled ? `${body}\n\n# Bundled files\n${bundled}` : body);
  },
};
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx tsx --test src/test/toolsSkills.test.ts`
Expected: PASS (all 6 tests)

- [ ] **Step 5: Register the tool**

In `src/tools/index.ts`, add the import:

```typescript
import { loadSkillTool } from "./skills.js";
```

Add `loadSkillTool` to both `ALL_TOOLS` and `READONLY_TOOLS` arrays (it's a pure read, like `readFileTool`):

```typescript
export const ALL_TOOLS: ToolDef[] = [
  readFileTool,
  writeFileTool,
  editFileTool,
  shellTool,
  bgOutputTool,
  bgKillTool,
  listDirTool,
  globTool,
  grepTool,
  repoMapTool,
  lspDefinitionTool,
  lspReferencesTool,
  lspDiagnosticsTool,
  lspHoverTool,
  lspRenameTool,
  updateTasksTool,
  webSearchTool,
  fetchUrlTool,
  deepResearchTool,
  spawnAgentTool,
  spawnWriteAgentTool,
  readDocumentTool,
  writeDocumentTool,
  editSpreadsheetTool,
  editPdfTool,
  readNotebookTool,
  editNotebookTool,
  loadSkillTool,
];

/** Read-only tools a subagent is allowed to use (no writes, edits, or shell). */
export const READONLY_TOOLS: ToolDef[] = [
  readFileTool,
  listDirTool,
  globTool,
  grepTool,
  repoMapTool,
  lspDefinitionTool,
  lspReferencesTool,
  lspDiagnosticsTool,
  lspHoverTool,
  readDocumentTool,
  readNotebookTool,
  loadSkillTool,
];
```

- [ ] **Step 6: Run the full unit test file set to check nothing else broke**

Run: `npx tsx --test src/test/skills.test.ts src/test/toolsSkills.test.ts`
Expected: PASS (all tests from both files)

- [ ] **Step 7: Commit**

```bash
git add src/tools/skills.ts src/tools/index.ts src/test/toolsSkills.test.ts
git commit -m "feat(skills): add load_skill tool and register it"
```

---

### Task 4: Integration tests — real Agent loop + real tool, scripted provider

**Files:**

- Create: `src/test/loop.skills.integration.test.ts`

**Interfaces:**

- Consumes: `Agent` from `../agent/loop.js`; `loadSkillTool` from `../tools/skills.js`; `readFileTool` from `../tools/read.js`; `PermissionManager` from `../permissions/permissions.js`; `SessionStore` from `../session/store.js`; `skillsDir` from `../agent/skills.js`; `AgentHandlers`, `ChatMessage`, `PermissionDecision`, `ToolDef`, `ToolContext` from `../types.js`; `ChatResult`, `ParsedToolCall`, `ProviderClient` (type-only) from `../provider/client.js`. The `scriptedClient`/`toolRound`/`textRound`/`assistantToolCallMsg`/`makeHandlers` helpers mirror `src/test/loop.integration.test.ts` but are duplicated locally rather than imported across test files, matching that file's own self-contained style.
- Produces: no new exports — this is a test-only file.

This task writes five scenarios in one file since they share the same setup helpers; each is its own `test()` block and independently reviewable/runnable.

- [ ] **Step 1: Write the test file**

Create `src/test/loop.skills.integration.test.ts`. Model the harness directly on `src/test/loop.integration.test.ts` (read it first if anything below is unclear — same `Agent` construction, same scripted-client pattern):

```typescript
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Agent } from "../agent/loop.js";
import { skillsDir } from "../agent/skills.js";
import { loadSkillTool } from "../tools/skills.js";
import { readFileTool } from "../tools/read.js";
import type { ChatResult, ParsedToolCall, ProviderClient } from "../provider/client.js";
import { PermissionManager } from "../permissions/permissions.js";
import { SessionStore } from "../session/store.js";
import type {
  AgentHandlers,
  ChatMessage,
  PermissionDecision,
  ToolDef,
  ToolContext,
} from "../types.js";

// Same helpers as src/test/loop.integration.test.ts -- duplicated locally
// rather than imported across test files, matching this suite's existing
// convention of self-contained test files.
function scriptedClient(rounds: ChatResult[]): { client: ProviderClient; callCount: () => number } {
  let i = 0;
  const client = {
    chat: async (): Promise<ChatResult> => {
      if (i >= rounds.length)
        throw new Error(`unexpected chat() call #${i + 1} -- only ${rounds.length} scripted`);
      return rounds[i++];
    },
  } as unknown as ProviderClient;
  return { client, callCount: () => i };
}

function assistantToolCallMsg(calls: ParsedToolCall[]): ChatMessage {
  return {
    role: "assistant",
    content: null,
    tool_calls: calls.map((c) => ({
      id: c.id,
      type: "function" as const,
      function: { name: c.name, arguments: c.argsJson },
    })),
  };
}

function toolRound(calls: ParsedToolCall[]): ChatResult {
  return {
    message: assistantToolCallMsg(calls),
    text: "",
    toolCalls: calls,
    usage: { promptTokens: 100, completionTokens: 10 },
  };
}

function textRound(text: string): ChatResult {
  return {
    message: { role: "assistant", content: text },
    text,
    toolCalls: [],
    usage: { promptTokens: 100, completionTokens: 10 },
  };
}

interface HandlerLog {
  texts: string[];
  toolEnds: { name: string; isError: boolean }[];
  handlers: AgentHandlers;
}

function makeHandlers(): HandlerLog {
  const log: HandlerLog = {
    texts: [],
    toolEnds: [],
    handlers: {
      onTextDelta() {},
      onReasoningDelta() {},
      onAssistantText(text) {
        log.texts.push(text);
      },
      onToolStart() {},
      onToolEnd(_id, name, _summary, _preview, isError) {
        log.toolEnds.push({ name, isError });
      },
      async requestPermission(): Promise<PermissionDecision> {
        return "yes";
      },
      onUsage() {},
    },
  };
  return log;
}

function makeAgent(workspace: string, client: ProviderClient, tools: ToolDef[]): Agent {
  const ctx: ToolContext = { workspace };
  return new Agent(
    client,
    () => "test-model",
    tools,
    ctx,
    new PermissionManager(),
    new SessionStore(workspace, true) // ephemeral: true, no disk writes in tests
  );
}

function loadSkillCall(name: string, id = "call_1"): ParsedToolCall {
  return { id, name: "load_skill", argsJson: JSON.stringify({ name }) };
}

function tmpWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "kritya-skills-loop-"));
}

function writeSkill(
  ws: string,
  name: string,
  opts: { description?: string; body?: string } = {}
): string {
  const dir = path.join(skillsDir(ws), name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${opts.description ?? "a skill"}\n---\n\n${opts.body ?? "Do the thing."}\n`
  );
  return dir;
}

test("load_skill returns the skill body and the loop completes", async () => {
  const ws = tmpWorkspace();
  writeSkill(ws, "ratio-analysis", {
    body: "Compute current ratio = current assets / current liabilities.",
  });
  const { client } = scriptedClient([
    toolRound([loadSkillCall("ratio-analysis")]),
    textRound("Loaded the ratio-analysis skill and applied it."),
  ]);
  const agent = makeAgent(ws, client, [loadSkillTool, readFileTool]);
  const log = makeHandlers();
  await agent.runTurn("analyze the ratios", log.handlers);
  assert.equal(log.texts.at(-1), "Loaded the ratio-analysis skill and applied it.");
  assert.deepEqual(log.toolEnds, [{ name: "load_skill", isError: false }]);
});

test("load_skill with an unknown name surfaces an error the loop can continue from", async () => {
  const ws = tmpWorkspace();
  writeSkill(ws, "ratio-analysis");
  const { client } = scriptedClient([
    toolRound([loadSkillCall("does-not-exist")]),
    textRound("That skill doesn't exist, so I'll proceed without it."),
  ]);
  const agent = makeAgent(ws, client, [loadSkillTool, readFileTool]);
  const log = makeHandlers();
  await agent.runTurn("use the fictional skill", log.handlers);
  assert.equal(log.texts.at(-1), "That skill doesn't exist, so I'll proceed without it.");
  assert.deepEqual(log.toolEnds, [{ name: "load_skill", isError: true }]);
  // The model still sees a usable error message for the next round, not a
  // raw stack trace.
  const toolMsg = agent.history.find((m) => m.role === "tool") as { content: string } | undefined;
  assert.match(toolMsg!.content, /skill "does-not-exist" not found.*ratio-analysis/s);
});

test("load_skill surfaces bundled scripts/references, and a follow-up read_file succeeds", async () => {
  const ws = tmpWorkspace();
  const dir = writeSkill(ws, "ratio-analysis");
  fs.mkdirSync(path.join(dir, "references"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "references", "formulas.md"),
    "current_ratio = assets / liabilities"
  );
  fs.mkdirSync(path.join(dir, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(dir, "scripts", "compute.py"), "# compute");

  const { client } = scriptedClient([
    toolRound([loadSkillCall("ratio-analysis")]),
    toolRound([
      {
        id: "call_2",
        name: "read_file",
        argsJson: JSON.stringify({ path: ".kritya/skills/ratio-analysis/references/formulas.md" }),
      },
    ]),
    textRound("Used the formula from the referenced file."),
  ]);
  const agent = makeAgent(ws, client, [loadSkillTool, readFileTool]);
  const log = makeHandlers();
  await agent.runTurn("compute the ratio", log.handlers);
  assert.equal(log.texts.at(-1), "Used the formula from the referenced file.");
  assert.deepEqual(
    log.toolEnds.map((e) => e.name),
    ["load_skill", "read_file"]
  );
  const firstToolMsg = agent.history[2] as { content: string };
  assert.match(firstToolMsg.content, /scripts\/[\s\S]*compute\.py/);
  assert.match(firstToolMsg.content, /references\/[\s\S]*formulas\.md/);
});

test("looking up the second of two skills by name is not order-dependent", async () => {
  const ws = tmpWorkspace();
  writeSkill(ws, "aaa-first", { body: "first skill body" });
  writeSkill(ws, "zzz-second", { body: "second skill body" });
  const { client } = scriptedClient([
    toolRound([loadSkillCall("zzz-second")]),
    textRound("Loaded zzz-second."),
  ]);
  const agent = makeAgent(ws, client, [loadSkillTool, readFileTool]);
  const log = makeHandlers();
  await agent.runTurn("use zzz-second", log.handlers);
  assert.equal(log.texts.at(-1), "Loaded zzz-second.");
  const toolMsg = agent.history[2] as { content: string };
  assert.match(toolMsg.content, /second skill body/);
});

test("load_skill in a workspace with no skills directory throws a clean 'none available' error", async () => {
  const ws = tmpWorkspace(); // no .kritya/skills at all
  const { client } = scriptedClient([
    toolRound([loadSkillCall("anything")]),
    textRound("No skills are configured here."),
  ]);
  const agent = makeAgent(ws, client, [loadSkillTool, readFileTool]);
  const log = makeHandlers();
  await agent.runTurn("use a skill", log.handlers);
  assert.equal(log.texts.at(-1), "No skills are configured here.");
  const toolMsg = agent.history[2] as { content: string };
  assert.match(toolMsg.content, /not found.*\(none\)/s);
});
```

- [ ] **Step 2: Run it to verify it compiles and passes**

Run: `npx tsx --test src/test/loop.skills.integration.test.ts`
Expected: PASS (all 5 tests). The harness above already matches the real `Agent` constructor (`client, () => model, tools, ctx, permissions, session`), the fact that `runTurn` returns `void` and reports its result through `handlers.onAssistantText`/`onToolEnd` (not a return value), and `agent.history`'s message ordering (`user, assistant, tool, assistant, tool, ...`) — all verified against `src/agent/loop.ts` and `src/test/loop.integration.test.ts` directly.

- [ ] **Step 3: Commit**

```bash
git add src/test/loop.skills.integration.test.ts
git commit -m "test(skills): add integration coverage for load_skill through the real agent loop"
```

---

### Task 5: E2E tests — real built CLI + fake HTTP provider

**Files:**

- Modify: `src/test/headless.e2e.test.ts`

**Interfaces:**

- Consumes: `startFakeProvider`, `ScriptedTurn` from `./e2eFakeProvider.js` (existing); `freshHome`, `freshWorkspace`, `runKritya` helpers already defined in `headless.e2e.test.ts` (reuse in place, don't redefine).
- Produces: no new exports — new `test()` blocks appended to the existing file.

This depends on Tasks 1-3 being merged already, since e2e tests run the compiled `dist/index.js` — by this point `load_skill` is implemented and working, so these are characterization/coverage tests proving the feature end-to-end through the real subprocess, not red-green TDD.

- [ ] **Step 1: Write the tests**

Append to `src/test/headless.e2e.test.ts` (add `path`/`fs` skill-fixture helpers near the top, alongside `freshWorkspace`, and the new `test()` blocks at the end of the file):

```typescript
async function writeSkillFixture(
  workspace: string,
  name: string,
  opts: { description?: string; body?: string } = {}
): Promise<string> {
  const dir = path.join(workspace, ".kritya", "skills", name);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${opts.description ?? "a skill"}\n---\n\n${opts.body ?? "Do the thing."}\n`
  );
  return dir;
}

test("load_skill happy path: skill is loaded and reflected in the result", async () => {
  const script: ScriptedTurn[] = [
    { type: "toolCall", name: "load_skill", argsJson: JSON.stringify({ name: "ratio-analysis" }) },
    { type: "text", text: "Applied the ratio-analysis skill." },
  ];
  const provider = await startFakeProvider(script);
  try {
    const home = await freshHome(provider.url);
    const workspace = await freshWorkspace();
    await writeSkillFixture(workspace, "ratio-analysis", {
      body: "current ratio = assets / liabilities",
    });
    const { code, stdout } = await runKritya(home, workspace, ["--prompt", "analyze the ratios"]);
    assert.equal(code, 0);
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.success, true);
    assert.equal(parsed.result, "Applied the ratio-analysis skill.");
    assert.deepEqual(
      parsed.toolCalls.map((t: { name: string; error: boolean }) => ({
        name: t.name,
        error: t.error,
      })),
      [{ name: "load_skill", error: false }]
    );
  } finally {
    await provider.close();
  }
});

test("load_skill with an unknown name reports a failed tool call but still completes", async () => {
  const script: ScriptedTurn[] = [
    { type: "toolCall", name: "load_skill", argsJson: JSON.stringify({ name: "does-not-exist" }) },
    { type: "text", text: "That skill isn't available." },
  ];
  const provider = await startFakeProvider(script);
  try {
    const home = await freshHome(provider.url);
    const workspace = await freshWorkspace();
    await writeSkillFixture(workspace, "ratio-analysis");
    const { code, stdout } = await runKritya(home, workspace, [
      "--prompt",
      "use the fictional skill",
    ]);
    assert.equal(code, 0);
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.success, true);
    assert.equal(parsed.result, "That skill isn't available.");
    assert.deepEqual(
      parsed.toolCalls.map((t: { name: string; error: boolean }) => ({
        name: t.name,
        error: t.error,
      })),
      [{ name: "load_skill", error: true }]
    );
  } finally {
    await provider.close();
  }
});

test("a workspace with no skills directory is unaffected by the feature", async () => {
  const script: ScriptedTurn[] = [{ type: "text", text: "the answer is 42" }];
  const provider = await startFakeProvider(script);
  try {
    const home = await freshHome(provider.url);
    const workspace = await freshWorkspace(); // no .kritya/skills at all
    const { code, stdout } = await runKritya(home, workspace, ["--prompt", "what is the answer?"]);
    assert.equal(code, 0);
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.success, true);
    assert.equal(parsed.result, "the answer is 42");
    assert.equal(parsed.toolCalls.length, 0);
  } finally {
    await provider.close();
  }
});

test("load_skill followed by reading a bundled reference file works end to end", async () => {
  const script: ScriptedTurn[] = [
    { type: "toolCall", name: "load_skill", argsJson: JSON.stringify({ name: "ratio-analysis" }) },
    {
      type: "toolCall",
      name: "read_file",
      argsJson: JSON.stringify({ path: ".kritya/skills/ratio-analysis/references/formulas.md" }),
    },
    { type: "text", text: "Used the referenced formula." },
  ];
  const provider = await startFakeProvider(script);
  try {
    const home = await freshHome(provider.url);
    const workspace = await freshWorkspace();
    const dir = await writeSkillFixture(workspace, "ratio-analysis");
    await fs.mkdir(path.join(dir, "references"), { recursive: true });
    await fs.writeFile(
      path.join(dir, "references", "formulas.md"),
      "current_ratio = assets / liabilities"
    );
    const { code, stdout } = await runKritya(home, workspace, ["--prompt", "compute the ratio"]);
    assert.equal(code, 0);
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.success, true);
    assert.equal(parsed.result, "Used the referenced formula.");
    assert.deepEqual(
      parsed.toolCalls.map((t: { name: string; error: boolean }) => t.name),
      ["load_skill", "read_file"]
    );
  } finally {
    await provider.close();
  }
});
```

- [ ] **Step 2: Build, then run the new tests against the compiled CLI**

Run: `npm run build && node --test dist/test/headless.e2e.test.js`
Expected: PASS (all tests in the file — the pre-existing ones plus the 4 new ones). If any fails, check the actual JSON shape by adding a temporary `console.error(stdout)` in the failing test, run again, then remove it once fixed.

- [ ] **Step 3: Run the full suite to confirm no regressions**

Run: `npm test`
Expected: all tests pass, including every pre-existing test file.

- [ ] **Step 4: Commit**

```bash
git add src/test/headless.e2e.test.ts
git commit -m "test(skills): add e2e coverage for load_skill through the real CLI subprocess"
```
