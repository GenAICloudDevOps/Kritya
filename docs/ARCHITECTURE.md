# Architecture

kritya is a compact TypeScript codebase — ~21k lines under `src/`, plus ~14k
lines of tests — that implements a terminal coding agent. It streams from an
OpenAI-compatible model, runs a tool-call loop, and renders an Ink/React
terminal UI.

## Entry points

Three front ends share one core. All of them build the same `Agent` over the
same tools, permissions, and trust gates — they differ only in who answers a
permission prompt.

| Entry point       | Front end             | Permission prompts                             |
| ----------------- | --------------------- | ---------------------------------------------- |
| `src/index.tsx`   | Ink terminal UI       | the user, interactively                        |
| `src/headless.ts` | `--prompt`, CI        | never asked — allow rules/`--allow-all` decide |
| `src/engine.ts`   | Electron main process | forwarded to the renderer over IPC             |

## Data flow

```
index.tsx / headless.ts / engine.ts   bootstrap: config, trust, provider, tools, agent
  └─ ui/App.tsx                       Ink UI: input, streaming, permissions, commands
       └─ agent/loop.ts               the tool-call loop (Agent)
            ├─ provider/client.ts       streaming OpenAI-compatible client + retry
            ├─ agent/toolExecutor.ts    per-call gate: kill switch → plan mode →
            │    ├─ permissions/*         allow/deny rules + danger classifier
            │    ├─ hooks/hooks.ts        user shell hooks around tool calls
            │    ├─ audit/audit.ts        hash-chained record of every decision
            │    ├─ telemetry/*           spans + metrics per call
            │    └─ tools/*               read/write/edit/shell/glob/grep/lsp/…
            ├─ trust/trust.ts           workspace trust gate for allow rules + hooks
            ├─ trust/mcpTrust.ts        per-server MCP approval
            ├─ mcp/client.ts            MCP servers exposed as tools
            ├─ plugins/*                plugin-contributed skills/commands/MCP
            ├─ agent/killSwitch.ts      session-wide emergency stop
            ├─ agent/compactor.ts       context summarization
            ├─ agent/memory.ts          durable facts distilled into KRITYA.md
            ├─ agent/budget.ts          session token cap + cost estimation
            └─ session/store.ts         JSONL transcript persistence
```

## Modules

- **`src/index.tsx`** — CLI entry. Parses args, resolves the provider and API
  key, loads `.env`, resolves workspace trust (prompting via `TrustPrompt` if
  needed), discovers plugins, assembles the tool list (built-in + MCP), wires
  the subagent spawner and hooks, and renders the UI.
- **`src/headless.ts`** — the `--prompt` / CI path: same bootstrap with no Ink
  UI and no TTY requirement. Since nothing can answer a prompt, mutating calls
  are denied unless an allow rule or `--allow-all` covers them, destructive
  commands are denied unconditionally, workspace-owned config needs `--trust`,
  and `--timeout` caps the whole run. Returns the `{success, result, error,
toolCalls, usage, durationMs, model}` object that `--output json` prints.
- **`src/engine.ts`** — the embedding contract the Electron app builds against
  (`dist/engine.js`): starts a configured `Agent` for one session without
  assuming a terminal, so the desktop front end reuses the core rather than
  reimplementing it.
- **`src/agent/loop.ts`** — `Agent`. Owns conversation history, runs the
  model→tools→model loop up to `maxSteps`, enforces plan mode, triggers
  auto-compaction at `COMPACT_THRESHOLD` (80% of the context window), and
  holds checkpoints for `/rewind`.
- **`src/agent/toolExecutor.ts`** — the per-tool-call gate the loop delegates
  to, split out of it. Runs each call through the kill switch, plan mode, deny
  rules, the danger classifier, permissions, and `preToolUse`/`postToolUse`
  hooks, then executes it inside a telemetry span and writes the outcome to the
  audit log. Consolidating this in one place is what keeps the ordering of
  those checks identical for the main agent and every subagent.
- **`src/agent/tokens.ts`** — dependency-free token estimation, deliberately
  calibrated to run high, so the loop can decide to compact _before_ a request
  and keep the context meter alive on providers that never report usage.
- **`src/agent/budget.ts`** — session-wide token cap (default 1,000,000) and
  the USD cost estimate behind `/cost`, including the discounted `cachedInput`
  rate for prompt tokens served from a provider cache.
- **`src/agent/memory.ts`** — distills durable, objective project facts out of
  transcript being compacted away and merges them into a `## Learned by kritya`
  section of `KRITYA.md`, deduplicated and capped (20 facts, 200 chars each).
- **`src/agent/contextWarning.ts`** — the one-shot 75% context warning, fired
  only on the transition across the threshold so it doesn't repeat.
- **`src/agent/worktree.ts`** — creates the isolated git worktree/branch a
  write subagent operates in, so its edits and shell commands never touch the
  real working tree.
