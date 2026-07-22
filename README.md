# kritya

A lean, Claude Code-style coding agent for your terminal. Provider-agnostic —
it works with any OpenAI-compatible endpoint: [build.nvidia.com](https://build.nvidia.com)
(Qwen3 Coder, Kimi K2, DeepSeek, GLM, Nemotron, ...) by default, plus OpenAI,
OpenRouter, Groq, DeepSeek, Mistral, Together, and local models via Ollama.
Works on Linux, macOS, and Windows.

```
cd your-project
kritya .
```

The agent can read, write, and edit files, search code, and run shell commands —
autonomously looping until your request is done. Anything that mutates state
(writes, edits, shell commands) asks for your permission first.

## Setup

1. Get a free API key at [build.nvidia.com](https://build.nvidia.com) (click any
   model → "Get API Key").
2. Set it (any one of these):
   - Put `NVIDIA_API_KEY=nvapi-...` in a `.env` file — checked in the workspace
     you launch in, the directory you run from, and `~/.kritya/.env`
   - Linux/macOS: `export NVIDIA_API_KEY=nvapi-...`
   - Windows: `setx NVIDIA_API_KEY nvapi-...` (then open a new terminal)
3. Install and run:

```bash
npm install        # from this repo
npm run build
npm link           # puts `kritya` on your PATH
cd ~/some-project
kritya .
```

## Usage

```
kritya [directory] [options]

  -c, --continue        resume the most recent session for this directory
  -r, --resume          pick a past session from a list
  -m, --model <id>      use any model ID your provider offers
  -p, --provider <name> nvidia (default), openai, openrouter, groq, deepseek,
                        mistral, together, ollama, or a custom one
  -h, --help            help
  -v, --version         version
```

In-session commands (type `/` to see them with autocomplete; letters filter the list):

| Command               | What it does                                                             |
| --------------------- | ------------------------------------------------------------------------ |
| `/model`              | interactive model picker (`/model <id>` sets any model ID directly)      |
| `/provider`           | list providers, or `/provider <name>` to switch mid-session (see below)  |
| `/brainstorm <idea>`  | start the staged new-project workflow (brainstorm → plan → spec → build) |
| `/plan`               | toggle plan mode (read-only); on an active project, run the plan phase   |
| `/spec`               | project workflow: write the spec from the approved plan                  |
| `/build`              | project workflow: implement the project from the spec                    |
| `/diff`               | show the cumulative git diff of this session's changes                   |
| `/init`               | scan the repo and generate a `KRITYA.md` project-memory file             |
| `/commit`             | have the agent review, stage, and commit the current git changes         |
| `/web-search <query>` | search the web via Tavily; results are shown and added to context        |
| `/undo`               | revert all file changes from the agent's last turn                       |
| `/redo`               | reapply the change most recently undone                                  |
| `/checkpoint <name>`  | save a named point in the session (`/checkpoint` alone lists saved ones) |
| `/rewind <name>`      | rewind both the conversation and the files to a checkpoint               |
| `/compact`            | summarize older conversation to free context space                       |
| `/clear`              | start a fresh conversation                                               |
| `/cost`               | token usage and estimated $ (see Pricing below)                          |
| `/budget`             | show session token budget; `/budget reset` or `/budget <number>`         |
| `/help`               | command list                                                             |
| `/exit`               | quit                                                                     |

Custom `/commands` you define (see below) also appear here.

`Esc` cancels a running request. `↑/↓` recalls input history. `Ctrl+O` toggles
full tool output. `Ctrl+C` exits.

### More features

- **Staged new-project workflow** — ask kritya to build something new (a
  FastAPI backend, a Next.js frontend, a CLI) and it doesn't dive straight into
  code. It runs four phases — **brainstorm → plan → spec → build** — writing a
  durable artifact for each under `docs/<name>/` (`brainstorm.md`, `plan.md`,
  `spec.md`, then the code) and stopping for your approval between phases. The
  current phase lives in `.kritya/project.json`, so the flow resumes where you
  left off across sessions. The agent walks the phases on its own, or you can
  drive them by hand: `/brainstorm <idea>` starts one, `/plan` runs the
  (read-only) plan phase, `/spec` writes the spec, `/build` implements it. In
  the plan phase, plan mode's read-only guard is relaxed just enough to let the
  agent write Markdown planning docs under `docs/` — application code and shell
  stay blocked until you `/build`.
- **Trust levels** — `Shift+Tab` cycles **normal** (every write/edit asks
  first) → **accept-edits** (file writes/edits auto-approve, no prompt) →
  **plan** (read-only, nothing executes) → back to normal. The statusline
  always shows which one you're in, with a running `(N auto-approved)` count
  in accept-edits mode so you know how much slipped through before checking
  `/diff`. Destructive shell commands (`rm -rf`, force-push, etc.) always
  still prompt, in every mode — that guard never turns off. The first time you
  switch into accept-edits mode each session, kritya asks you to confirm first
  so it's a deliberate choice, not an accidental keypress. `/plan` still works
  as its own command and is equivalent to cycling into plan mode.
- **Subagents** — the agent can dispatch one or more focused investigations to
  fresh contexts at once (`spawn_agent`), each returning only its findings —
  keeps the main conversation lean on big searches. It can also dispatch
  **write-capable subagents** (`spawn_write_agent`) for independent chunks of
  work that can proceed in parallel; each one is isolated on its own git
  branch/worktree, so its edits and shell commands never touch your real
  working tree — review the diff and merge the branch yourself when ready.
  Destructive commands (`rm -rf`, force push, etc.) are always blocked inside
  a write subagent, since there's no one there to confirm them; each subagent
  also has a hard time limit and no more than 3 (read) / 4 (write) run in one
  call.
- **Image attachments** — `@screenshot.png` sends the image to vision-capable
  models alongside your message.
- **Undo / redo** — `/undo` reverts the last turn's file changes; `/redo`
  reapplies them. Undo is multi-level. A file watcher also checkpoints edits
  you make yourself (in your own editor) to any file kritya has touched this
  session, as their own step in the right order — so hand-editing a file
  between turns and later running `/undo` never silently discards that edit.
- **Checkpoint / rewind** — `/checkpoint <name>` saves a named point in the
  session; `/rewind <name>` rolls _both_ the conversation and the files back to
  it at once (e.g. "go back to before the auth refactor"), where `/undo` only
  steps back file changes one turn at a time. Checkpoints are in-memory for the
  current session.
- **Steer mid-run** — type while the agent is working and press Enter; your
  message is queued and absorbed before its next step (no need to interrupt).
- **Auto-compaction → self-improving project memory** — when the conversation
  nears the model's context window (80% of `contextWindow`, default 120k
  tokens), older turns are summarized automatically; the statusline shows
  current usage as `ctx N%`. Compaction (auto or manual `/compact`) also
  distills durable, objective facts out of what's being summarized away —
  build/test commands, package manager, conventions actually observed — and
  merges any new ones into a `## Learned by kritya` section in `KRITYA.md`,
  deduplicated and capped at 20 facts. Anything you or `/init` wrote above
  that section is left untouched. It's scoped to describing the project, not
  storing instructions, since this file is read back as background context on
  every future run.
