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

| Command               | What it does                                                            |
| --------------------- | ----------------------------------------------------------------------- |
| `/model`              | interactive model picker (`/model <id>` sets any model ID directly)     |
| `/plan`               | toggle plan mode (read-only): explore and propose before making changes |
| `/diff`               | show the cumulative git diff of this session's changes                  |
| `/init`               | scan the repo and generate a `KRITYA.md` project-memory file            |
| `/commit`             | have the agent review, stage, and commit the current git changes        |
| `/web-search <query>` | search the web via Tavily; results are shown and added to context       |
| `/undo`               | revert all file changes from the agent's last turn                      |
| `/redo`               | reapply the change most recently undone                                 |
| `/compact`            | summarize older conversation to free context space                      |
| `/clear`              | start a fresh conversation                                              |
| `/cost`               | token usage and estimated $ (see Pricing below)                         |
| `/help`               | command list                                                            |
| `/exit`               | quit                                                                    |

Custom `/commands` you define (see below) also appear here.

`Esc` cancels a running request. `↑/↓` recalls input history. `Ctrl+O` toggles
full tool output. `Ctrl+C` exits.

### More features

- **Plan mode** (`/plan`) — a read-only mode where the agent explores and
  proposes a step-by-step plan; writes, edits, and shell are blocked until you
  run `/plan` again. Great for unfamiliar repositories.
- **Subagents** — the agent can dispatch a focused, read-only investigation to a
  fresh context (`spawn_agent`) that returns only its findings, keeping the main
  conversation lean on big searches.
- **Image attachments** — `@screenshot.png` sends the image to vision-capable
  models alongside your message.
- **Undo / redo** — `/undo` reverts the last turn's file changes; `/redo`
  reapplies them. Undo is multi-level.
- **Steer mid-run** — type while the agent is working and press Enter; your
  message is queued and absorbed before its next step (no need to interrupt).
- **Auto-compaction** — when the conversation nears the model's context window
  (80% of `contextWindow`, default 120k tokens), older turns are summarized
  automatically; the statusline shows current usage as `ctx N%`.
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
- **Sub-task checklist** — for multi-step requests the agent plans first and shows
  a live ☐/◐/☑ checklist as it works.
- **Diff preview** — write/edit permission prompts show a red/green line diff of
  exactly what will change before you approve; code blocks in answers are
  syntax-highlighted.
- **Session search** — `kritya -r` lists past sessions by title (first message);
  type to filter.
- **Web search tool** — besides `/web-search`, the agent can search on its own when
  it needs current information (needs `TAVILY_API_KEY` in `.env`, free at
  tavily.com). Web content is delimited as untrusted so pages can't inject
  instructions into the agent.

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
  "contextWindow": 120000
}
```

`pricing` is optional (USD per 1M tokens per model). When set, `/cost` and the
statusline show estimated dollars alongside token counts.

`customModels` entries show up in the `/model` picker. Model IDs change over
time — pick an agent-capable (tool-calling) model for best results; chat-only
models will answer questions but can't edit files. `maxSteps` (default 40) caps
model round-trips per request. `contextWindow` overrides the per-model default.

Sessions are stored as JSONL under `~/.kritya/sessions/` and reloaded with
`kritya -c`.

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
agent by launching servers over stdio:

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."]
    }
  }
}
```

Their tools appear as `mcp_<server>_<tool>` and their output is treated as
untrusted content. A server that fails to start is skipped with a warning.

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
