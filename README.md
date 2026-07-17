# kritya

A lean, Claude Code-style coding agent for your terminal, powered by models on
[build.nvidia.com](https://build.nvidia.com) (Qwen3 Coder, Kimi K2, DeepSeek, GLM,
Nemotron, ...). Works on Linux, macOS, and Windows.

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

  -c, --continue     resume the most recent session for this directory
  -r, --resume       pick a past session from a list
  -m, --model <id>   use any model ID from build.nvidia.com
  -h, --help         help
  -v, --version      version
```

In-session commands (type `/` to see them with autocomplete; letters filter the list):

| Command | What it does |
| --- | --- |
| `/model` | interactive model picker (`/model <id>` sets any NVIDIA model ID directly) |
| `/init` | scan the repo and generate a `KRITYA.md` project-memory file |
| `/commit` | have the agent review, stage, and commit the current git changes |
| `/web-search <query>` | search the web via Tavily; results are shown and added to context |
| `/undo` | revert all file changes from the agent's last turn |
| `/compact` | summarize older conversation to free context space |
| `/clear` | start a fresh conversation |
| `/cost` | token usage and estimated $ (see Pricing below) |
| `/help` | command list |
| `/exit` | quit |

`Esc` cancels a running request. `Ctrl+C` exits.

### More features

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
  every request. `CODECLI.md` is still honored as a fallback.
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
matching the pattern, where `*` is a wildcard. Matching is anchored —
`shell(npm test)` does **not** allow `npm test && something-else`.

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

`customModels` entries show up in the `/model` picker. Model IDs on the NVIDIA
catalog change over time — pick an agent-capable (tool-calling) model for best
results; chat-only models will answer questions but can't edit files.

Sessions are stored as JSONL under `~/.kritya/sessions/` and reloaded with
`kritya -c`.

## Development

```bash
npm run dev     # run from source (tsx)
npm run build   # compile to dist/
npm test        # build + unit tests
```

Architecture: `src/provider` (NVIDIA OpenAI-compatible streaming client) →
`src/agent` (the tool-call loop, compaction, system prompt) → `src/tools`
(plain-object tools) → `src/ui` (Ink/React terminal UI), with
`src/permissions`, `src/session`, `src/shell` (background processes), and
`src/git` supporting. See `docs/superpowers/specs/` for the design doc.
