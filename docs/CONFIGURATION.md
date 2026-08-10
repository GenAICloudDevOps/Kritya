# Configuration

Everything for tuning an already-installed kritya: permission rules, sandboxing,
the audit log and tracing, `~/.kritya/config.json`, providers, custom slash
commands, skills, hooks, MCP servers, and Agent Plugins. For install/quick-start,
CLI flags, and the in-session command list, see the [README](../README.md).

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

### Sandboxed execution

The danger guard above is regex-based pattern matching on the command text —
it can be evaded (obfuscated flags, `eval`, base64, etc.). `sandboxExec` in
`~/.kritya/config.json` adds an OS-enforced backstop: shell commands run
inside a restricted environment where writes are blocked everywhere except
the workspace, regardless of what the command text looks like.

```json
{ "sandboxExec": "auto" }
```

- `"auto"` (**default**) — sandbox every command on Linux/macOS when the
  sandbox binary is present. On Windows there is no sandbox binary to use, so
  `"auto"` falls back to sandboxing only the commands the danger guard flags,
  which avoids a fallback note on every single shell call.
- `"always"` — sandbox every command on every platform, Windows included
  (where each one then takes the unavailable-fallback path below).
- `"strict"` — like `"always"`, but **fail-closed**: if no sandbox binary is
  available, the command is refused outright instead of running unsandboxed.
  Use this when the sandbox is a hard requirement rather than a best-effort
  one.
- `"off"` — disables sandboxing entirely.

Backed by `bwrap`/bubblewrap on Linux and `sandbox-exec` on macOS; not yet
available on Windows. If the required binary isn't on `PATH`, `"auto"` and
`"always"` fall back to an unsandboxed run and say so in the output rather
than failing silently; `"strict"` refuses the command instead. The sandbox
confines **writes** to the workspace (plus system temp dirs) — reads and
network access are left open, since restricting those breaks most ordinary
tooling (dynamic linking, package manager caches, `git push`, etc.). It
contains accidental or malicious damage outside your project; it isn't a full
read-confinement or network isolation sandbox.

Background processes (`background: true`) run under the same policy, including
`"strict"`'s fail-closed behavior — kritya refuses to start an unconfined
background process rather than silently downgrading it.

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
kritya audit --summary [file]    # counts by outcome/source, latency p50/p95
kritya audit --prune [days]      # delete logs older than [days] (default: your retention setting)
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
spawned it, so one trace covers the whole tree. By default this is **entirely
local** — no external service, collector, or network is involved. Telemetry is
off unless `KRITYA_OTEL` is set.

Alongside spans, a `Meter` records `kritya.tool.duration_ms` and
`kritya.tool.calls` per tool call and `kritya.turn.duration_ms` per turn as
OTel-shaped counters/histograms.

Optionally, set `KRITYA_OTEL_ENDPOINT` (plus `KRITYA_OTEL_HEADERS` for auth,
e.g. `Authorization=Bearer ...`) to export both spans and metrics as OTLP/HTTP
JSON to a real OpenTelemetry Collector instead of (or alongside) the local
file/console sink — this is the one case where telemetry data leaves the
machine, and only when you explicitly set the endpoint. `docs/observability.md`
walks through a Docker-free local pipeline (Collector → Phoenix for traces,
Prometheus/Grafana for metrics) using the config in `observability/`.

Headless JSON output (`--prompt ... --output json`) includes `sessionId`,
`traceId`, `auditFile`, and `telemetryFile`, so a CI run's result can be
matched back to the detailed records that explain it.

Beyond model calls and tool calls, these events are also recorded (span +,
where relevant, an audit line): context **compaction** — including the
automatic one that fires when the context window is nearly full, since it
permanently discards messages; the session **token budget** crossing its warn
threshold or hard-stopping a turn; each **hook** run, tagged with which
specific hook command ran or blocked a call; and **MCP server** connect
attempts, so a server that fails to start leaves more than one stderr line.

