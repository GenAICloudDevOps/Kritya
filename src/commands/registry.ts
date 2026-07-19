import type { Agent } from "../agent/loop.js";
import type { CliConfig } from "../config/config.js";
import type { UndoStack } from "../undo/undo.js";
import type { ItemBody, Phase, TaskItem } from "../types.js";
import { expandCommand, type CustomCommand } from "./custom.js";

export interface CommandDef {
  name: string;
  description: string;
}

export const BUILTIN_COMMANDS: CommandDef[] = [
  { name: "/help", description: "show available commands" },
  { name: "/model", description: "pick a model, or /model <id> for any provider model ID" },
  {
    name: "/plan",
    description: "toggle plan mode (read-only): explore and propose before editing",
  },
  { name: "/diff", description: "show the cumulative git diff of this session's changes" },
  { name: "/redo", description: "reapply the change most recently undone" },
  { name: "/init", description: "scan the repo and generate a KRITYA.md project-memory file" },
  { name: "/web-search", description: "search the web: /web-search <query>" },
  { name: "/undo", description: "revert the file changes from the agent's last turn" },
  { name: "/commit", description: "have the agent stage and commit the current changes" },
  { name: "/compact", description: "summarize older conversation to free context space" },
  { name: "/clear", description: "start a fresh conversation" },
  { name: "/cost", description: "show token usage and estimated cost" },
  { name: "/exit", description: "leave" },
  { name: "/quit", description: "leave" },
];

export const HELP_TEXT = `Commands:
${BUILTIN_COMMANDS.map((c) => `  ${c.name.padEnd(14)} ${c.description}`).join("\n")}

Also: @path/to/file attaches a file to your message (with autocomplete).
@image.png attaches an image for vision-capable models.
Project memory: put standing instructions in KRITYA.md at your workspace root.
Keys: Esc cancels · Tab completes · Shift+Tab cycles normal/accept-edits/plan
mode · ↑/↓ recalls history · Ctrl+O toggles full tool output · Ctrl+C exits`;

/** Everything a command handler needs from the UI to do its work. */
export interface CommandContext {
  arg: string;
  raw: string;
  agent: Agent;
  workspace: string;
  config: CliConfig;
  undoStack: UndoStack;
  customCommands: CustomCommand[];
  mcpToolCount: number;
  planMode: boolean;
  acceptEdits: boolean;
  setAcceptEdits(v: boolean): void;
  addItem(item: ItemBody): void;
  setPhase(phase: Phase): void;
  setActivity(activity: string | null): void;
  setCtxPct(pct: number): void;
  setTasks(tasks: TaskItem[]): void;
  setPlanMode(next: boolean): void;
  setModelEverywhere(id: string): void;
  refreshFileList(): void;
  runAgent(text: string, images?: string[]): Promise<void>;
  runWebSearch(query: string): Promise<void>;
  expandMentions(text: string): string;
  costReport(): string;
  gitDiffStat(workspace: string): string | null;
  exit(): void;
}

export type CommandHandler = (ctx: CommandContext) => void | Promise<void>;

