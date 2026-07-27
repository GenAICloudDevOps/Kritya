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
- **Frontmatter parsing**: minimal regex-based extraction of `name` and
  `description` from the leading `---`-delimited block. No YAML dependency —
  Skill frontmatter here is two flat string fields, and a full YAML parser
  would be a disproportionate dependency for that.
- **Activation mechanism**: a dedicated `load_skill` tool (not reuse of
  `read_file`), so skill usage is explicit and trackable rather than an
  implicit convention the model has to infer.
- **Execution**: `load_skill` never executes bundled scripts itself — it only
  lists `scripts/`/`references/`/`assets/` contents. The model runs any
  scripts via the existing `shellTool`, which already goes through kritya's
  permission gate. This keeps `load_skill` a pure read with no new execution
  surface.

## Architecture

```
src/
├── agent/
│   ├── skills.ts        discovery: scan .kritya/skills/*/SKILL.md, parse
│   │                    frontmatter, return [{name, description, dir}]
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
  Unknown name → clear error string listing available skills, so the model
  can self-correct instead of the call throwing. `requiresPermission: false`
  (it's a read, like `read_file`). Registered in both `ALL_TOOLS` and
  `READONLY_TOOLS`.

## Testing

- **Unit**: `skills.test.ts` (discovery — valid parse, missing fields,
  missing/empty directory, duplicate names) and `tools/skills.test.ts`
  (`load_skill` — valid lookup, unknown-name error, traversal guard); a
  `systemPrompt` case for section presence/absence and formatting.
- **Integration** (`loop.integration.test.ts` pattern): real `Agent` loop +
  real `loadSkillTool` against a real temp workspace with a `.kritya/skills/`
  fixture, scripted `ProviderClient` (round 1: `load_skill` tool call, round
  2: text reply). Catches discovery→tool→loop wiring bugs unit tests miss.
- **E2E** (`headless.e2e.test.ts` pattern): spawn the real built CLI against a
  fresh temp `$HOME`/workspace with a real skills fixture, `startFakeProvider`
  scripted the same way. Asserts on the JSON output's `toolCalls` and
  `result`, proving the feature works through the actual subprocess
  entrypoint.