When a provider doesn't report real token counts (some omit usage on streamed
responses), kritya estimates them from text length instead of leaving `/cost`
blind for the session — but that estimate is marked `estimated: true` in the
`Usage` object and shown as `~` in the statusline and `(some figures
estimated…)` in `/cost`, so an approximation never passes as an exact number.

Best-effort writes (session/audit/telemetry persistence, config and hook
loading, …) deliberately swallow their own errors so a failed disk write never
crashes a turn. Set `KRITYA_DEBUG=1` to print those errors to stderr instead of
dropping them silently — useful when something isn't being saved and you don't
know why. Off by default, no cost when unused.

**Retention.** Session transcripts, audit logs, and telemetry files are
auto-deleted after 15 days by default — they can carry secrets that passed
through tool output, so nothing accumulates forever unless you ask it to.
Configurable in `~/.kritya/config.json`, or with `KRITYA_RETENTION_DAYS`
(env var wins over the config value):

```json
{
  "retentionDays": 30,
  "audit": "on",
  "otel": "off"
}
```

- `retentionDays`: any positive number of days; `0` (or negative) disables
  auto-delete entirely — keep everything forever.
- `audit`: `"on"` (default) or `"off"` — a persisted way to disable the audit
  log for good, without exporting `KRITYA_AUDIT=off` every launch. The env
  var still overrides this if set.
- `otel`: persisted default for tracing (`"off"` / `"file"` / `"console"` /
  `"both"`), same relationship to `KRITYA_OTEL`.

## Configuration file

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

### Skills

Drop a `SKILL.md` file in `.kritya/skills/<name>/` in your workspace to teach
kritya a reusable procedure. The file needs `---`-delimited frontmatter with
`name` and `description` fields — both required, and a skill missing either
is silently skipped with a warning — followed by the skill's full
instructions as a markdown body.

```markdown
<!-- .kritya/skills/ratio-analysis/SKILL.md -->

---

name: ratio-analysis
description: Compute standard financial ratios from a balance sheet/income statement
---

Read the balance sheet and income statement, then compute:

- Current ratio = current assets / current liabilities
- ...
```

kritya lists discovered skills by name and description in its system prompt,
and loads a skill's full body on demand when the agent calls `load_skill`. A
skill folder can also include `scripts/`, `references/`, or `assets/`
subdirectories — `load_skill` lists their contents so the agent can read or
run them via its normal tools.

Skills are also discovered from `~/.kritya/skills` as a user-global root, so a
skill you want in every project doesn't need to be copied into each one; a
project skill wins on a name collision with a user-global one of the same
name. A skill can opt out of discovery without being deleted or renamed by
adding `disabled: true` to its frontmatter.

The frontmatter parser is a small regex, not a full YAML parser, but it does
understand two things beyond plain `key: value`: a value wrapped in matching
quotes (so a description containing a colon, e.g. `"Use when: doing X"`,
parses correctly instead of splitting on that colon), and YAML's folded
(`>`) and literal (`|`) block scalar styles for a longer multi-line
description. Nested maps/lists and inline block scalars are still out of
scope.

