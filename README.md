# code-cli

A lean, Claude Code-style coding agent for your terminal, powered by models on
[build.nvidia.com](https://build.nvidia.com) (Qwen3 Coder, Kimi K2, DeepSeek, GLM,
Nemotron, ...). Works on Linux, macOS, and Windows.

```
cd your-project
code-cli .
```

The agent can read, write, and edit files, search code, and run shell commands —
autonomously looping until your request is done. Anything that mutates state
(writes, edits, shell commands) asks for your permission first.

## Setup

1. Get a free API key at [build.nvidia.com](https://build.nvidia.com) (click any
   model → "Get API Key").
2. Set it (any one of these):
   - Put `NVIDIA_API_KEY=nvapi-...` in a `.env` file — checked in the workspace
     you launch in, the directory you run from, and `~/.code-cli/.env`
   - Linux/macOS: `export NVIDIA_API_KEY=nvapi-...`
   - Windows: `setx NVIDIA_API_KEY nvapi-...` (then open a new terminal)
3. Install and run:

```bash
npm install        # from this repo
npm run build
npm link           # puts `code-cli` on your PATH
cd ~/some-project
code-cli .
```

## Usage

```
code-cli [directory] [options]

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
| `/web-search <query>` | search the web via Tavily; results are shown and added to context |
| `/undo` | revert the last file change the agent made (up to 50 steps) |
| `/clear` | start a fresh conversation |
| `/cost` | token usage and estimated $ (see Pricing below) |
| `/help` | command list |
| `/exit` | quit |

`Esc` cancels a running request. `Ctrl+C` exits.

### More features

- **@ file mentions** — type `@` in your message to autocomplete a file path
  (↑↓ select, Tab/Enter attach); the file's content is sent along with your message.
- **Project memory** — create a `CODECLI.md` in your workspace root with standing
  instructions ("always use TypeScript", "tests live in /tests"); the agent reads
  it every request.
- **Sub-task checklist** — for multi-step requests the agent plans first and shows
  a live ☐/◐/☑ checklist as it works.
- **Diff preview** — write/edit permission prompts show a red/green line diff of
  exactly what will change before you approve.
- **Web search tool** — besides `/web-search`, the agent can search on its own when
  it needs current information (needs `TAVILY_API_KEY` in `.env`, free at tavily.com).

## Permissions

- Read-only tools (`read_file`, `list_dir`, `glob`, `grep`) run without asking.
- Mutating tools (`write_file`, `edit_file`, `shell`) prompt: **Yes / Yes, always
  for this session / No**.
- File tools are confined to the workspace directory you launched in.

## Configuration

`~/.code-cli/config.json`:

```json
{
  "apiKey": "nvapi-...",
  "model": "nvidia/nemotron-3-super-120b-a12b",
  "baseUrl": "https://integrate.api.nvidia.com/v1",
  "customModels": [{ "id": "some-org/new-model", "label": "New Model" }],
  "pricing": {
    "nvidia/nemotron-3-super-120b-a12b": { "input": 0.6, "output": 2.4 }
  }
}
```

`pricing` is optional (USD per 1M tokens per model). When set, `/cost` and the
statusline show estimated dollars alongside token counts.

`customModels` entries show up in the `/model` picker. Model IDs on the NVIDIA
catalog change over time — pick an agent-capable (tool-calling) model for best
results; chat-only models will answer questions but can't edit files.

Sessions are stored as JSONL under `~/.code-cli/sessions/` and reloaded with
`code-cli -c`.

## Development

```bash
npm run dev     # run from source (tsx)
npm run build   # compile to dist/
npm test        # build + unit tests
```

Architecture: `src/provider` (NVIDIA OpenAI-compatible streaming client) →
`src/agent` (the tool-call loop + system prompt) → `src/tools` (7 plain-object
tools) → `src/ui` (Ink/React terminal UI), with `src/permissions` and
`src/session` supporting. See `docs/superpowers/specs/` for the design doc.
