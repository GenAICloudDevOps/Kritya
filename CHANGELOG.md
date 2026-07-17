# Changelog

All notable changes to kritya are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
