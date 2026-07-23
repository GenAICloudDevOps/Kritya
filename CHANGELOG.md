# Changelog

All notable changes to kritya are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Per-tool time limits** — `ToolDef.execute` has always taken an abort
  signal, but only three of kritya's tools honored it, and the loop awaited the
  call without racing it. A tool that hung hung the whole turn, and neither Esc
  nor the kill switch could free it, since both work by aborting a signal
  nothing was listening to. Any tool call now has 120 seconds
  (`toolTimeoutSeconds` in config.json; 0 disables) before it's abandoned and
  reported to the model as a failure it shouldn't blindly retry. Tools that
  enforce their own deadline — `shell`, subagents, MCP calls — opt out via
  `ToolDef.timeoutMs = 0` and keep theirs. This rescues asynchronous hangs
  only: a tool spinning the CPU synchronously blocks the event loop, so the
  timer cannot fire, and abandoning is not cancelling — a tool that ignores its
  signal keeps running in the background.
- **A crash no longer takes the terminal and the session with it** — an
  unhandled rejection anywhere terminated the process without firing `"exit"`,
  which is where every cleanup path hangs off: background dev servers, MCP
  stdio children, and LSP servers all outlived the session, and Ink left the
  terminal in raw mode with the cursor hidden, so the shell underneath was
  unusable until the user blind-typed `reset`. kritya now catches
  `uncaughtException` and `unhandledRejection` in both interactive and headless
  mode, shuts those children down, restores the terminal, and prints the
  transcript path with the `-c` command to resume.
- **Stream idle timeout** — a provider that accepted the connection and then
  went quiet left the turn hanging indefinitely with a live spinner: the
  request had succeeded, nothing threw, and the retry loop was never reached.
  Requests now carry a whole-call ceiling, and the gap between streamed chunks
  is bounded separately at 60 seconds — the two catch different failures, since
  an overall timer tight enough to notice a stall would cut off legitimate long
  answers. A stall aborts the dead stream and retries.

- **MCP prompts and resources** — kritya implemented one of the protocol's
  three server primitives. A server's prompts now appear as slash commands
  named `/<server>-<prompt>`, with argument hints and autocomplete, so a Linear
  server can contribute `/linear-triage` without the user writing a command
  file; they are matched after built-ins and user command files, so a server
  cannot redefine `/plan`. A server's resources appear as `@mcp:<server>/<name>`
  attachments alongside file mentions. Both are labelled as external content
  when handed to the model, since a server authored them. Neither is requested
  from a server that doesn't advertise the capability.
- **`roots/list`** — kritya advertised no client capabilities and dropped every
  server-to-client request on the floor, so a filesystem-style server had no way
  to learn where the workspace was and fell back to whatever its own config
  guessed. kritya now declares the `roots` capability and answers with the
  workspace. Other server requests get a proper "method not found" error rather
  than silence, so a server can tell an unsupported client from a hung one.
- **Per-server tool allow/deny** — a server's entire tool list was exposed
  unconditionally, and every exposed tool's schema is sent on every request, so
  a 100-tool server cost tokens each turn and buried the handful of tools that
  mattered. `"tools": { "allow": [...], "deny": [...] }` on a server entry now
  limits what's exposed, matched against the server's own tool names with `*`
  wildcards; `deny` wins over `allow`, and an absent `allow` means everything.
  `/mcp` reports how many tools a server's config held back. The filter is part
  of the trust fingerprint, so relaxing `allow` from `["search"]` to `["*"]`
  re-asks rather than inheriting the earlier approval.
- **`/mcp trust` and `/mcp trust revoke <name>`** — the per-server allowlist
  could only ever be appended to. Since approval is matched by config
  fingerprint across every workspace, an entry for a server you'd stopped using
  silently re-approved it the next time any repo declared the same config, and
  the only way out was hand-editing the store. Approvals can now be listed and
  withdrawn. `/mcp remove` also withdraws the approval of the server it
  removes, and its message for a project-declared server now points at
  `/mcp trust revoke`, which is the only way to stop one loading without
  editing the repo.
