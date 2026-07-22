import path from "node:path";
import type { Agent } from "../agent/loop.js";
import { AuditLog, summarizeAudit } from "../audit/audit.js";
import { runMcpCommand } from "./mcpCommand.js";
import { listProviders, type CliConfig } from "../config/config.js";
import type { UndoStack } from "../undo/undo.js";
import type { ItemBody, Phase, TaskItem } from "../types.js";
import { expandCommand, type CustomCommand } from "./custom.js";
import { loadProjectState, phasePrompt, saveProjectState, slugify } from "../agent/workflow.js";

export interface CommandDef {
  name: string;
  description: string;
}

export const BUILTIN_COMMANDS: CommandDef[] = [
  { name: "/help", description: "show available commands" },
  { name: "/model", description: "pick a model, or /model <id> for any provider model ID" },
  {
    name: "/provider",
    description: "list providers, or /provider <name> to switch mid-session (keeps history)",
  },
  {
    name: "/brainstorm",
    description: "start a new-project workflow: /brainstorm <idea> (brainstorm→plan→spec→build)",
  },
  {
    name: "/plan",
    description: "toggle plan mode (read-only); in a project workflow, run the plan phase",
  },
  { name: "/spec", description: "project workflow: write the spec from the approved plan" },
  { name: "/build", description: "project workflow: implement the project from the spec" },
  { name: "/diff", description: "show the cumulative git diff of this session's changes" },
  { name: "/redo", description: "reapply the change most recently undone" },
  { name: "/init", description: "scan the repo and generate a KRITYA.md project-memory file" },
  { name: "/web-search", description: "search the web: /web-search <query>" },
  {
    name: "/mcp",
    description: "MCP servers: status, /mcp add|remove <name>, /mcp login|logout <name>",
  },
  { name: "/undo", description: "revert the file changes from the agent's last turn" },
  {
    name: "/checkpoint",
    description: "save a named point: /checkpoint <name> (no name lists saved ones)",
  },
  {
    name: "/rewind",
    description: "rewind the conversation and files to a checkpoint: /rewind <name>",
  },
  { name: "/commit", description: "have the agent stage and commit the current changes" },
  { name: "/compact", description: "summarize older conversation to free context space" },
  { name: "/clear", description: "start a fresh conversation" },
  { name: "/cost", description: "show token usage and estimated cost" },
  {
    name: "/audit",
    description: "show this session's permission decisions and verify the audit log's chain",
  },
  {
    name: "/budget",
    description: "show session token budget, /budget reset, or /budget <number> to set it",
  },
  {
    name: "/kill",
    description: "emergency stop: /kill [reason] halts everything · /kill off releases (Ctrl+K)",
  },
  { name: "/exit", description: "leave" },
  { name: "/quit", description: "leave" },
];