Run `kritya skills [dir]` to list every skill visible from a directory
(project + user-global, source labelled) and why any skill was skipped
(missing fields, `disabled: true`, malformed frontmatter); add `--json` for
machine-readable output or `--validate` to exit non-zero if anything's
malformed — useful in CI. The same listing is available as `/skills` from
inside a running session.

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
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."],
      "cwd": "./docs"
    },
    "linear": {
      "url": "https://mcp.linear.app/mcp",
      "tools": { "deny": ["delete_*"] }
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
is re-asked whenever the file changes. On top of that, each server needs its
own first-use approval, asked **one server at a time** — so a branch that adds
a useful server and a dubious one can be answered separately rather than as a
single take-it-or-leave-it. `/mcp trust` lists what you've approved and
`/mcp trust revoke <name>` withdraws it.

`tools` limits which of a server's tools are exposed, by the server's own tool
names (`*` wildcards allowed, `deny` wins over `allow`). Worth using on large
servers: every exposed tool's schema is sent on every request, so a 100-tool
server costs tokens each turn and buries the tools you actually want.

A stdio server runs in the workspace root by default — not in whatever
directory you happened to launch `kritya` from — so a server configured with a
relative root stays scoped to the project. `cwd` overrides that, resolved
against the workspace so a checked-in `.mcp.json` stays portable. Remote
servers must use `https://` (a `http://` loopback address is exempt), and a
redirect to a different origin is refused rather than forwarding your
credentials to it.

kritya answers `roots/list`, so a server that asks can scope itself to your
workspace instead of guessing from its own config.

Servers can contribute more than tools. A server's **prompts** become slash
commands named `/<server>-<prompt>` (so a Linear server can ship
`/linear-triage`), matched only after built-ins and your own command files —
a server can't redefine `/plan`. Its **resources** become `@mcp:<server>/<name>`
attachments, autocompleted alongside your files. Both are labelled as external
content when they reach the model, since the server wrote them.

Their tools appear as `mcp_<server>_<tool>`, and output is treated as
untrusted content. Calls need your approval unless the server marks the tool
`readOnlyHint` — those run without prompting and are also available to
subagents. Set `"consent": "always-confirm"` on a server to require approval
for every call from it regardless of `readOnlyHint`, for a server you trust
less than its tool annotations claim. A server that fails to start is skipped
with a warning; `/mcp` shows each server's status and tools.

A server can also ask kritya for help mid-call: `sampling/createMessage` asks
to run a completion against your configured model, and `elicitation/create`
asks the user a short structured question (boolean, string, or enum fields).
Both surface the same prompt UI as a tool call — sampling asks permission
per server (with a "yes, always this session" option), and both are declined
automatically in headless/non-interactive mode.

Set `"tasks": true` on a server whose long-running tools (a CI pipeline, a
batch job, a human approval step) support the
[Tasks extension](https://modelcontextprotocol.io/extensions/tasks/overview):
kritya declares support for it on every call to that server, and a tool that
returns a task handle instead of blocking is polled in the background — the
spinner grows a live status suffix (e.g. "running pipeline — waiting for
build…") instead of just sitting there. A task's own `input_required` step is
answered the same way a direct `elicitation/create` request would be; a task
that asks for anything else is cancelled with an error naming what it needed.
Off by default, same reasoning as `consent`: a server has no grounds to
return a task the client never said it could handle.

#### Signing in to hosted servers (OAuth)

Hosted MCP servers — Linear, Notion, Sentry, GitHub, Atlassian — authenticate
with OAuth 2.1 rather than a static token, so they need a one-time browser
sign-in:

```bash
kritya
```

```text
/mcp add linear https://mcp.linear.app/mcp
/mcp login linear
```

kritya discovers the server's authorization server from its `401`, registers
itself dynamically, and opens your browser with PKCE. You approve there, the
redirect lands on a one-shot `127.0.0.1` listener, and the token is written to
`~/.kritya/mcp-auth.json` (`0600`, plus Windows ACLs). **Your password never
touches the terminal.** After that the server connects automatically on every
start, and expired access tokens refresh silently.

| Command                    | What it does                                       |
| -------------------------- | -------------------------------------------------- |
| `/mcp`                     | status of every server, and which need a login     |
| `/mcp add <name> <url>`    | add a remote server (`-- <cmd…>` for stdio)        |
| `/mcp remove <name>`       | remove it, revoke any token, withdraw its approval |
| `/mcp login <name>`        | browser sign-in                                    |
| `/mcp logout <name>`       | revoke server-side where supported, delete locally |
| `/mcp code <name> <code>`  | finish a login by pasting the code (SSH/headless)  |
| `/mcp trust`               | list every server you've approved                  |
| `/mcp trust revoke <name>` | withdraw approval, so it's asked about again       |

Servers needing a login are marked `○` and simply contribute no tools until you
run `/mcp login` — kritya never opens a browser during startup. A server
declared by the _workspace's_ `.mcp.json` asks for one explicit confirmation
(`/mcp login <name> --yes`) before it can send you to an account-consent screen,
since that file was written by whoever wrote the repo. Servers in your own
config sign in without the extra step.

On a headless box or over SSH, `/mcp login` prints the URL instead of opening
anything; open it elsewhere and finish with `/mcp code <name> <code>`.

`/mcp logout` distinguishes the two things people conflate: it always deletes
the token locally, and separately reports whether the provider's revocation
endpoint confirmed the token is dead. If a server offers no revocation endpoint,
it says so rather than implying the token is gone.

A literal `Authorization` header in config still works and takes precedence —
if you've pasted a personal access token, kritya uses it and never overrides it
with a stored grant.

## Agent Plugins

A plugin bundles skills, custom slash commands, and MCP servers into one
shareable, versioned folder, so a capability you want in several projects is
one directory to copy (or one repo to clone) instead of three separate
configuration steps.

Plugins are discovered from two roots:

- `.kritya/plugins/` in the workspace — shared with a project via its repo.
- `~/.kritya/plugins/` — your own, available in every workspace.

Each plugin is a folder containing a `plugin.json` manifest:

```text
~/.kritya/plugins/
└── acme-toolkit/
    ├── plugin.json          # required: { "name", "version" }
    ├── skills/              # optional: <skill-name>/SKILL.md, as in Skills above
    │   └── ratio-analysis/SKILL.md
    ├── commands/            # optional: *.md, as in Custom slash commands above
    │   └── audit.md
    └── mcp.json             # optional: { "mcpServers": { … } }, as in MCP servers above
```

```json
{ "name": "acme-toolkit", "version": "1.2.0" }
```

`name` and `version` are both required, and `name` must match the folder name —
a mismatch is a common symptom of a half-renamed plugin, so kritya skips it and
says why rather than loading something under an unexpected identity. Extra
fields in the manifest are preserved and ignored, so a plugin written for a
later version of kritya still loads. Plugins load in name order, workspace root
first; on a name collision the first one found wins and the duplicate is
skipped with a reason.

Every subfolder is optional — a plugin that ships only skills needs no
`mcp.json`, and a folder without a `plugin.json` isn't a plugin at all and is
passed over silently.

Run `/plugins` to see what loaded, what each one contributes, and why anything
was skipped:

```text
acme-toolkit@1.2.0 (user)       2 skill(s), 1 MCP server(s), 1 command(s)
repo-helpers@0.3.0 (workspace)  1 command(s)
broken-plugin                   SKIPPED: plugin.json must include "name" and "version"
```

### Precedence

Contributions merge with the same rule everywhere: **the more specific source
wins.**

| Contribution   | Precedence (lowest → highest)                                       |
| -------------- | ------------------------------------------------------------------- |
| Slash commands | `~/.kritya/commands/` → plugin `commands/` → `.kritya/commands/`    |
| Skills         | plugin `skills/` and `~/.kritya/skills/` → `.kritya/skills/`        |
| MCP servers    | plugin `mcp.json` → workspace `.mcp.json` → `~/.kritya/config.json` |

So a workspace can always override something a plugin ships, and your own
global config always wins over a plugin-declared MCP server of the same name.

### Trust

Plugins run code, so both trust gates apply:

- A **workspace** plugin (`.kritya/plugins/`) is only discovered once you've
  trusted that workspace — a plugin dropped into a cloned repo is exactly as
  capable as a hostile `.mcp.json`. User-global plugins are always discovered,
  same as `~/.kritya/config.json`. In headless/CI mode, workspace plugins
  require `--trust`.
- An MCP server a plugin declares still needs its own per-server approval on
  first use, and appears in `/mcp trust` like any other. Installing a plugin
  is not the same as approving every server it names.

Plugin-contributed slash commands additionally require workspace trust, even
for user-global plugins.

An `mcp.json` entry requesting the legacy HTTP+SSE transport is skipped with a
reason — kritya's MCP client speaks stdio and Streamable HTTP, and that older
transport is deprecated in the MCP spec itself.
