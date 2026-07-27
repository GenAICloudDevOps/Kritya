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
- **Telemetry**: `load_skill` opens a `skill.load` span (same
  `NOOP_TRACER`/`Tracer` pattern already used for `llm.chat` in
  `provider/client.ts`) with a `kritya.skill_name` attribute, so which skills
  actually get used is observable without adding instrumentation later.

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
                          returns SKILL.md body + bundled-file listing,
                          wraps execution in a skill.load trace span
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
  Unknown name → clear error string listing available skills, so the model
  can self-correct instead of the call throwing. `requiresPermission: false`
  (it's a read, like `read_file`). Registered in both `ALL_TOOLS` and
  `READONLY_TOOLS`.

## Testing

- **Unit**: `skills.test.ts` (discovery — valid parse, extra frontmatter
  fields preserved in `meta`, missing required fields, missing/empty
  directory, multiple roots, duplicate names) and `tools/skills.test.ts`
  (`load_skill` — valid lookup, unknown-name error, traversal guard, span
  recorded with `kritya.skill_name`); a `systemPrompt` case for section
  presence/absence and formatting.
- **Integration** (`loop.integration.test.ts` pattern): real `Agent` loop +
  real `loadSkillTool` against a real temp workspace with a `.kritya/skills/`
  fixture, scripted `ProviderClient` (round 1: `load_skill` tool call, round
  2: text reply). Catches discovery→tool→loop wiring bugs unit tests miss.
- **E2E** (`headless.e2e.test.ts` pattern): spawn the real built CLI against a
  fresh temp `$HOME`/workspace with a real skills fixture, `startFakeProvider`
  scripted the same way. Asserts on the JSON output's `toolCalls` and
  `result`, proving the feature works through the actual subprocess
  entrypoint.