- **MCP tool annotations are honored** — every MCP tool was hardcoded as
  requiring approval, which prompted on pure lookups (a docs fetch, an issue
  search); approval fatigue is what trains people to accept without reading, so
  the blanket prompt made the prompts that matter less effective. It also had a
  consequence nothing surfaced: subagents are only handed tools that don't
  prompt, so no MCP tool was ever available to any subagent. Tools a server
  marks `readOnlyHint` (and not `destructiveHint`) now run without a prompt and
  reach subagents. Their output is still wrapped as untrusted content.
- **`cwd` for stdio MCP servers** — a server was launched in whichever
  directory kritya was started from, so a filesystem-style server configured
  with a relative root (`server-filesystem .`) scoped itself to the home
  directory under `cd ~ && kritya ~/projects/app` instead of the project.
  Servers now default to the workspace root, and `cwd` overrides that (resolved
  against the workspace, so a checked-in `.mcp.json` stays portable). `cwd` is
  part of the per-server trust fingerprint: widening a server's directory
  re-asks for approval instead of inheriting the old one.

- **OAuth 2.1 for remote MCP servers** — HTTP servers previously got only the
  static `headers` from config, which meant every hosted MCP server (Linear,
  Notion, Sentry, GitHub, Atlassian) was unreachable, since they all require
  OAuth with dynamic client registration and PKCE. kritya now implements the
  full flow: a `401` is parsed for its `WWW-Authenticate` challenge, the
  protected-resource (RFC 9728) and authorization-server (RFC 8414) metadata are
  discovered, the client registers itself dynamically (RFC 7591) as a public
  client, and the user approves in a browser via authorization-code + PKCE
  (RFC 7636) with the redirect captured by a one-shot loopback listener on
  `127.0.0.1` (RFC 8252). Tokens are bound to the server with `resource`
  (RFC 8707) and stored in `~/.kritya/mcp-auth.json` at `0600` with the same
  Windows-ACL hardening as the rest of `~/.kritya`; expired access tokens
  refresh on `401` and the request is retried, with concurrent refreshes
  serialized so a burst of parallel connects can't invalidate each other's
  grant. A server needing a login is reported as `needsAuth` rather than as a
  failure, and no browser ever opens during startup.

- **`/mcp` subcommands** — `/mcp add <name> <url>` (or `-- <command…>` for
  stdio), `/mcp remove <name>`, `/mcp login <name>`, `/mcp logout <name>`, and
  `/mcp code <name> <code>` for headless/SSH sessions where the loopback
  redirect can't be reached. Adding, removing, or logging in attaches and
  withdraws that server's tools in the running session — no restart. `/mcp add`
  refuses plain-HTTP URLs (localhost excepted). `/mcp logout` reports revocation
  and local deletion separately, so a server without a revocation endpoint is
  never described as fully signed out. Bare `/mcp` remains available while the
  kill switch is engaged; its mutating subcommands do not.

- **Project-declared servers confirm before an account login** — a server from
  the workspace's `.mcp.json` was written by whoever wrote the repo, so
  `/mcp login` on one requires an explicit `--yes` before it can open a consent
  screen against the user's real account. Servers in the user's own
  `~/.kritya/config.json` sign in without the extra step. This is narrower than,
  and additional to, the existing per-server trust gate.

- **Kill switch** — `Ctrl+K` (or `/kill [reason]`) is a session-wide emergency
  stop. It aborts the in-flight model stream, any running tool, and every
  subagent, then refuses all further work — new turns, tool calls, compaction,
  and agent-driving slash commands — until `/kill off` releases it. Enforcement
  lives in the agent loop rather than the UI, gated ahead of plan mode, deny
  rules, allow rules, and accept-edits, so no mode or rule can let a tool
  through while it's engaged; a single shared switch covers subagents, which
  run as separate agents. Engaging and releasing it are recorded in the audit
  log, and blocked tool calls appear there with the new `kill-switch`
  permission source. Session-only: a restart comes up in the normal state.