- **Token budget** — a session-wide cap on combined prompt + completion
  tokens across every turn and model (default 1,000,000; set `tokenBudget` in
  config, or `/budget <number>` mid-session). The statusline shows `budget N%`
  once usage starts, turning yellow past 80% with a one-time warning, then
  stops further turns entirely at 100% until you run `/budget reset` (clears
  the count) or `/budget <number>` (raises the cap). `/cost` also reports it.
- **Background processes** — the agent can start dev servers/watchers with
  `background: true`, read their output (`bg_output`), and stop them
  (`bg_kill`); everything is killed when kritya exits. Foreground commands
  accept a `timeout_seconds` (default 120), and long output keeps the tail,
  where the errors are.
- **Git aware** — the statusline shows the current branch, the agent sees
  `git status` each request, and `/undo` checkpoints are per turn.
- **@ file mentions** — type `@` in your message to autocomplete a file path
  (↑↓ select, Tab/Enter attach); the file's content is sent along with your message.
- **Project memory** — create a `KRITYA.md` in your workspace root (or run
  `/init` to generate one) with standing instructions; the agent reads it
  every request.
- **Sub-task checklist → resumable plans** — for multi-step requests the agent
  plans first and shows a live ☐/◐/☑ checklist as it works, with a compact
  `tasks N/M` summary in the statusline. The checklist is saved alongside the
  session, so `kritya -c` (and picking a session via `-r`) restores not just
  the conversation but exactly which steps were done, in progress, or still
  pending.