const handlers: Record<string, CommandHandler> = {
  "/help": (ctx) => {
    const customList = ctx.customCommands.length
      ? `\n\nCustom commands (from .kritya/commands/):\n${ctx.customCommands
          .map((c) => `  ${c.name.padEnd(14)} ${c.description}`)
          .join("\n")}`
      : "";
    const mcpNote = ctx.mcpToolCount > 0 ? `\n\n${ctx.mcpToolCount} MCP tool(s) loaded.` : "";
    ctx.addItem({ kind: "info", text: HELP_TEXT + customList + mcpNote });
  },
  "/model": (ctx) => {
    if (ctx.arg) ctx.setModelEverywhere(ctx.arg);
    else ctx.setPhase("model");
  },
  "/web-search": (ctx) => {
    if (!ctx.arg) {
      ctx.addItem({ kind: "info", text: "Usage: /web-search <query>" });
      return;
    }
    return ctx.runWebSearch(ctx.arg);
  },
  "/undo": (ctx) => {
    const result = ctx.undoStack.undo();
    if (result === null) {
      ctx.addItem({ kind: "info", text: "Nothing to undo." });
    } else {
      ctx.addItem({ kind: "info", text: `Undo: ${result}` });
      ctx.agent.addUserNote(`[I reverted your last file change via /undo: ${result}]`);
      ctx.refreshFileList();
    }
  },
  "/clear": (ctx) => {
    ctx.agent.reset();
    ctx.setTasks([]);
    ctx.addItem({ kind: "info", text: "Conversation cleared." });
  },
  "/cost": (ctx) => {
    ctx.addItem({ kind: "info", text: ctx.costReport() });
  },
  "/compact": (ctx) => {
    ctx.setPhase("working");
    ctx.setActivity("Compacting context…");
    return ctx.agent
      .compact()
      .then((note) => {
        ctx.addItem({ kind: "info", text: note });
        ctx.setCtxPct(Math.round(ctx.agent.contextUsage() * 100));
      })
      .catch((err) =>
        ctx.addItem({
          kind: "info",
          text: `Compaction failed: ${err instanceof Error ? err.message : String(err)}`,
        })
      )
      .finally(() => {
        ctx.setActivity(null);
        ctx.setPhase("input");
      });
  },
  "/init": (ctx) => {
    ctx.addItem({ kind: "user", text: "/init" });
    return ctx.runAgent(
      "Explore this repository (README, package/build files, src layout, test setup) and write " +
        "a concise KRITYA.md at the workspace root: what the project is, key commands " +
        "(build/test/run), architecture in 5-10 bullets, and conventions a coding agent must " +
        "follow when working here. Keep it under 60 lines."
    );
  },
  "/commit": (ctx) => {
    ctx.addItem({ kind: "user", text: "/commit" });
    return ctx.runAgent(
      "Review the current git changes (git status, git diff), stage the appropriate files, " +
        "and create a commit with a well-written conventional-commit message that describes " +
        "the change. Do not push. Show the final commit hash and message."
    );
  },
  "/plan": (ctx) => {
    const next = !ctx.planMode;
    ctx.setPlanMode(next);
    ctx.agent.planMode = next;
    // /plan and Shift+Tab's accept-edits mode are mutually exclusive; entering
    // one via either path must turn the other off.
    if (next && ctx.acceptEdits) {
      ctx.agent.acceptEdits = false;
      ctx.setAcceptEdits(false);
    }
    ctx.addItem({
      kind: "info",
      text: next
        ? "Plan mode ON — read-only. The agent will explore and propose a plan; edits and shell are blocked. Run /plan again to execute."
        : "Plan mode OFF — the agent can make changes again.",
    });
  },
  "/diff": (ctx) => {
    const d = ctx.gitDiffStat(ctx.workspace);
    ctx.addItem({ kind: "info", text: d || "No git changes (or not a git repo)." });
  },
  "/redo": (ctx) => {
    const result = ctx.undoStack.redo();
    if (result === null) {
      ctx.addItem({ kind: "info", text: "Nothing to redo." });
    } else {
      ctx.addItem({ kind: "info", text: `Redo: ${result}` });
      ctx.agent.addUserNote(`[I reapplied a previously undone change via /redo: ${result}]`);
      ctx.refreshFileList();
    }
  },
  "/exit": (ctx) => ctx.exit(),
  "/quit": (ctx) => ctx.exit(),
};

/** Dispatch a slash command: built-in handler, then custom commands, then "unknown". */
export function runCommand(cmd: string, ctx: CommandContext): void | Promise<void> {
  const handler = handlers[cmd];
  if (handler) return handler(ctx);

  const custom = ctx.customCommands.find((c) => c.name === cmd);
  if (custom) {
    ctx.addItem({ kind: "user", text: ctx.raw.trim() });
    return ctx.runAgent(expandCommand(custom.body, ctx.expandMentions(ctx.arg)));
  }

  ctx.addItem({ kind: "info", text: `Unknown command: ${cmd}. Try /help` });
}
