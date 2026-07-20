# Changelog

All notable changes to kritya are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- **Cross-platform CI verification**: CI now runs the full test suite on
  Windows and macOS runners (in addition to Ubuntu 18.x/20.x/22.x), not just
  Linux, so the "works on Windows and macOS" claim is actually checked rather
  than assumed. This surfaced two real bugs the expanded matrix caught:
  - `npm test` passed a glob (`dist/test/*.test.js`) to `node --test`. Node's
    own CLI glob matching only exists on Node 22+, so on Node 18/20 (used by
    macOS/Windows in CI and still within `engines.node`) it was treated as a
    literal, nonexistent path and failed outright. Fixed with
    `scripts/run-tests.mjs`, which enumerates compiled test files with
    `fs.readdirSync` and passes them to `node --test` as explicit paths —
    verified against Node 18, 20, and 22.
  - `prettier --check .` flagged nearly every file on Windows, because
    GitHub's Windows runners check out git text files as CRLF by default,
    which Prettier (LF) then sees as unformatted. Fixed by adding
    `.gitattributes` (`* text=auto eol=lf`) so checkout normalizes to LF on
    every OS.

### Added

- **Mid-session provider failover**: a new `/provider` command lists every
  configured provider and lets you switch (`/provider openai`) without losing
  the conversation — only the underlying HTTP client is swapped, history and
  undo state are untouched. When a request exhausts its retries (429/5xx with
  exponential backoff, already automatic), kritya now surfaces this as a
  distinct error and suggests a configured fallback provider; headless mode
  does the same via `--provider`.

- **Session crash-safety**: the task-checklist sidecar and a resumed
  session's seed file are now written atomically (tmp-file + rename), so a
  crash mid-write can't corrupt them. Append-per-turn session files already
  degrade gracefully (a truncated last line is skipped, not the whole
  session) — now documented and covered by tests.

- **Prompt-caching awareness**: the system prompt is reordered for cache
  stability — stable content first (identity, tool rules, style), then
  project memory (KRITYA.md), with volatile sections (environment, workspace
  listing, git status, plan mode) last, so a changed git status no longer
  invalidates the provider's cached prefix for the whole prompt. The provider
  client now reads `prompt_tokens_details.cached_tokens`; `/cost` reports
  cached tokens and hit rate per model, the statusline shows the session
  cache-hit percentage, and headless `--output json` includes
  `usage.cachedPromptTokens`. An optional `pricing.<model>.cachedInput` rate
  (USD/1M) prices cache hits at the discounted rate and reports the savings.

- **LSP integration**: three new read-only tools — `lsp_definition`,
  `lsp_references`, and `lsp_diagnostics` — give the agent semantic code
  navigation and type-error feedback from real language servers
  (TypeScript/JavaScript via `typescript-language-server`, Python via
  `pyright`, Go via `gopls`, Rust via `rust-analyzer`, C/C++ via `clangd`).
  The client is a dependency-free JSON-RPC-over-stdio implementation; servers
  are detected per file type, spawned on first use, kept warm across turns,
  respawned if they crash, and reported with an install hint when missing.
  Queries wait for the server's initial project indexing (via
  `workDoneProgress`) so cross-file results are never silently incomplete.

## [0.4.0] — 2026-07-17

### Security

- **Workspace trust gate**: a cloned repo's `.kritya/settings.json` could
  otherwise self-grant allow rules or run hooks the moment `kritya .`
  launches there. Workspace-level allow rules and hooks now require explicit
  trust (prompted on first launch, hash-pinned in `~/.kritya/trusted.json`)
  before taking effect; deny rules and the global `~/.kritya/settings.json`
  are unaffected.
- **Sandbox escape via symlinks fixed**: `resolveSafe` now resolves symlinks
  (and the nearest existing ancestor, for not-yet-created files) before
  checking containment, closing a path where a symlink inside the workspace
  pointing outside it let `edit_file`/`write_file`/`read_file` escape the
  sandbox.
- **Secret-path denylist**: reads and writes of likely-secret paths
  (`.env*`, `.git/config`, `*credentials*`, `*secret*`, private keys) are now
  blocked inside `resolveSafe`, regardless of allowlist rules, closing a gap
  where a prompt-injected agent could read `.env` and exfiltrate it via shell
  or web search.
- **Destructive-command detection hardened**: `classifyDanger` now also
  catches long-form flags (`rm --recursive --force`, `git clean --force`,
  `chmod --recursive 777`, `chown --recursive`), not just short-form
  clusters like `-rf`. Documented in `SECURITY.md` that this remains a
  regex-based backstop, not a hard guarantee — `$(...)`/`eval`/base64
  obfuscation can still evade it.

### Added

- **`.krityaignore`**: gitignore-style patterns in the workspace root are now
  honored by `glob`, `grep`, and the `@`-file-mention list, in addition to the
  hardcoded `node_modules`/`.git` exclusion.
