# Architecture

kritya is a small TypeScript codebase (~4k lines) that implements a terminal
coding agent. It streams from an OpenAI-compatible model, runs a tool-call loop,
and renders an Ink/React terminal UI.

## Data flow

```
index.tsx                 bootstrap: config, provider, tools, agent, render
  └─ ui/App.tsx           Ink UI: input, streaming, permissions, commands
       └─ agent/loop.ts   the tool-call loop (Agent)
            ├─ provider/client.ts   streaming OpenAI-compatible client + retry
            ├─ tools/*              read/write/edit/shell/glob/grep/… tools
            ├─ permissions/*        allow/deny rules + danger classifier
            ├─ hooks/hooks.ts       user shell hooks around tool calls
            ├─ trust/trust.ts       workspace trust gate for allow rules + hooks
            ├─ mcp/client.ts        MCP servers exposed as tools
            ├─ agent/killSwitch.ts  session-wide emergency stop
            ├─ agent/compactor.ts   context summarization
            └─ session/store.ts     JSONL transcript persistence
```

## Modules

- **`src/index.tsx`** — CLI entry. Parses args, resolves the provider and API
  key, loads `.env`, resolves workspace trust (prompting via `TrustPrompt` if
  needed), assembles the tool list (built-in + MCP), wires the subagent
  spawner and hooks, and renders the UI.
- **`src/agent/loop.ts`** — `Agent`. Owns conversation history, runs the
  model→tools→model loop up to `maxSteps`, enforces plan mode, permissions,
  deny rules, the danger classifier, and hooks, and triggers auto-compaction.
- **`src/agent/killSwitch.ts`** — `KillSwitch`, the session's emergency stop
  (`Ctrl+K` / `/kill`). A single shared instance is held by the main agent and
  by every subagent it spawns, so one stop halts the whole tree; the loop gates
  turns, tool calls, and compaction on it ahead of every other check.
- **`src/provider/client.ts`** — `ProviderClient`, a thin wrapper over the
  `openai` SDK for any OpenAI-compatible endpoint. Streams text, reasoning, and
  tool calls; retries transient errors with backoff.
- **`src/config/`** — config file, `.env` loading, built-in provider registry
  (`resolveProvider`), and the model registry with per-model context windows.
- **`src/tools/`** — each tool is a plain object implementing `ToolDef`
  (`name`, `parameters`, `execute`, optional `preview`/`summarize`). `index.ts`
  lists them; `READONLY_TOOLS` is the subset subagents may use. `fuzzyMatch.ts`
  backs the whitespace-tolerant `edit_file`.
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
- **`src/trust/trust.ts`** — hashes a workspace's `.kritya/settings.json`
  `allow`/`hooks` content and tracks which hashes have been trusted
  (`~/.kritya/trusted.json`), so an untrusted repo can't self-grant
  permissions or run hooks just by being cloned.
- **`src/mcp/client.ts`** — minimal stdio JSON-RPC MCP client; wraps remote
  tools as `ToolDef`s (marked external/untrusted).
- **`src/commands/custom.ts`** — loads `.kritya/commands/*.md` as slash commands.
- **`src/undo/undo.ts`** — per-turn snapshot stack backing `/undo` and `/redo`.
- **`src/session/store.ts`** — append-only JSONL transcripts; powers `-c`/`-r`.
- **`src/ui/`** — Ink components: `App` (the shell), `PermissionPrompt`,
  `TrustPrompt`, `ModelPicker`, `SelectList`, `Markdown`, `Banner`, `Spinner`,
  plus `highlight.ts` for code fences.

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
after a build (`npm test`). They cover tools, path safety, permissions/rules,
the danger classifier, fuzzy matching, diffing, undo/redo, and workspace trust.