export const HELP_TEXT = `Commands:
${BUILTIN_COMMANDS.map((c) => `  ${c.name.padEnd(14)} ${c.description}`).join("\n")}

Also: @path/to/file attaches a file to your message (with autocomplete).
@image.png attaches an image for vision-capable models.
Project memory: put standing instructions in KRITYA.md at your workspace root.
Keys: Esc cancels · Tab completes · Shift+Tab cycles normal/accept-edits/plan
mode · ↑/↓ recalls history · Ctrl+O toggles full tool output · Ctrl+K is the
kill switch (stops everything until /kill off) · Ctrl+C exits`;

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
  tokenBudget: number;
  budgetPct: number;
  budgetUsed: number;
  budgetStopped: boolean;
  resetBudget(): void;
  setBudgetLimit(n: number): void;
  addItem(item: ItemBody): void;
  setPhase(phase: Phase): void;
  setActivity(activity: string | null): void;
  setCtxPct(pct: number): void;
  setTasks(tasks: TaskItem[]): void;
  setPlanMode(next: boolean): void;
  /** True while the session's kill switch is engaged. */
  killed: boolean;
  killReason?: string;
  engageKill(reason?: string): void;
  releaseKill(): void;
  setModelEverywhere(id: string): void;
  provider: string;
  setProviderEverywhere(name: string): void;
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
  "/provider": (ctx) => {
    if (!ctx.arg) {
      const lines = listProviders(ctx.config).map((p) => {
        const marker = p.name === ctx.provider ? "*" : " ";
        const note = p.hasKey ? "" : "  (no API key configured)";
        return `  ${marker} ${p.name}${note}`;
      });
      ctx.addItem({
        kind: "info",
        text:
          `Providers (* = active):\n${lines.join("\n")}\n\n` +
          `Switch with /provider <name> — conversation history is kept. ` +
          `If a request keeps failing (429/5xx after retries), switch to any provider marked with a key.`,
      });
      return;
    }
    ctx.setProviderEverywhere(ctx.arg);
  },
  "/mcp": (ctx) => {
    // Bare /mcp is read-only and stays available while the kill switch is
    // engaged (see ALLOWED_WHILE_KILLED); its subcommands connect servers,
    // write config, and mint tokens, so they are not.
    if (ctx.killed && ctx.arg.trim()) {
      ctx.addItem({
        kind: "info",
        text:
          `⛔ Kill switch ACTIVE${ctx.killReason ? ` — ${ctx.killReason}` : ""}. ` +
          `/mcp ${ctx.arg.trim().split(/\s+/)[0]} is blocked; plain /mcp still works. Release it with /kill off.`,
      });
      return;
    }
    return runMcpCommand(ctx);
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
  "/checkpoint": (ctx) => {
    const name = ctx.arg.trim();
    if (!name) {
      const list = ctx.agent.listCheckpoints();
      if (!list.length) {
        ctx.addItem({
          kind: "info",
          text: "No checkpoints yet. Save one with /checkpoint <name>.",
        });
        return;
      }
      const lines = list.map((c) => `  ${c.name}  (${new Date(c.createdAt).toLocaleTimeString()})`);
      ctx.addItem({
        kind: "info",
        text: `Checkpoints:\n${lines.join("\n")}\n\nRewind to one with /rewind <name>.`,
      });
      return;
    }
    ctx.agent.saveCheckpoint(name, ctx.undoStack.currentTurn());
    ctx.addItem({
      kind: "info",
      text: `Saved checkpoint "${name}". Rewind here later with /rewind ${name}.`,
    });
  },
  "/rewind": (ctx) => {
    const name = ctx.arg.trim();
    if (!name) {
      ctx.addItem({
        kind: "info",
        text: "Usage: /rewind <name>. List saved points with /checkpoint.",
      });
      return;
    }
    const cp = ctx.agent.getCheckpoint(name);
    if (!cp) {
      ctx.addItem({
        kind: "info",
        text: `No checkpoint named "${name}". See /checkpoint for the list.`,
      });
      return;
    }
    // Roll files back first, then trim the conversation to the same point.
    const fileResult = ctx.undoStack.rewindTo(cp.undoTurn);
    ctx.agent.truncateHistory(cp.historyLength);
    const filePart = fileResult ? `\n${fileResult}` : "\nNo file changes to roll back.";
    ctx.addItem({ kind: "info", text: `Rewound to "${name}".${filePart}` });
    ctx.refreshFileList();
  },
  "/clear": (ctx) => {
    ctx.agent.reset();
    ctx.setTasks([]);
    ctx.addItem({ kind: "info", text: "Conversation cleared." });
  },
  "/cost": (ctx) => {
    ctx.addItem({ kind: "info", text: ctx.costReport() });
  },
  "/audit": (ctx) => {
    const audit = ctx.agent.audit;
    if (!audit) {
      ctx.addItem({
        kind: "info",
        text: "Auditing is off for this session (KRITYA_AUDIT=off).",
      });
      return;
    }
    const records = AuditLog.readRecords(audit.path);
    if (!records.length) {
      ctx.addItem({ kind: "info", text: `No audit records yet.\nLog: ${audit.path}` });
      return;
    }

    const fmt = (m: Partial<Record<string, number>>) =>
      Object.entries(m)
        .sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))
        .map(([k, v]) => `${k}: ${v}`)
        .join(", ") || "(none)";

    const verify = AuditLog.verify(audit.path);
    const chainLine = verify.ok
      ? `chain verified — ${verify.records} record(s)`
      : verify.reason === "unreadable"
        ? "chain check FAILED — log file could not be read"
        : `chain check FAILED — broken at record ${verify.line}`;

    const s = summarizeAudit(records);
    const latencyLine =
      s.durationMsP50 || s.waitMsP50
        ? `Tool latency: p50 ${s.durationMsP50}ms / p95 ${s.durationMsP95}ms — ` +
          `permission wait: p50 ${s.waitMsP50}ms / p95 ${s.waitMsP95}ms\n`
        : "";

    ctx.addItem({
      kind: "info",
      text:
        `Audit log: ${audit.path}\n` +
        `${chainLine}\n\n` +
        `Permission decisions by source: ${fmt(s.permissionsBySource)}\n` +
        `Tool outcomes: ${fmt(s.toolCallsByOutcome)}\n` +
        latencyLine +
        `\nFull history: kritya audit --show ${path.basename(audit.path)}`,
    });
  },
  "/budget": (ctx) => {
    const arg = ctx.arg.trim().toLowerCase();
    if (!arg) {
      const status = ctx.budgetStopped ? " — STOPPED" : "";
      ctx.addItem({
        kind: "info",
        text:
          `Token budget: ${ctx.budgetUsed.toLocaleString()} / ${ctx.tokenBudget.toLocaleString()} ` +
          `(${ctx.budgetPct}%)${status}\nUsage: /budget reset · /budget <number>`,
      });
      return;
    }
    if (arg === "reset") {
      ctx.resetBudget();
      return;
    }
    const n = Number(arg.replace(/[,_]/g, ""));
    if (!Number.isFinite(n) || n <= 0) {
      ctx.addItem({
        kind: "info",
        text: `Invalid budget "${ctx.arg}". Use /budget <number>, e.g. /budget 2000000.`,
      });
      return;
    }
    ctx.setBudgetLimit(Math.round(n));
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
  "/brainstorm": (ctx) => {
    const idea = ctx.arg.trim();
    const existing = loadProjectState(ctx.workspace);
    if (!existing && !idea) {
      ctx.addItem({
        kind: "info",
        text: "Usage: /brainstorm <your project idea>. Starts the brainstorm → plan → spec → build workflow.",
      });
      return;
    }
    const name = existing?.name ?? slugify(idea);
    saveProjectState(ctx.workspace, name, "brainstorm");
    // Brainstorming writes docs freely, so make sure plan mode isn't left on.
    if (ctx.planMode) {
      ctx.agent.planMode = false;
      ctx.setPlanMode(false);
    }
    ctx.addItem({ kind: "user", text: ctx.raw.trim() });
    return ctx.runAgent(phasePrompt(name, "brainstorm", idea));
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
    // In an active project workflow, turning plan mode ON runs the plan phase:
    // read-only architecture design that still writes docs/<name>/plan.md.
    const project = loadProjectState(ctx.workspace);
    if (next && project) {
      saveProjectState(ctx.workspace, project.name, "plan");
      ctx.addItem({
        kind: "info",
        text: `Plan mode ON — plan phase for "${project.name}". The agent will design the architecture and write docs/${project.name}/plan.md, then stop for your approval. Run /spec to continue.`,
      });
      ctx.addItem({ kind: "user", text: "/plan" });
      return ctx.runAgent(phasePrompt(project.name, "plan", ctx.arg));
    }
    ctx.addItem({
      kind: "info",
      text: next
        ? "Plan mode ON — read-only. The agent will explore and propose a plan; edits and shell are blocked. Run /plan again to execute."
        : "Plan mode OFF — the agent can make changes again.",
    });
    return;
  },
  "/spec": (ctx) => {
    const project = loadProjectState(ctx.workspace);
    if (!project) {
      ctx.addItem({
        kind: "info",
        text: "No active project workflow. Start one with /brainstorm <idea>.",
      });
      return;
    }
    if (ctx.planMode) {
      ctx.agent.planMode = false;
      ctx.setPlanMode(false);
    }
    saveProjectState(ctx.workspace, project.name, "spec");
    ctx.addItem({ kind: "user", text: ctx.raw.trim() });
    return ctx.runAgent(phasePrompt(project.name, "spec", ctx.arg));
  },
  "/build": (ctx) => {
    const project = loadProjectState(ctx.workspace);
    if (!project) {
      ctx.addItem({
        kind: "info",
        text: "No active project workflow. Start one with /brainstorm <idea>.",
      });
      return;
    }
    if (ctx.planMode) {
      ctx.agent.planMode = false;
      ctx.setPlanMode(false);
    }
    saveProjectState(ctx.workspace, project.name, "build");
    ctx.addItem({ kind: "user", text: ctx.raw.trim() });
    return ctx.runAgent(phasePrompt(project.name, "build", ctx.arg));
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
  /**
   * The emergency stop. `/kill off` (or release/clear/resume) is the only way
   * back; anything else is treated as the reason it was pulled, which is what
   * shows up in the audit log and on every subsequent refusal.
   */
  "/kill": (ctx) => {
    const arg = ctx.arg.trim();
    const word = arg.toLowerCase();
    if (word === "off" || word === "release" || word === "clear" || word === "resume") {
      ctx.releaseKill();
      return;
    }
    if (word === "status") {
      ctx.addItem({
        kind: "info",
        text: ctx.killed
          ? `⛔ Kill switch ACTIVE${ctx.killReason ? ` — ${ctx.killReason}` : ""}. Release it with /kill off.`
          : "Kill switch is off. Engage it with /kill [reason], or Ctrl+K from anywhere.",
      });
      return;
    }
    if (ctx.killed) {
      ctx.addItem({
        kind: "info",
        text: `⛔ Kill switch is already ACTIVE${ctx.killReason ? ` — ${ctx.killReason}` : ""}. Release it with /kill off.`,
      });
      return;
    }
    ctx.engageKill(arg || undefined);
  },
  "/exit": (ctx) => ctx.exit(),
  "/quit": (ctx) => ctx.exit(),
};

/**
 * Commands that still work while the kill switch is engaged: releasing it,
 * leaving, and reading back what happened. Everything else — anything that
 * drives the agent, spends tokens, or touches the workspace — is refused,
 * including custom commands (which are just prompts in disguise).
 */
const ALLOWED_WHILE_KILLED = new Set([
  "/kill",
  "/help",
  "/exit",
  "/quit",
  "/audit",
  "/cost",
  "/diff",
  "/budget",
  "/mcp",
  "/checkpoint",
]);

/** Dispatch a slash command: built-in handler, then custom commands, then "unknown". */
export function runCommand(cmd: string, ctx: CommandContext): void | Promise<void> {
  if (ctx.killed && !ALLOWED_WHILE_KILLED.has(cmd)) {
    ctx.addItem({
      kind: "info",
      text:
        `⛔ Kill switch ACTIVE${ctx.killReason ? ` — ${ctx.killReason}` : ""}. ` +
        `${cmd} is blocked. Release it with /kill off.`,
    });
    return;
  }

  const handler = handlers[cmd];
  if (handler) return handler(ctx);

  const custom = ctx.customCommands.find((c) => c.name === cmd);
  if (custom) {
    ctx.addItem({ kind: "user", text: ctx.raw.trim() });
    return ctx.runAgent(expandCommand(custom.body, ctx.expandMentions(ctx.arg)));
  }

  ctx.addItem({ kind: "info", text: `Unknown command: ${cmd}. Try /help` });
}