- **`src/agent/killSwitch.ts`** — `KillSwitch`, the session's emergency stop
  (`Ctrl+K` / `/kill`). A single shared instance is held by the main agent and
  by every subagent it spawns, so one stop halts the whole tree; the loop gates
  turns, tool calls, and compaction on it ahead of every other check.
- **`src/agent/workflow.ts`** — the staged new-project workflow
  (brainstorm → spec → plan → build → review). Owns `PHASE_ORDER`, the
  `.kritya/project.json` state pointer, each phase's prompt and `docs/<name>/`
  artifact, the prerequisite check that stops a phase whose input was never
  written, and the scoped plan-mode exemption that lets the plan phase persist
  its own doc without being able to touch anything else.
- **`src/provider/client.ts`** — `ProviderClient`, a thin wrapper over the
  `openai` SDK for any OpenAI-compatible endpoint. Streams text, reasoning, and
  tool calls; retries transient errors with backoff.
- **`src/provider/switchyardSidecar.ts`** / **`switchyardClient.ts`** — the
  `switchyard` provider. The sidecar module generates a `routes.toml`,
  launches `switchyard-server` (NVIDIA's open-source router, an external
  binary — see `docs/CONFIGURATION.md#nemo-switchyard`) on a free localhost
  port, and waits for it to be ready; `SwitchyardProviderClient` extends
  `ProviderClient` to add a cross-model fallback Switchyard itself doesn't
  have, calling three more curated models directly against NVIDIA if the
  sidecar's own retries are exhausted.
- **`src/config/`** — config file, `.env` loading, built-in provider registry
  (`resolveProvider`), and the model registry with per-model context windows.
  Also `retention.ts` (the 15-day auto-delete of transcripts, audit logs, and
  telemetry) and `winAcl.ts`, which reproduces `0600`/`0700` owner-only
  isolation on NTFS, where POSIX mode bits are a no-op.
- **`src/tools/`** — each tool is a plain object implementing `ToolDef`
  (`name`, `parameters`, `execute`, optional `preview`/`summarize`). `index.ts`
  lists them; `READONLY_TOOLS` is the subset subagents may use. `fuzzyMatch.ts`
  backs the whitespace-tolerant `edit_file`. `common.ts` holds the shared path
  safety layer (`resolveSafe`, workspace confinement incl. symlink escape, and
  the sensitive-filename checks for both file tools and shell commands), and
  `secretScan.ts` the content-based secret detection that blocks a write and
  redacts command output. Beyond the core file/shell/search tools it also
  covers documents (`document.ts` — docx/xlsx/pptx/pdf), notebooks
  (`notebook.ts`), the web (`webSearch.ts`, `fetchUrl.ts`, `deepResearch.ts`),
  LSP (`lsp.ts`), and subagents (`subagent.ts`, `writeAgent.ts`).
- **`src/atomicWrite.ts`** — temp-file-then-rename writes, so an interrupted
  write (crash, kill switch, full disk) can never leave a truncated source
  file behind — a reader sees either the whole old file or the whole new one.
- **`src/shell/`** — `background.ts` (the `background: true` process manager
  behind `bg_output`/`bg_kill`, killed on exit) and `sandbox.ts`, which builds
  the `bwrap`/`sandbox-exec` invocation and owns the `auto`/`always`/`strict`/
  `off` policy, including which modes fail closed. Both foreground and
  background commands go through it.
- **`src/lsp/`** — `registry.ts` maps file extensions to language servers,
  `client.ts` speaks LSP over stdio, and `manager.ts` keeps one client per
  (workspace, server) warm across turns — spawning and indexing is the
  expensive part — respawning a dead server and remembering failed startups
  so a missing binary isn't retried on every call.
- **`src/plugins/`** — Agent Plugins: `discover.ts` scans
  `.kritya/plugins/` and `~/.kritya/plugins/` for `<name>/plugin.json` folders
  (reporting both what loaded and why anything was skipped), and `mcp.ts`
  reads each plugin's `mcp.json`. Plugin skills and commands are fed into the
  existing skill/command roots rather than getting a parallel mechanism.
- **`src/net/urlSafety.ts`** — the single private/loopback/link-local/CGNAT
  host check shared by `fetch_url` and the MCP HTTP transport, so the two SSRF
  chokepoints can't drift apart.
- **`src/git/git.ts`** — small `execFileSync` helpers for branch, status, and
  diff, each failing soft to `null` outside a repo.
- **`src/crash.ts`** — last-resort `uncaughtException`/`unhandledRejection`
  handlers. Without them a crash skips the `exit` event that every cleanup path
  hangs off, orphaning background servers, MCP stdio processes, and LSP
  servers, and leaving the terminal in raw mode.
- **`src/repomap/`** — the `repo_map` tool's engine: `symbols.ts` extracts
  definition signatures per language (regex/heuristic, no LSP or parser dep),
  and `repoMap.ts` walks the workspace, ranks source files by importance, and
  renders a size-bounded structural skeleton so the agent can orient itself in
  a large codebase cheaply.
