# Agent Skills support — design

Date: 2026-07-26 · Status: proposed

## Goal

Add support for the open [Agent Skills](https://agentskills.io) format to
kritya: a project-local `.kritya/skills/` directory of `SKILL.md` folders that
the agent can discover cheaply (name + description only) and load on demand
(full instructions + bundled files) when a task matches. General-purpose
support, not tied to any specific domain (coding, finance, data analysis) —
the domain-specific skills themselves are a separate, later effort.

## Decisions

- **Scope**: kritya-wide feature, project directory only (no user-level
  `~/.kritya/skills/` for now — YAGNI until a cross-project use case shows up).
- **Discovery**: `.kritya/skills/<name>/SKILL.md`, scanned fresh on every
  `load_skill` call (no session-start caching) so skills added mid-session
  work immediately. Cost is a handful of small file reads — not worth trading
  for staleness risk.
- **Frontmatter parsing**: minimal regex-based extraction of all
  `key: value` lines in the leading `---`-delimited block into a generic
  `Record<string, string>`; `name` and `description` are read off that map.
  No YAML dependency — these are flat string fields, so a full YAML parser
  would be a disproportionate dependency. Keeping the rest of the map (even
  though only two fields are used today) means an optional spec field (e.g.
  `license`, `allowed-tools`) can be read later without touching the parser
  again. This has no effect on prompt/token cost — only `name` and
  `description` are ever injected into the system prompt.
- **Discovery roots**: `scanSkills(roots: string[])` takes a list of
  directories to scan, even though it is only ever called with
  `[.kritya/skills]` today. Adding a second root (e.g. a future user-level
  `~/.kritya/skills/`) is then a one-line call-site change, not a rewrite.
- **Activation mechanism**: a dedicated `load_skill` tool (not reuse of
  `read_file`), so skill usage is explicit and trackable rather than an
  implicit convention the model has to infer.
- **Execution**: `load_skill` never executes bundled scripts itself — it only
  lists `scripts/`/`references/`/`assets/` contents. The model runs any
  scripts via the existing `shellTool`, which already goes through kritya's
  permission gate. This keeps `load_skill` a pure read with no new execution
  surface.
- **Telemetry**: no new plumbing. `ToolContext` has no tracer today, and the
  agent loop already wraps every tool call in a `tool.<name>` span with a
  `kritya.summary` attribute from `tool.summarize(args)` — for `load_skill`
  that summary is `Load skill "<name>"`, so per-skill usage is already
  observable through the existing `tool.load_skill` span without adding a
  tracer to `ToolContext` for one tool's sake.

## Architecture

```
src/
├── agent/
│   ├── skills.ts        discovery: scanSkills(roots) scans each root's
│   │                    */SKILL.md, parses frontmatter into a generic
│   │                    Record<string, string>, returns [{name, description,
│   │                    dir, meta}] (called today with roots=[.kritya/skills])
│   └── systemPrompt.ts  +skillsSection(): injects name+description list,
│                        omitted entirely when no skills exist
└── tools/
    └── skills.ts        loadSkillTool: looks up name in discovery result,
                          returns SKILL.md body + bundled-file listing
```

## Key behaviors

- **System prompt injection**: a new section listing `name: description` per
  discovered skill, placed after the existing workflow section and before the
  volatile environment/git-status block (matches the file's existing
  least-to-most-volatile cache ordering). Omitted entirely when
  `.kritya/skills/` is missing or empty, so non-skill projects pay zero
  prompt cost.
- **`SKILL.md` format**:
  ```markdown
  ---
  name: ratio-analysis
  description: Compute standard financial ratios from a balance sheet/income statement
  ---

  <body: full instructions, markdown — kritya does not parse or constrain this>
  ```
  Missing `name` or `description` → skill skipped, one-line stderr warning,
  session continues. Duplicate `name` across folders → first found wins,
  remainder warned and skipped.
- **`load_skill` tool**: input `{ name: string }`. Looks up `name` against the
  _discovered_ list (never builds a path directly from the model-supplied
  string, closing off path-traversal via a hallucinated/malicious name).
  Unknown name → throws `Error("skill \"x\" not found. Available: a, b")`,
  matching the codebase's existing convention (`resolveSafe`, etc.): the
  agent loop's catch path both marks the call `isError` (so headless JSON and
  telemetry reflect the failure correctly) and returns `Error: <message>` to
  the model as the tool result, so it can still self-correct in the next
  round. `requiresPermission: false` (it's a read, like `read_file`).
  Registered in both `ALL_TOOLS` and `READONLY_TOOLS`.

## Testing

- **Unit**: `skills.test.ts` (discovery — valid parse, extra frontmatter
  fields preserved in `meta`, missing required fields, missing/empty
  directory, multiple roots, duplicate names — plus `buildSkillsSection`
  cases for section presence/absence and formatting) and
  `tools/skills.test.ts` (`load_skill` — valid lookup, unknown-name error,
  traversal guard).
- **Integration** (`loop.integration.test.ts` pattern): real `Agent` loop +
  real `loadSkillTool` against real temp workspaces, scripted `ProviderClient`.
  Multiple scenarios, not just the happy path:
  1. Single skill exists, matches the task → `load_skill` call returns body +
     bundled-file listing, loop completes on the following text round.
  2. Model calls `load_skill` with a name that doesn't exist → the thrown
     error surfaces to the model as `Error: skill "x" not found. Available:
...` (the loop's standard catch-path formatting), the call is recorded
     as failed, and the loop continues so the model's next round can react.
  3. Skill has bundled `scripts/` and `references/` → returned listing
     includes both, and a follow-up round where the model reads a referenced
     file via the real `readFileTool` succeeds.
  4. Two skills present, task matches the second one by name → confirms
     lookup isn't order-dependent on discovery.
  5. Workspace has no `.kritya/skills/` directory at all → `load_skill` is
     still registered but its call throws the "no skills available" error
     (`Available: (none)`); loop doesn't crash.
- **E2E** (`headless.e2e.test.ts` pattern): spawn the real built CLI against
  fresh temp `$HOME`/workspace pairs, `startFakeProvider` scripted per case.
  Multiple scenarios:
  1. Happy path: real `.kritya/skills/<name>/SKILL.md` fixture on disk,
     provider script is `[load_skill tool call, text reply]` — assert
     `code === 0`, the JSON output's `toolCalls` contains
     `{name: "load_skill", error: false}`, and `result` matches the scripted
     final text.
  2. Unknown skill name scripted by the fake provider — assert the process
     still exits `0` (tool error surfaced to the model, not a crash), the
     JSON output's `toolCalls` entry for `load_skill` has `error: true`
     (`ToolCallRecord` is `{name, summary, error}` — no raw output field), and
     the model's final `result` (from its next scripted round) reflects it.
  3. No skills directory present at all, provider never calls `load_skill` —
     regression guard that the feature is fully inert (no prompt section, no
     behavior change) for non-skill workspaces.
  4. Skill with a bundled `references/` file — provider script is
     `[load_skill call, read_file call on the referenced file, text reply]`
     (`read_file` needs no permission prompt, unlike `shell`, so the script
     runs unattended) — proves the full discovery → load → follow-up-read
     chain works end-to-end through the real subprocess, not just the load
     step alone.