- **Audit log + OpenTelemetry tracing (local-only)** — every permission
  decision and tool execution is now recorded to an append-only, tamper-evident
  audit trail under `~/.kritya/audit/<session>.audit.jsonl`, separate from the
  session transcript: each entry captures the tool, a one-line summary, the
  verdict (allowed/denied), its source (deny-rule, allow-rule, always-allow,
  accept-edits, interactive, plan-mode, or read-only), and the execution
  outcome and duration. Entries are hash-chained, so editing or deleting any
  line is detectable (`AuditLog.verify`). Auditing is on by default; set
  `KRITYA_AUDIT=off` to disable it. Additionally, the tool loop can emit
  OpenTelemetry-shaped spans (one per turn, one per tool call, nested) for local
  inspection — set `KRITYA_OTEL=file` (default path
  `~/.kritya/telemetry/<session>.otel.jsonl`), `console`, or `both`; override
  the path with `KRITYA_OTEL_FILE`. Both are fully local — no external service,
  collector, or network is involved. Spans use OTel field names so a real OTLP
  exporter can be added later without changing the loop.
- **Staged new-project workflow** — creating a new project now runs through
  four phases, each producing a durable artifact under `docs/<name>/` and
  hard-stopping for your approval before the next: **brainstorm**
  (`docs/<name>/brainstorm.md`), **plan** (`docs/<name>/plan.md`), **spec**
  (`docs/<name>/spec.md`), then **build** (the code). The agent drives this
  automatically when you ask it to build something new — it tracks the current
  phase in `.kritya/project.json` and resumes there across sessions — but you
  can also step through it by hand with the new `/brainstorm <idea>`, `/spec`,
  and `/build` commands. The plan phase reuses plan mode: `/plan` on an active
  project designs the architecture read-only, with a narrow exception that lets
  it write Markdown planning docs under `docs/` while application code and shell
  stay blocked.
- **Checkpoint / rewind** — `/checkpoint <name>` saves a named point in the
  session (run `/checkpoint` with no name to list saved ones), and
  `/rewind <name>` rolls both the conversation and the files back to that
  point together. Where `/undo` steps back file changes one turn at a time,
  `/rewind` restores the transcript and the working tree to a chosen moment in
  one step. Checkpoints are in-memory for the current session; rewinding files
  reuses the existing undo stack, so each reverted turn stays individually
  redoable.

### Fixed

- **`/undo` no longer deletes a file instead of restoring it** — the undo
  stack learned what kritya had written only from a file-watcher event, which
  assumed every write produces one. macOS coalesces FSEvents and can drop the
  event for a write landing just after the watch is registered; when the event
  for kritya's own write went missing, the baseline stayed at "this file did
  not exist", so a later hand-edit was checkpointed against that null and
  undoing it removed the user's file. kritya now re-reads the file itself once
  its own write settles rather than waiting to be told. Caught by the macOS CI
  runner.