- **Diff preview** — write/edit permission prompts show a red/green line diff of
  exactly what will change before you approve; code blocks in answers are
  syntax-highlighted.
- **Session search** — `kritya -r` lists past sessions by title (first message);
  type to filter.
- **Web search tool** — besides `/web-search`, the agent can search on its own when
  it needs current information (needs `TAVILY_API_KEY` in `.env`, free at
  tavily.com). Web content is delimited as untrusted so pages can't inject
  instructions into the agent.
- **Prompt-caching awareness** — the system prompt is ordered stable-first
  (identity and rules → project memory → volatile git status/listing last) so
  providers can reuse their cached prompt prefix across turns instead of
  re-reading everything. `/cost` and the statusline show how many prompt
  tokens were served from the provider's cache; add an optional
  `"cachedInput"` rate to your `pricing` config to see the dollar savings.
- **LSP integration** — the agent gets go-to-definition, find-references, and
  live diagnostics from real language servers (`lsp_definition`,
  `lsp_references`, `lsp_diagnostics`), resolved semantically instead of by
  text search. Supports TypeScript/JavaScript, Python, Go, Rust, and C/C++ —
  it uses whichever servers you have installed (`typescript-language-server`,
  `pyright`, `gopls`, `rust-analyzer`, `clangd`) and tells the agent the
  install command when one is missing. Servers spawn on first use, stay warm
  for the session, and never require configuration.

## Headless / CI mode

Run one prompt to completion with no terminal UI and no TTY requirement —
for scripts, CI pipelines, and GitHub Actions:

```bash
kritya --prompt "fix the failing tests" --output json
```

Exits `0` on success, `1` on failure — check `$?` in a pipeline. `--output json`
prints a single JSON object on stdout: `{success, result, error, toolCalls,
usage, durationMs, model}`. Plain `--output text` (the default) just prints
the agent's final answer.

There's no terminal to show a permission prompt, so headless mode never
blocks waiting for one:

- Mutating tool calls are denied by default unless covered by an `allow` rule
  in `.kritya/settings.json`, or `--allow-all` is passed to approve them all.
- Destructive commands (`rm -rf`, force-push, etc.) are **always** denied,
  even with `--allow-all` — there's no one to confirm them, so that guard
  never turns off.
- The workspace's own `.kritya/settings.json`, hooks, `.env`, and custom
  commands only take effect with `--trust`, or if the workspace was already
  trusted in a prior interactive session — never silently, since CI often
  checks out untrusted branches/PRs.
- `--timeout <seconds>` caps the whole run (default 1800); a stuck turn is
  aborted rather than hanging a CI job forever.

Example GitHub Actions step:

```yaml
- name: Fix failing tests with kritya
  env:
    NVIDIA_API_KEY: ${{ secrets.NVIDIA_API_KEY }}
  run: |
    npx kritya --prompt "run the test suite, fix any failing tests, and show a diff" \
      --output json --allow-all > result.json
    cat result.json
```

Subagents (`spawn_agent`/`spawn_write_agent`) aren't available in headless
mode — a single prompt/response doesn't need the parallel-dispatch machinery
they're built for.

## Permissions

- Read-only tools (`read_file`, `list_dir`, `glob`, `grep`, `bg_output`) run
  without asking.
- Mutating tools (`write_file`, `edit_file`, `shell`) prompt: **Yes / Yes, always
  for this session / No**.
- File tools are confined to the workspace directory you launched in.

### Allowlists

Skip prompts for commands you always trust via `.kritya/settings.json` in your
workspace (per-project) or `~/.kritya/settings.json` (global):

```json
{
  "allow": ["shell(npm test)", "shell(git status)", "shell(git diff*)", "write_file"]
}
```