- **`src/permissions/`** — `PermissionManager` (allow/deny + session "always"),
  `rules.ts` (settings-file rule matching, incl. path globs), and `danger.ts`
  (destructive-command classifier).
- **`src/hooks/hooks.ts`** — loads and runs user `preToolUse`/`postToolUse`/
  `stop` shell hooks.
- **`src/trust/`** — `trust.ts` hashes a workspace's `.kritya/settings.json`
  `allow`/`hooks` content and tracks which hashes have been trusted
  (`~/.kritya/trusted.json`), so an untrusted repo can't self-grant
  permissions or run hooks just by being cloned. `mcpTrust.ts` adds a second,
  narrower gate: workspace trust approves a `.mcp.json` as one blob, but each
  server is separately arbitrary code, so each also gets a first-use
  confirmation fingerprinted on its _declared_ (pre-expansion) config — never
  on expanded env/header values, which may hold live secrets — recorded in
  `~/.kritya/mcp-trusted.json` and revocable via `/mcp trust revoke`.
- **`src/mcp/`** — `client.ts`, a minimal JSON-RPC MCP client wrapping remote
  tools as `ToolDef`s (marked external/untrusted); `transport.ts` holds the
  stdio/HTTP transport plumbing split out of it. Also implements OAuth 2.1
  login for hosted servers, sampling/elicitation/consent, and the Tasks
  extension poll loop.
- **`src/commands/`** — `registry.ts` holds the built-in slash commands and
  dispatch order (built-in → custom → MCP prompt → unknown); `custom.ts` loads
  `*.md` command files from the user-global root, then plugins, then the
  workspace, so the more specific source wins; `mcpCommand.ts` backs `/mcp`.
- **`src/undo/undo.ts`** — per-turn snapshot stack backing `/undo` and `/redo`.
- **`src/session/store.ts`** — append-only JSONL transcripts; powers `-c`/`-r`.
- **`src/agent/skills.ts`** / **`skillsCli.ts`** — discovers `SKILL.md` files
  (project `.kritya/skills/`, user-global `~/.kritya/skills/`, and each
  plugin's `skills/`), parses their frontmatter (incl. quoted values and
  `>`/`|` block scalars), and backs both the `load_skill` tool and the
  standalone `kritya skills` CLI subcommand.
- **`src/audit/audit.ts`** — append-only, hash-chained audit log
  (`~/.kritya/audit/<session>.audit.jsonl`) of every permission decision and
  tool execution; `cli.ts` backs `kritya audit --list/--verify/--show/--summary/--prune`.
- **`src/telemetry/`** — `tracer.ts` (OTel-shaped spans) and `metrics.ts` (a
  `Meter` with counters/histograms) for local file/console tracing, plus
  `otlp.ts`'s encoders for the optional `KRITYA_OTEL_ENDPOINT` export path to
  a real OpenTelemetry Collector.
- **`src/ui/`** — Ink components: `App` (the shell), `PermissionPrompt`,
  `TrustPrompt`, `McpTrustPrompt`, `ElicitationPrompt`, `ModelPicker`,
  `SelectList`, `Markdown`, `Banner`, `Spinner`, `StatusLine`,
  `TranscriptItem`, plus `highlight.ts` for code fences, `mermaid.ts` for
  rendering flowcharts as ASCII trees, and the `useAgent`/`useKillSwitch`/
  `useSessionResume`/`useUsageBudget` hooks that bind the UI to the core.
- **`electron/`** — a separate Electron desktop app wrapping the same
  compiled core (`dist/engine.js`). `main.mjs` runs one agent session per
  window and exposes it to `renderer/` over IPC (validated in
  `src/electron/ipcValidation.ts`); not part of the `src/` build, but depends
  on its output.

## Tool contract

A tool is a `ToolDef` (see `src/types.ts`):

```ts
interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON schema
  requiresPermission: boolean;
  external?: boolean; // output wrapped as untrusted
  summarize(args): string;
  preview?(args, ctx): Promise<string | null>; // diff shown in the prompt
  execute(args, ctx): Promise<string>;
}
```

`ToolContext` carries the workspace root, the undo stack, the task-update
callback, and the subagent spawner.

## Testing

Unit tests live in `src/test/*.test.ts` and run on Node's built-in test runner
after a build (`npm test`); `npm run test:coverage` adds c8. They cover the
tools, path safety and secret scanning, permissions/rules, the danger
classifier, the sandbox, workspace and MCP trust, fuzzy matching, diffing,
undo/redo, the loop and its resilience paths, compaction and budgets, MCP
(incl. OAuth and URL safety), plugins, skills, LSP, telemetry/OTLP encoding,
headless mode, and the Ink components (via `ink-testing-library`, in
`*.test.tsx`). `e2eFakeProvider.ts` backs the end-to-end tests by standing in
for a real model, so the loop can be exercised without network access.