- **Diff-aware shell permission prompts**: the `shell` tool now previews a
  `git diff --stat` (plus the capped diff) before permission is granted for
  commands that mutate git state (`checkout`, `reset`, `commit`, `merge`,
  `rebase`, `stash`, `clean`, `rm`, `mv`, `restore`, `add`, etc.), matching
  the diff preview already shown for file edits.
- **GitHub Actions CI**: build, lint, format:check, and test now run on
  Node 18.x/20.x for every pull request targeting `main`.

### Changed

- Auto-compaction no longer stalls at 0% context usage when a provider omits
  usage stats on streamed responses; falls back to a size-based token
  estimate. Reasoning deltas are now read from both `reasoning_content`
  (NVIDIA/DeepSeek) and `reasoning` (OpenRouter and others). Sampling params
  (`temperature`, `top_p`, `max_tokens`) are now overridable — or omittable
  via `null` — per provider in config, instead of hardcoded.
- The version string is now read from `package.json` at runtime instead of
  being hardcoded separately in the CLI banner and the MCP client handshake.
- `listSessions` no longer JSON-parses every message in a transcript just to
  build a resume preview; it stops at the first real user message and counts
  lines cheaply instead.
- Fixed `web_search`'s `max_results: 0` being silently treated as "omitted"
  and defaulting to 5.
- Internal: slash-command dispatch extracted from `App.tsx` into a typed
  command registry (`src/commands/registry.ts`), and agent-turn state
  (transcript, streaming, permissions, cost, resume) extracted into a
  `useAgent` hook, so both are unit-testable independent of the UI.
- Internal: added test coverage for `ProviderClient.chatOnce`'s streaming
  tool-call assembly (multi-chunk arguments, out-of-order chunk indices,
  usage presence), fixed pre-existing prettier violations, made the test
  runner's file glob shell-expanded for Node 18.x CI compatibility, and
  added a `test:watch` script (via `tsx`, no compile step) for faster local
  iteration.

### Removed

- Dropped legacy compatibility shims kept during the code-cli → kritya
  rename: the `NvidiaClient` export alias, the `CODECLI.md` project-memory
  fallback (use `KRITYA.md`), and the `~/.code-cli/config.json` legacy config
  path (use `~/.kritya/config.json`).
- Removed dead code (`resolveApiKey`, `loadAllowRules`) superseded by
  `resolveProvider` and `loadRules`.

## [0.3.0] — 2026-07-17

### Added

- **Multi-provider support.** Any OpenAI-compatible endpoint works: NVIDIA
  (default), OpenAI, OpenRouter, Groq, DeepSeek, Mistral, Together, and Ollama
  are built in. Select with `--provider` or `provider` in config; add your own
  under `providers`.
- **Plan mode** (`/plan`): a read-only mode where the agent investigates and
  proposes a plan; writes, edits, and shell are blocked until you turn it off.
- **Subagents** (`spawn_agent` tool): dispatch a focused, read-only
  investigation to a fresh context that returns only its findings, keeping the
  main conversation lean.
- **Hooks**: user-defined shell commands that run on `preToolUse` (can block),
  `postToolUse`, and `stop` events, configured in `settings.json`.
- **MCP client**: launch Model Context Protocol servers over stdio and expose
  their tools to the agent (`mcpServers` in config).
- **Custom slash commands**: drop a markdown file in `.kritya/commands/` and it
  becomes a `/command`.
- **Redo** (`/redo`) to reapply an undone change; undo is now multi-level.
- **Image attachments**: `@screenshot.png` sends an image to vision-capable
  models.
- **`/diff`** shows the cumulative git diff of the session's changes.
- **Deny rules** and path-glob rules in `settings.json` (e.g.
  `deny: ["write_file(.env*)"]`); deny always wins over allow.
- **Destructive-command guard**: commands like `rm -rf`, `git push --force`,
  and `curl | sh` always prompt with a warning, even when allowlisted.
- **Input history** (↑/↓), a **verbose output toggle** (Ctrl+O), an
  **elapsed-time** and **plan-mode** indicator in the status line, and a
  **terminal bell** when input is needed or a turn finishes.
- **Word-level diff highlighting** in the permission preview.

### Changed

- Retries on transient provider errors (429/5xx) now use exponential backoff
  with a visible status note.
- `edit_file` falls back to whitespace-tolerant line matching when an exact
  match isn't found, reducing failed edits from weaker models.
- Auto-compaction uses the model's real context window from a registry.
- The per-request step limit is configurable (`maxSteps`) and stops gracefully.
- The provider client is now provider-agnostic (`ProviderClient`).

## [0.2.0]

- Initial public feature set: streaming tool-call loop, permissions with
  allowlists, sessions and resume, auto-compaction, `/undo`, background
  processes, git awareness, `@`-mentions, project memory, web search.