A bare tool name allows that tool; `shell(pattern)` allows shell commands
matching the pattern, where `*` is a wildcard. Patterns also work for file
tools against the path — `write_file(src/*)`, `edit_file(*.ts)`. Matching is
anchored — `shell(npm test)` does **not** allow `npm test && something-else`.

### Deny rules and the danger guard

`deny` rules block matching calls outright — no prompt, and they can't be
overridden by an allow rule or an "always allow" choice:

```json
{
  "allow": ["write_file"],
  "deny": ["write_file(.env*)", "edit_file(*secret*)", "shell(git push*)"]
}
```

Separately, destructive commands (`rm -rf`, `git push --force`,
`git reset --hard`, `curl | sh`, `sudo`, `mkfs`, fork bombs, …) always trigger a
red warning prompt and can't be "always allowed" — even if a broad `shell(*)`
rule would otherwise cover them.

### Sandboxed execution (opt-in)

The danger guard above is regex-based pattern matching on the command text —
it can be evaded (obfuscated flags, `eval`, base64, etc.). `sandboxExec` in
`~/.kritya/config.json` adds an OS-enforced backstop: shell commands run
inside a restricted environment where writes are blocked everywhere except
the workspace, regardless of what the command text looks like.

```json
{ "sandboxExec": "auto" }
```

- `"auto"` (recommended) — only commands the danger guard flags get
  sandboxed; ordinary commands run exactly as before.
- `"always"` — every shell command is sandboxed.
- `"off"` (default) — unchanged behavior.

Backed by `bwrap`/bubblewrap on Linux and `sandbox-exec` on macOS; not yet
available on Windows. If the required binary isn't on `PATH`, kritya falls
back to an unsandboxed run and says so in the output rather than failing
silently. The sandbox confines **writes** to the workspace (plus system temp
dirs) — reads and network access are left open, since restricting those
breaks most ordinary tooling (dynamic linking, package manager caches, `git
push`, etc.). It contains accidental or malicious damage outside your
project; it isn't a full read-confinement or network isolation sandbox.
Background processes (`background: true`) aren't sandboxed yet.

### Audit log & telemetry

The session transcript records the conversation; the **audit log** records what
was allowed to run and by whose authority — the trail an enterprise reaches for
during a review. It is a **local, user-owned record**, not telemetry: nothing
in it is ever transmitted anywhere, and it's on by default for the same reason
your shell history is — it's your own record of what ran, kept on your own
disk. Every permission decision and tool execution is appended to
`~/.kritya/audit/<session>.audit.jsonl`, one JSON record per line:

```json
{"event":"permission","tool":"shell","summary":"run: rm build/","verdict":"allowed","source":"interactive","seq":4,"ts":"..."}
{"event":"tool","tool":"shell","summary":"run: rm build/","outcome":"ok","durationMs":38,"waitMs":2103,"seq":5,"ts":"..."}
```

`source` is one of `deny-rule`, `allow-rule`, `always-allow`, `accept-edits`,
`interactive`, `plan-mode`, or `read-only`. `durationMs` is how long the tool
itself ran; `waitMs` is how long it sat waiting for a permission answer before
that — kept separate so tool timings measure the machine, not how fast you
read a prompt. The file is **append-only** (unlike the transcript, `/rewind`
and `/compact` never touch it) and **tamper-evident**: each record is
hash-chained to the previous one, so editing or deleting any line — or
deleting the whole file — breaks or removes the chain and is detectable.
Auditing is on by default — set `KRITYA_AUDIT=off` to turn it off.

Subagents (`spawn_agent` / `spawn_write_agent`) share the same audit log as the
session that spawned them, so a helper agent that edits and commits code is
never off the record.

Inspect the log from inside a session with `/audit` (a summary: permission
decisions by source, tool outcomes, and whether the chain still verifies), or
from the command line:

```bash
kritya audit --list              # every audit log, newest first, with chain status
kritya audit --verify [file]     # verify one log's hash chain (defaults to the newest)
kritya audit --show [file]       # print a log's records, one JSON line each
```

For tracing, the tool loop can emit **OpenTelemetry-shaped spans** — one per
turn, with a nested span per model call (`llm.chat`, including retries as
events) and per tool call — for local inspection:

```bash
KRITYA_OTEL=file      # -> ~/.kritya/telemetry/<session>.otel.jsonl (default)
KRITYA_OTEL=console   # spans to stderr, prefixed [otel]
KRITYA_OTEL=both
KRITYA_OTEL_FILE=/path/to/spans.jsonl   # override the file path
```

Spans carry OTel field names (`traceId`, `spanId`, `parentSpanId`,
`startTimeUnixNano`, `status`, …). A subagent's spans nest under the turn that
spawned it, so one trace covers the whole tree. Both features are **entirely
local** — no external service, collector, or network is involved; the OTel
field names just mean a real OTLP exporter can be wired in later without
changing anything in the loop. Telemetry is off unless `KRITYA_OTEL` is set.

Headless JSON output (`--prompt ... --output json`) includes `sessionId`,
`traceId`, `auditFile`, and `telemetryFile`, so a CI run's result can be
matched back to the detailed records that explain it.

## Configuration

`~/.kritya/config.json`:

```json
{
  "apiKey": "nvapi-...",
  "model": "nvidia/nemotron-3-super-120b-a12b",
  "baseUrl": "https://integrate.api.nvidia.com/v1",
  "customModels": [{ "id": "some-org/new-model", "label": "New Model" }],
  "pricing": {
    "nvidia/nemotron-3-super-120b-a12b": { "input": 0.6, "output": 2.4 }
  },
  "contextWindow": 120000,
  "tokenBudget": 1000000
}
```

`pricing` is optional (USD per 1M tokens per model). When set, `/cost` and the
statusline show estimated dollars alongside token counts.

`tokenBudget` caps combined prompt + completion tokens for the whole session
(default 1,000,000); kritya warns at 80% and stops further turns at 100% until
`/budget reset` or `/budget <number>`.

`customModels` entries show up in the `/model` picker. Model IDs change over
time — pick an agent-capable (tool-calling) model for best results; chat-only
models will answer questions but can't edit files. `maxSteps` (default 40) caps
model round-trips per request. `contextWindow` overrides the per-model default.

Sessions are stored as JSONL under `~/.kritya/sessions/` and reloaded with
`kritya -c`. Each turn is appended as its own line, and the task checklist
sidecar is written via tmp-file-then-rename, so a crash or kill mid-write
loses at most the one in-flight message rather than the whole session —
`-c`/`-r` resume from everything written before that.

### Providers

kritya works with any OpenAI-compatible API. Built-in names: `nvidia` (default),
`openai`, `openrouter`, `groq`, `deepseek`, `mistral`, `together`, `ollama`.
Select one with `--provider` or `provider` in config; the API key comes from the
provider's env var (e.g. `OPENAI_API_KEY`, `OPENROUTER_API_KEY`) or a `.env`
file. Add your own, or override a built-in:

```json
{
  "provider": "openrouter",
  "providers": {
    "openrouter": { "baseUrl": "https://openrouter.ai/api/v1", "apiKeyEnv": "OPENROUTER_API_KEY" },
    "local": { "baseUrl": "http://localhost:8000/v1", "apiKey": "sk-none", "model": "my-model" }
  }
}
```

#### Which model wins when there are two `model` fields?

A model can be set in two places: the top-level `model`, and
`providers.<name>.model` (a per-provider default). Precedence, highest first:

```
--model flag (CLI)  >  top-level "model"  >  providers.<name>.model  >  built-in default
```

The top-level `model` wins over any per-provider default, regardless of which
provider is active — so if it's set, switching `provider` alone won't change
the model. Leave the top-level `model` out of config.json if you want each
provider to fall back to its own `providers.<name>.model` when selected.

```json
{
  "model": "big-model-A",
  "provider": "groq",
  "providers": {
    "groq": { "model": "big-model-B" }
  }
}
```

Here `"big-model-A"` is used, not `"big-model-B"` — the top-level field always
overrides the provider-scoped one.

#### Retries and provider fallback