- **Writes can no longer leave a file cut in half** — `fs.writeFile` truncates
  the target before filling it back in, so a crash, the kill switch, a full
  disk, or a power cut in that window destroyed the file, with the original
  surviving only in the memory of the process that just died. Every write now
  goes to a sibling temp file that is renamed over the target, which is a
  single filesystem operation: readers see the whole old file or the whole new
  one. Symlinks are still followed rather than replaced, the original's
  permissions are preserved (a renamed-in file would otherwise silently lose a
  script's executable bit), and on Windows a rename blocked by another process
  holding the file open falls back to writing in place rather than failing.
  Applied to `write_file`, `edit_file`, notebooks, documents, LSP renames, and
  `/undo`'s own restore; the session store's private copy of this logic was
  replaced by the shared one. There is deliberately no `fsync`: the hazard
  closed here is truncation, not power loss.
- **Compaction failure no longer destroys the turn** — summarizing older
  history is reached almost exclusively when things are already going badly, so
  the summarization call failing aborted the turn at exactly the point the user
  most needed it to survive. A failure now degrades to a mechanical record of
  the dropped span — which files were touched, which commands ran — labelled as
  not being a summary so the model doesn't trust it as one. Cancellation still
  propagates.
- **A prompt too large for the context window is recovered, not fatal** —
  auto-compaction fired on the prompt size a provider _reported_, always one
  request behind, so a single large tool result could push the next request
  past the window; the resulting error is a hard 400 that no retry fixes.
  kritya now estimates the request before sending and compacts pre-emptively,
  and a context-overflow rejection is caught, compacted, and re-sent once. The
  token estimate that drives the context meter on providers that don't report
  usage was also replaced: it now accounts for tool-call payloads and charges
  an attached image a flat cost instead of counting its base64 data URL, which
  made one small image look like 150,000 tokens.
- **More network failures are retried, and `Retry-After` is honored** — the
  retry classifier recognized four errno codes, missing undici's `UND_ERR_*`
  family (what Node's own fetch reports on flaky connections),
  `ERR_STREAM_PREMATURE_CLOSE`, `ECONNREFUSED`, `EPIPE`, causes nested one
  level down, the SDK's own connection-error classes, and HTTP 408. Backoff
  also ignored the provider's `Retry-After`, so kritya could wait less than a
  rate limiter asked and spend the next attempt against the same closed window
  — which is how a four-attempt budget evaporates in two seconds on a free
  tier.
- **`web_search` had no timeout** — the Tavily call was a bare `fetch` with no
  signal, so a socket that never answered hung the tool indefinitely. It is now
  bounded at 30 seconds, which is needed independently of the per-tool limit
  above because `/web-search` calls it outside the agent loop.
- **Non-text tool results are no longer discarded** — every content block that
  wasn't plain text became the literal string `[image content]`, throwing away
  three things that carry real payload today. `structuredContent` (the
  machine-readable result, spec 2025-06-18) is now used when a tool returns no
  text blocks; resources the server embedded in the response are inlined
  instead of dropped; `resource_link` blocks name their target; and images and
  audio become placeholders that state their media type and size rather than a
  bare `[image content]`. A text block still wins over `structuredContent`,
  since servers that provide both send the same data twice.
- **The new-MCP-server prompt is per server** — it approved every pending
  server declared by a workspace as one batch, so a branch adding a good server
  and a hostile one offered only "both" or "neither" — and someone who wanted
  the good one took both. Each server is now presented and decided on its own,
  with a marker on remote endpoints, since those send requests and any token
  you hold off the machine.

- **MCP redirects no longer carry credentials off-origin** — HTTP requests used
  `fetch`'s default redirect handling, which re-sends every header, including
  `Authorization`, to whatever `Location` names. A compromised server, or anyone
  able to rewrite a plaintext hop, could point that at their own origin and
  collect the token. Redirects are now handled explicitly and refused when they
  leave the origin.
- **The `https://` requirement covers all three config sources** — `/mcp add`
  refused plaintext remote servers, but a server hand-written into
  `~/.kritya/config.json` or a repo's `.mcp.json` bypassed that check entirely
  and would POST a bearer token in the clear. The check now runs where every
  source converges, at connect time. Loopback stays exempt.
- **MCP tool names can no longer collide or overflow** — name sanitizing is
  lossy, so `my.tool` and `my-tool` both became `mcp_<server>_my_tool` and one
  silently shadowed the other. Separately, OpenAI-compatible endpoints cap
  function names at 64 characters and reject the _entire_ request when any name
  exceeds it, which presented as an inexplicable model failure rather than an
  MCP one. Colliding and over-long names now get a deterministic hash suffix.

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
  - Background processes (`shell` tool with `background: true`) failed to
    start on Windows: `background.ts` manually built a `cmd /c` argument
    array, and Node's array-based quoting for `cmd.exe` mis-parses commands
    that themselves contain quotes (e.g. `node -e "..."`). Fixed by spawning
    with `shell: true` and the full command as one string — the same
    pattern the regular `shell` tool already uses via `exec()` — so Node
    picks correct per-OS shell quoting instead of us reimplementing it.

### Added

- **Repo map** (`repo_map` tool): a cheap, whole-repository structural
  skeleton — source files ranked by importance, each with its class/function/
  type signatures but no bodies — so the agent can orient itself in an
  unfamiliar or large codebase without reading files just to discover where
  things live. Symbol extraction is regex/heuristic-based (no language server
  to spawn, no native parser dependency, runs in one pass), covering the
  mainstream languages (TS/JS, Python, Go, Rust, Java, Kotlin, C#, C/C++, Ruby,
  PHP, Swift, Scala); files in unsupported languages are simply omitted rather
  than producing noise. Output is bounded (files scanned, symbols per file, and
  total length are all capped) so it never blows up on a huge monorepo, and it
  honors `.krityaignore`. Read-only, so subagents get it too. This is the
  low-cost half of semantic codebase navigation — no embeddings, no index to
  keep in sync, no code leaving the machine.

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
