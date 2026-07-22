# kritya — design

Date: 2026-07-16 · Status: implemented (v0.1.0)

## Goal

An interactive coding agent for the terminal, invoked as
`kritya .`, running on Linux and Windows, using NVIDIA build.nvidia.com's
OpenAI-compatible endpoint (`https://integrate.api.nvidia.com/v1`) with models
such as Qwen3 Coder, Kimi K2, DeepSeek, GLM, and Nemotron.

## Decisions

- **Scope**: full agent — agentic tool loop, session persistence/resume, slash
  commands, permission prompts, token usage tracking.
- **Stack**: TypeScript/Node (ESM), Ink 5 (React terminal UI), `openai` SDK
  pointed at the NVIDIA base URL, `fast-glob`. Distributed via npm (`bin: kritya`).
- **Models**: curated list of known tool-calling models with `/model` picker;
  any model ID settable via `/model <id>`, `--model`, or config `customModels`.
- **Approach chosen**: hand-rolled agent loop + direct SDK client (no LangChain
  or agent framework) for full control over NVIDIA model quirks.

## Architecture

```
src/
├── index.tsx        entry: arg parsing, key check, dependency wiring, Ink mount
├── types.ts         ToolDef, ChatMessage, AgentHandlers contracts
├── config/          ~/.kritya/config.json + curated model registry
├── provider/        NvidiaClient: streaming chat, tool-call delta accumulation,
│                    reasoning_content passthrough, usage capture
├── agent/           Agent.runTurn loop (max 40 iterations) + system prompt
├── tools/           read_file, write_file, edit_file, shell, list_dir, glob, grep
├── permissions/     PermissionManager: reads free; mutations prompt yes/always/no
├── session/         JSONL transcripts under ~/.kritya/sessions/<sha1(ws)>;
│                    --continue reloads the latest
└── ui/              App (phases: input/working/permission/model), Markdown,
                     Spinner, SelectList, PermissionPrompt, ModelPicker
```

## Key behaviors

- Agent loop: user msg → model (streamed) → execute tool calls (permission-gated)
  → tool results back to model → repeat until a turn has no tool calls.
- Tool results truncated at 30k chars; tool errors returned to the model as text
  so it can self-correct; denied permissions returned as an instruction not to retry.
- File tools confined to the workspace root (`resolveSafe`); `shell` runs with
  cwd=workspace, 2-minute timeout, and always prompts (unless "always" granted).
- Esc aborts the in-flight request via AbortController.
- Windows: `shell` uses cmd via `child_process.exec`; paths via `node:path`;
  test script uses Node-expanded globs.

## Testing

`node --test` unit tests cover path confinement, edit uniqueness semantics,
write/read roundtrip, grep output format, and permission policy. UI mount
verified under a pseudo-TTY. Live end-to-end requires `NVIDIA_API_KEY`.