Every request retries transient failures (HTTP 429, any 5xx, and connection
errors like ECONNRESET/ETIMEDOUT) up to 4 attempts with exponential backoff
(1s, 2s, 4s, plus jitter) before giving up — no configuration needed. If all
attempts fail, kritya reports it as "isn't responding" and, in the interactive
UI, suggests any other configured provider you can fall back to.

To actually fail over — say NVIDIA is down and you have `OPENAI_API_KEY` set
too — run `/provider openai` mid-session. It swaps the underlying HTTP client
only; your conversation, undo history, and task checklist are untouched, so
the agent picks up exactly where it left off. `/provider` with no argument
lists every built-in and custom provider and marks which ones currently have
an API key configured (only those are actually switchable). In headless mode
(`--prompt`/`kritya -p ...`) there's no session to fail over mid-run, but the
error message names an alternative to retry with via `--provider <name>`.

A practical fallback chain to configure: keep `nvidia` as your default and set
`OPENAI_API_KEY` or `OPENROUTER_API_KEY` as a backup — OpenRouter alone
proxies most major model families, so it's a reasonable single fallback for
"any one provider is down."

### Custom slash commands

Drop a markdown file in `.kritya/commands/` (workspace) or `~/.kritya/commands/`
(global) and it becomes a slash command named after the file. The body is a
prompt; `$ARGUMENTS` is replaced with whatever you type after the command.

```markdown
<!-- .kritya/commands/review.md -->

description: review the working changes for bugs and style

Review the current git diff for correctness bugs and style issues. $ARGUMENTS
```

Now `/review focus on error handling` runs that prompt.

### Hooks

Run your own shell commands around the agent's tool calls via `hooks` in
`settings.json`. `preToolUse` can block a call (non-zero exit + `"blocking": true`);
`postToolUse` runs after; `stop` runs when a turn ends. Commands receive
`KRITYA_TOOL_NAME`, `KRITYA_TOOL_PATH`, `KRITYA_TOOL_COMMAND`, and
`KRITYA_TOOL_ARGS` in the environment.

```json
{
  "hooks": {
    "postToolUse": [
      { "match": "edit_file|write_file", "command": "prettier --write \"$KRITYA_TOOL_PATH\"" }
    ],
    "stop": [{ "command": "npm run lint --silent" }]
  }
}
```

### MCP servers

Expose [Model Context Protocol](https://modelcontextprotocol.io) tools to the
agent — local servers over stdio (`command`), or remote servers over
Streamable HTTP (`url`):

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."]
    },
    "linear": {
      "url": "https://mcp.linear.app/mcp",
      "headers": { "Authorization": "Bearer ${LINEAR_API_KEY}" }
    }
  }
}
```

Servers can be defined globally in `~/.kritya/config.json`, or per-project in
a `.mcp.json` at the workspace root (the same file Claude Code, Cursor, and
VS Code read); on a name clash your global config wins. `${VAR}` in any string
is expanded from the environment, so a checked-in `.mcp.json` never needs to
contain a literal secret. Because `.mcp.json` launches processes and contacts
endpoints on your behalf, it's part of the workspace trust prompt, and trust
is re-asked whenever the file changes.

Their tools appear as `mcp_<server>_<tool>`, each call needs your approval,
and output is treated as untrusted content. A server that fails to start is
skipped with a warning; `/mcp` shows each server's status and tools.

## Privacy

kritya collects **no telemetry** and phones home to nothing of its own. Network
requests go only to the model provider you configure (and to Tavily if you use
web search). Sessions and config stay on your machine under `~/.kritya/`.

## Development

```bash
npm run dev          # run from source (tsx)
npm run build        # compile to dist/ (strict TypeScript)
npm test             # build + unit tests
npm run lint         # eslint
npm run format       # prettier --write
```

Architecture: `src/provider` (OpenAI-compatible streaming client) → `src/agent`
(the tool-call loop, compaction, system prompt) → `src/tools` (plain-object
tools) → `src/ui` (Ink/React terminal UI), with `src/permissions`, `src/hooks`,
`src/mcp`, `src/commands`, `src/session`, `src/shell` (background processes), and
`src/git` supporting. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for a full
tour and [CONTRIBUTING.md](CONTRIBUTING.md) to get started.

## License

[MIT](LICENSE).
