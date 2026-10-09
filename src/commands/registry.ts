import fs from "node:fs";
import path from "node:path";
import type { Agent } from "../agent/loop.js";
import { resolveExportPath, transcriptToMarkdown } from "../session/export.js";
import { AuditLog, summarizeAudit } from "../audit/audit.js";
import { runMcpCommand } from "./mcpCommand.js";
import { mcpPrompts } from "../mcp/client.js";
import { scanSkillsDetailed, skillsDir, userSkillsDir } from "../agent/skills.js";
import {
  pluginsDir,
  pluginSkillsRoots,
  scanPlugins,
  scanPluginsDetailed,
  userPluginsDir,
} from "../plugins/discover.js";
import { scanPluginMcpServers } from "../plugins/mcp.js";
import { listProviders, type CliConfig } from "../config/config.js";
import type { UndoStack } from "../undo/undo.js";
import type { ItemBody, Phase, TaskItem } from "../types.js";
import { expandCommand, type CustomCommand } from "./custom.js";
import { recordCommandUse } from "../ui/recentCommands.js";
import {
  artifactExists,
  artifactPath,
  BACK_COMMAND,
  clearProjectState,
  DEFAULT_GATES,
  loadProjectState,
  MAX_REVISITS,
  nextPhase,
  parseIdea,
  parsePhase,
  phaseBlocker,
  phaseIndex,
  phasePrompt,
  planRun,
  renameProject,
  revisitsRemaining,
  saveProjectState,
  shouldStopAfter,
  staleArtifacts,
  takeRevisit,
  PHASE_COMMAND,
  PHASE_ORDER,
  PHASE_SUMMARY,
  slugify,
  type FlowRunOptions,
  type WorkflowPhase,
} from "../agent/workflow.js";

export interface CommandDef {
  name: string;
  description: string;
  /** Menu grouping shown when typing `/` — see App.tsx's suggestion render. Commands with no category (custom/MCP-contributed) fall under their own group there. */
  category?: string;
}

const WORKFLOW = "Workflow";
const SESSION = "Session";
const SAFETY = "Safety & limits";
const INFO = "Info";

export const BUILTIN_COMMANDS: CommandDef[] = [
  {
    name: "/flow",
    description:
      "run the next workflow phase, or a stretch of them: /flow [--until <phase>|--auto]",
    category: WORKFLOW,
  },
  {
    name: "/flow-brainstorm",
    description:
      "start a new-project workflow: /flow-brainstorm <idea> (brainstorm→spec→plan→build→review→fix→ship)",
    category: WORKFLOW,
  },
  {
    name: "/flow-spec",
    description: "project workflow: write the spec from the approved brainstorm",
    category: WORKFLOW,
  },
  {
    name: "/flow-plan",
    description: "project workflow: plan from the spec (read-only)",
    category: WORKFLOW,
  },
  {
    name: "/flow-build",
    description: "project workflow: implement the plan, then review and fix it",
    category: WORKFLOW,
  },
  {
    name: "/flow-review",
    description: "project workflow: spec-compliance and security review",
    category: WORKFLOW,
  },
  {
    name: "/flow-fix",
    description: "project workflow: fix the review's findings, re-verified",
    category: WORKFLOW,
  },
  {
    name: "/flow-ship",
    description: "project workflow: run the tests and write the handover summary",
    category: WORKFLOW,
  },
  {
    name: "/flow-back",
    description:
      "rewind to a phase and re-run everything after it, when a finding belongs upstream",
    category: WORKFLOW,
  },
  {
    name: "/project",
    description: "workflow status · /project goto <phase> · rename <name> · clear",
    category: WORKFLOW,
  },
  {
    name: "/model",
    description: "pick a model, or /model <id> for any provider model ID",
    category: SESSION,
  },
  {
    name: "/provider",
    description:
      "list providers, or /provider <name> to switch mid-session (keeps history); add --default to persist",
    category: SESSION,
  },
  {
    name: "/diff",
    description: "show the cumulative git diff of this session's changes",
    category: SESSION,
  },
  {
    name: "/init",
    description: "scan the repo and generate a KRITYA.md project-memory file",
    category: SESSION,
  },
  { name: "/web-search", description: "search the web: /web-search <query>", category: SESSION },
  {
    name: "/commit",
    description: "have the agent stage and commit the current changes",
    category: SESSION,
  },
  {
    name: "/compact",
    description: "summarize older conversation to free context space",
    category: SESSION,
  },
  { name: "/clear", description: "start a fresh conversation", category: SESSION },
  {
    name: "/undo",
    description: "revert the file changes from the agent's last turn",
    category: SESSION,
  },
  { name: "/redo", description: "reapply the change most recently undone", category: SESSION },
  {
    name: "/checkpoint",
    description: "save a named point: /checkpoint <name> (no name lists saved ones)",
    category: SESSION,
  },
  {
    name: "/rewind",
    description: "rewind the conversation and files to a checkpoint: /rewind <name>",
    category: SESSION,
  },
  {
    name: "/rename",
    description: "rename this session: /rename <name> (no name shows the current one)",
    category: SESSION,
  },
  {
    name: "/export",
    description:
      "export the transcript to markdown: /export [path] (default: kritya-<name>-<stamp>.md)",
    category: SESSION,
  },
  {
    name: "/plan",
    description: "toggle plan mode (read-only): /plan, /plan on, /plan off",
    category: SAFETY,
  },
  {
    name: "/kill",
    description: "emergency stop: /kill [reason] halts everything · /kill off releases (Ctrl+K)",
    category: SAFETY,
  },
  {
    name: "/audit",
    description: "show this session's permission decisions and verify the audit log's chain",
    category: SAFETY,
  },
  {
    name: "/budget",
    description: "show session token budget, /budget reset, or /budget <number> to set it",
    category: SAFETY,
  },
  { name: "/cost", description: "show token usage and estimated cost", category: SAFETY },
  {
    name: "/status",
    description: "show context/budget/token/task detail left off the status line",
    category: SAFETY,
  },
  { name: "/help", description: "show available commands", category: INFO },
  {
    name: "/skills",
    description: "list discovered skills (project + user-global) and why any were skipped",
    category: INFO,
  },
  {
    name: "/plugins",
    description: "list discovered Agent Plugins, what each contributes, and why any were skipped",
    category: INFO,
  },
  {
    name: "/mcp",
    description: "MCP servers: status, /mcp add|remove <name>, /mcp login|logout <name>",
    category: INFO,
  },
  { name: "/exit", description: "leave", category: INFO },
  { name: "/quit", description: "leave", category: INFO },
];

export const HELP_TEXT = `Commands:
${BUILTIN_COMMANDS.map((c) => `  ${c.name.padEnd(14)} ${c.description}`).join("\n")}

Also: @path/to/file attaches a file to your message (with autocomplete).
@image.png attaches an image for vision-capable models.
@mcp:server/name attaches a document an MCP server offers.
MCP servers can also contribute their own /server-prompt commands.
Project memory: put standing instructions in KRITYA.md at your workspace root.
Project workflow: /flow-brainstorm <idea> starts one; /flow runs the next phase.
It stops for your approval after ${DEFAULT_GATES.join(", ")}, then runs the rest
through to ship. --auto for no stops · --until <phase> to stop early · --fast to
merge brainstorm and spec · ${BACK_COMMAND} <phase> when a finding belongs upstream.
Keys: Esc cancels · Tab completes · Shift+Tab cycles normal/accept-edits/dry-run
mode · ↑/↓ recalls history · Ctrl+R searches history · Ctrl+P opens the command
palette · Ctrl+B copies the last code block · Ctrl+O toggles full tool output ·
Ctrl+K is the kill switch (stops everything until /kill off) · Ctrl+C exits`;

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
  bypassMode: boolean;
  setBypassMode(v: boolean): void;
  tokenBudget: number;
  budgetPct: number;
  budgetUsed: number;
  budgetStopped: boolean;
  resetBudget(): void;
  setBudgetLimit(n: number): void;
  addItem(item: ItemBody): void;
  /** Empty the visible transcript. The agent's conversation history is
   *  separate (see Agent.reset()) — clear both for a true fresh start. */
  clearItems(): void;
  setPhase(phase: Phase): void;
  setActivity(activity: string | null): void;
  /** The workflow phase driving the current turn: labels the spinner, and tells
   *  the turn's teardown which phase to announce the follow-up command for. */
  setRunningPhase(phase: WorkflowPhase | null): void;
  /** True while one command is running several workflow phases back to back.
   *  The turn's teardown stays quiet then: announcing "next: /flow-review" for a
   *  phase the chain is about to run itself is noise, and the chain prints its
   *  own progress. */
  setChained(chained: boolean): void;
  /** Re-read the workflow pointer so the statusline reflects a phase change. */
  refreshWorkflow(): void;
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
  model: string;
  setProviderEverywhere(name: string, persist?: boolean): void;
  refreshFileList(): void;
  runAgent(text: string, images?: string[]): Promise<void>;
  runWebSearch(query: string): Promise<void>;
  expandMentions(text: string): Promise<string>;
  costReport(): string;
  /** The context/budget/token/task detail left off the always-visible status line — see /status. */
  statusReport(): string;
  gitDiffStat(workspace: string): string | null;
  exit(): void;
}

export type CommandHandler = (ctx: CommandContext) => void | Promise<void>;

/**
 * A phase boundary is the one place compaction is unambiguously safe: the
 * phase that just ended wrote its conclusions to a durable artifact on disk,
 * so the transcript that produced them is redundant. Compacting here is what
 * keeps a seven-phase project from dragging every phase's exploration into the
 * next phase's context window.
 */
async function compactAtPhaseBoundary(ctx: CommandContext, phase: WorkflowPhase): Promise<void> {
  // Compaction is a full model call, so the UI has to show it. Without this the
  // terminal sits silent — the spinner only renders while the phase is
  // "working", and the elapsed-time counter is gated the same way.
  ctx.setPhase("working");
  ctx.setActivity(`Compacting before the ${phase} phase…`);
  try {
    const note = await ctx.agent.compact();
    if (/^nothing to compact/i.test(note)) return;
    ctx.addItem({ kind: "info", text: note });
    ctx.setCtxPct(Math.round(ctx.agent.contextUsage() * 100));
  } catch {
    // Compaction is a cost optimization. Failing it must never cost the user
    // their phase — the phase runs either way.
  } finally {
    // runAgent takes the phase from here; only the label needs clearing, or it
    // would outlive the compaction it describes.
    ctx.setActivity(null);
  }
}

/** A workflow command's parsed request: the leftover argument plus the run policy. */
interface FlowRequest extends FlowRunOptions {
  /** Text handed to the first phase as its user input. */
  arg: string;
  /** Set when a flag was given something it cannot accept. */
  error?: string;
}

/**
 * Pull the workflow flags out of a command argument, leaving the user's own
 * text behind. `--force` was the only one of these once, and it is still
 * stripped before the prompt is built: it is an instruction to the command,
 * not to the model, and leaving it in reads as part of the idea.
 */
function takeFlowFlags(arg: string): FlowRequest {
  let rest = arg;
  const take = (flag: string): boolean => {
    const re = new RegExp(`(^|\\s)${flag}(\\s|$)`);
    if (!re.test(rest)) return false;
    rest = rest.replace(re, " ");
    return true;
  };

  const force = take("--force");
  const auto = take("--auto");
  // --fast merges brainstorm and spec into one stretch. They answer nearly the
  // same question, and for a small project the second round trip buys nothing.
  const fast = take("--fast");

  const untilMatch = /(^|\s)--until[= ](\S+)/.exec(rest);
  if (untilMatch) {
    rest = rest.replace(/(^|\s)--until[= ]\S+/, " ");
    const phase = parsePhase(untilMatch[2]);
    if (!phase) {
      return {
        arg: rest.trim(),
        force,
        error: `Unknown phase "${untilMatch[2]}" for --until. Use one of: ${PHASE_ORDER.join(", ")}.`,
      };
    }
    return { arg: rest.trim(), force, until: phase };
  }
  if (/(^|\s)--until(\s|$)/.test(rest)) {
    return { arg: rest.trim(), force, error: "Usage: --until <phase>" };
  }

  if (auto) return { arg: rest.trim(), force, auto: true };
  if (fast) {
    return { arg: rest.trim(), force, gates: DEFAULT_GATES.filter((p) => p !== "brainstorm") };
  }
  return { arg: rest.trim(), force };
}

/** Strip a trailing/leading `--default` from a command argument. */
function takeDefault(arg: string): { arg: string; makeDefault: boolean } {
  const makeDefault = /(^|\s)--default(\s|$)/.test(arg);
  return { arg: arg.replace(/(^|\s)--default(\s|$)/, " ").trim(), makeDefault };
}

/** What one phase of a run needs to know. */
interface PhaseRun {
  /** User text for this phase. Empty for every phase after the first. */
  arg: string;
  force: boolean;
  stopAfter: boolean;
}

/** How a phase ended. Anything but `ok` stops the chain it was part of. */
type PhaseOutcome =
  | "ok"
  /** A prerequisite artifact was missing, so the phase never started. */
  | "blocked"
  /** The phase ran but hit the step limit, leaving its artifact unfinished. */
  | "incomplete";

/**
 * Run one workflow phase: check its prerequisite artifact exists, set the mode
 * the phase needs, record the phase, compact, then hand the prompt to the
 * agent.
 *
 * The outcome is what stops a chain. A blocked phase has written nothing, and
 * an incomplete one has written something half-finished — either way everything
 * after it reads an artifact that isn't there yet.
 */
async function runPhase(
  ctx: CommandContext,
  phase: WorkflowPhase,
  run: PhaseRun
): Promise<PhaseOutcome> {
  const project = loadProjectState(ctx.workspace);
  if (!project) {
    ctx.addItem({
      kind: "info",
      text: "No active project workflow. Start one with /flow-brainstorm <idea>.",
    });
    return "blocked";
  }
  const blocker = phaseBlocker(ctx.workspace, project.name, phase);
  if (blocker && !run.force) {
    ctx.addItem({
      kind: "info",
      text: `${blocker}\nTo run ${PHASE_COMMAND[phase]} anyway: ${PHASE_COMMAND[phase]} --force`,
    });
    return "blocked";
  }
  // Warn (never block) if an earlier artifact was edited after this phase's
  // input was written from it — e.g. spec.md changed after plan.md already
  // read it. The phase still runs on whatever's on disk right now.
  const stale = staleArtifacts(ctx.workspace, project.name, phase);
  if (stale.length) {
    ctx.addItem({ kind: "info", text: stale.join("\n") });
  }

  // The plan phase is read-only by design; every other phase needs to write.
  const wantPlanMode = phase === "plan";
  if (ctx.planMode !== wantPlanMode) {
    ctx.agent.planMode = wantPlanMode;
    ctx.setPlanMode(wantPlanMode);
  }
  if (wantPlanMode && ctx.acceptEdits) {
    ctx.agent.acceptEdits = false;
    ctx.setAcceptEdits(false);
  }
  if (wantPlanMode && ctx.bypassMode) {
    ctx.agent.bypassMode = false;
    ctx.setBypassMode(false);
  }

  saveProjectState(ctx.workspace, project.name, phase);
  const artifact = artifactPath(project.name, phase);
  ctx.addItem({
    kind: "info",
    text:
      `${phase} phase for "${project.name}" — ${PHASE_SUMMARY[phase]}` +
      (artifact ? ` → ${artifact}` : "") +
      (wantPlanMode ? " (plan mode ON: read-only apart from that doc)" : "") +
      (blocker && run.force ? "\n⚠ Forced past a missing prerequisite." : ""),
  });
  ctx.setRunningPhase(phase);
  ctx.refreshWorkflow();
  await compactAtPhaseBoundary(ctx, phase);
  await ctx.runAgent(phasePrompt(project.name, phase, run.arg, { stopAfter: run.stopAfter }));
  // A turn that runs out of steps just ends, and the message it appends reads
  // like model output. The agent flags it, so a chain can tell "the phase
  // finished" from "the phase gave up mid-sentence" — which matters because
  // the next phase reads whatever it managed to write. Subagents already
  // report this (`stoppedEarly: "max-steps"`); phases were treating a
  // truncated run as a finished one.
  if (ctx.agent.hitStepLimit) return "incomplete";
  return "ok";
}

/**
 * Run a stretch of phases back to back from one command.
 *
 * `planRun` decides how far the stretch goes. Stopping between build, review
 * and fix would ask "shall I now review what I just built?" — a round trip
 * that buys no decision, because by then the work is already done. Stopping
 * after brainstorm, spec and plan does buy one: those are cheap to redo and
 * expensive to get wrong.
 */
async function runFlow(ctx: CommandContext, from: WorkflowPhase, req: FlowRequest): Promise<void> {
  // An `until` behind the start phase can never fire — shouldStopAfter matches
  // on equality — so the run would quietly do the opposite of what was asked
  // and execute every remaining phase. A *typo* is caught when the flag is
  // parsed; a phase that is merely behind is not, and this is the one place
  // that knows both ends, so it is checked here rather than in the parser.
  if (req.until && PHASE_ORDER.indexOf(req.until) < PHASE_ORDER.indexOf(from)) {
    ctx.addItem({
      kind: "info",
      text:
        `--until ${req.until} is behind ${from}, the phase this run starts at, so it would ` +
        `never stop and every remaining phase would run. Pick ${from} or a later phase, ` +
        `or use --auto to say that you do want the whole stretch.`,
    });
    return;
  }
  const phases = planRun(from, req);
  const chained = phases.length > 1;
  // One command, so one user line — not one per phase of the stretch.
  ctx.addItem({ kind: "user", text: ctx.raw.trim() });
  if (chained) {
    ctx.addItem({ kind: "info", text: `Running ${phases.length} phases: ${phases.join(" → ")}` });
    ctx.setChained(true);
  }
  try {
    for (const [i, phase] of phases.entries()) {
      const outcome = await runPhase(ctx, phase, {
        arg: i === 0 ? req.arg : "",
        force: req.force === true,
        stopAfter: shouldStopAfter(phase, req),
      });
      if (outcome === "ok") continue;
      // A phase that did not finish stops the chain, because everything after
      // it reads the artifact it did not (or only half) wrote. Say so: without
      // this the run just goes quiet after the blocker message, and the user
      // has to work out for themselves that phases they were promised never
      // happened.
      const abandoned = phases.slice(i + 1);
      if (outcome === "incomplete") {
        ctx.addItem({
          kind: "info",
          text:
            `${phase} stopped at the ${ctx.agent.maxSteps}-step limit before it finished, so ` +
            `whatever it wrote is incomplete — and the phases after it read that.` +
            (abandoned.length ? ` ${abandoned.join(", ")} did not run.` : "") +
            `\nSend "continue" to finish ${phase}, then /flow to carry on from there.`,
        });
      } else if (abandoned.length) {
        ctx.addItem({
          kind: "info",
          text:
            `Chain stopped at ${phase} — ${abandoned.join(", ")} did not run. ` +
            `Clear the blocker above, then /flow to carry on from here.`,
        });
      }
      break;
    }
  } finally {
    // Only a chain ever sets this, so only a chain releases it — a single-phase
    // command has nothing to suppress and should not touch the flag at all.
    if (chained) ctx.setChained(false);
  }
}

/** The standard handler for a single phase command: /flow-spec, /flow-build, … */
function phaseCommand(phase: WorkflowPhase): CommandHandler {
  return async (ctx) => {
    const req = takeFlowFlags(ctx.arg);
    if (req.error) {
      ctx.addItem({ kind: "info", text: req.error });
      return;
    }
    return runFlow(ctx, phase, req);
  };
}

const handlers: Record<string, CommandHandler> = {
  "/help": (ctx) => {
    const customList = ctx.customCommands.length
      ? `\n\nCustom commands (from .kritya/commands/):\n${ctx.customCommands
          .map(
            (c) =>
              `  ${c.name.padEnd(14)} ${c.description}${c.pluginName ? ` (plugin: ${c.pluginName})` : ""}`
          )
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
    const { arg, makeDefault } = takeDefault(ctx.arg);
    if (!arg) {
      const lines = listProviders(ctx.config).map((p) => {
        const marker = p.name === ctx.provider ? "*" : " ";
        const note = p.hasKey ? "" : "  (no API key configured)";
        return `  ${marker} ${p.name}${note}`;
      });
      ctx.addItem({
        kind: "info",
        text:
          `Providers (* = active):\n${lines.join("\n")}\n\n` +
          `Switch with /provider <name> — session only, conversation history is kept. ` +
          `Add --default to also make it the default for future launches. ` +
          `If a request keeps failing (429/5xx after retries), switch to any provider marked with a key.`,
      });
      return;
    }
    ctx.setProviderEverywhere(arg, makeDefault);
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
  "/skills": (ctx) => {
    const projectRoot = skillsDir(ctx.workspace);
    const userRoot = userSkillsDir();
    const plugins = scanPlugins([pluginsDir(ctx.workspace), userPluginsDir()]);
    const pluginRoots = pluginSkillsRoots(plugins);
    const { loaded, skipped } = scanSkillsDetailed([
      projectRoot,
      userRoot,
      ...pluginRoots.map((r) => r.dir),
    ]);

    if (!loaded.length && !skipped.length) {
      ctx.addItem({
        kind: "info",
        text: `No skills found under ${projectRoot} or ${userRoot}.`,
      });
      return;
    }

    const truncate = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);
    const rows = loaded.map((s) => {
      const plugin = pluginRoots.find((r) => s.dir === r.dir || s.dir.startsWith(r.dir + path.sep));
      const source = plugin
        ? `plugin: ${plugin.pluginName}`
        : s.dir.startsWith(projectRoot + path.sep) || s.dir === projectRoot
          ? "project"
          : "user";
      return { name: s.name, source, description: truncate(s.description, 60) };
    });
    const nameWidth = Math.max(
      4,
      ...rows.map((r) => r.name.length),
      ...skipped.map((s) => s.name.length)
    );
    const lines = [
      ...rows.map((r) => `  ${r.name.padEnd(nameWidth)}   (${r.source})  ${r.description}`),
      ...skipped.map((s) => `  ${s.name.padEnd(nameWidth)}   SKIPPED: ${s.reason}`),
    ];
    ctx.addItem({ kind: "info", text: lines.join("\n") });
  },
  "/plugins": (ctx) => {
    const workspaceRoot = pluginsDir(ctx.workspace);
    const userRoot = userPluginsDir();
    const { loaded, skipped } = scanPluginsDetailed([workspaceRoot, userRoot]);

    if (!loaded.length && !skipped.length) {
      ctx.addItem({
        kind: "info",
        text: `No plugins found under ${workspaceRoot} or ${userRoot}.`,
      });
      return;
    }

    const rows = loaded.map((p) => {
      const source =
        p.dir.startsWith(workspaceRoot + path.sep) || p.dir === workspaceRoot
          ? "workspace"
          : "user";
      const version = typeof p.manifest.version === "string" ? p.manifest.version : "?";
      const { loaded: skillsLoaded } = scanSkillsDetailed([path.join(p.dir, "skills")]);
      const { loaded: mcpLoaded, skipped: mcpSkipped } = scanPluginMcpServers([p]);
      let commandCount = 0;
      try {
        commandCount = fs
          .readdirSync(path.join(p.dir, "commands"))
          .filter((f) => f.endsWith(".md")).length;
      } catch {
        // No commands/ subfolder -- not a mistake, just nothing to count.
      }
      const contributions = [
        skillsLoaded.length ? `${skillsLoaded.length} skill(s)` : "",
        mcpLoaded.length ? `${mcpLoaded.length} MCP server(s)` : "",
        commandCount ? `${commandCount} command(s)` : "",
      ].filter(Boolean);
      const mcpSkipNote = mcpSkipped.length
        ? ` — skipped MCP server(s): ${mcpSkipped.map((s) => `${s.name} (${s.reason})`).join("; ")}`
        : "";
      return `  ${p.name}@${version} (${source})  ${contributions.join(", ") || "(nothing)"}${mcpSkipNote}`;
    });
    const skipLines = skipped.map((s) => `  ${s.name}  SKIPPED: ${s.reason}`);
    ctx.addItem({ kind: "info", text: [...rows, ...skipLines].join("\n") });
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
    ctx.clearItems();
    ctx.addItem({ kind: "info", text: "Conversation cleared." });
  },
  "/rename": (ctx) => {
    const arg = ctx.arg.trim();
    if (!arg) {
      ctx.addItem({ kind: "info", text: `This session is named "${ctx.agent.sessionName()}".` });
      return;
    }
    const slug = ctx.agent.renameSession(arg);
    if (!slug) {
      ctx.addItem({
        kind: "info",
        text: `Couldn't make a session name out of "${arg}" — try letters and numbers.`,
      });
      return;
    }
    ctx.addItem({
      kind: "info",
      text: `Session renamed to "${slug}". Resume it later with: kritya -r ${slug}`,
    });
  },
  "/export": (ctx) => {
    const messages = ctx.agent.history.filter((m) => m.role !== "system");
    if (!messages.length) {
      ctx.addItem({ kind: "info", text: "Nothing to export — the conversation is empty." });
      return;
    }
    let file: string;
    try {
      file = resolveExportPath(ctx.workspace, ctx.arg, ctx.agent.sessionName());
    } catch (err) {
      ctx.addItem({
        kind: "info",
        text: `Can't export there: ${err instanceof Error ? err.message : String(err)}`,
      });
      return;
    }
    const md = transcriptToMarkdown(messages, {
      sessionName: ctx.agent.sessionName(),
      model: ctx.model,
      provider: ctx.provider,
      exportedAt: new Date(),
    });
    try {
      fs.writeFileSync(file, md, "utf8");
    } catch (err) {
      ctx.addItem({
        kind: "info",
        text: `Export failed: ${err instanceof Error ? err.message : String(err)}`,
      });
      return;
    }
    ctx.addItem({
      kind: "info",
      text: `Transcript exported to ${file} (${messages.length} messages).`,
    });
  },
  "/cost": (ctx) => {
    ctx.addItem({ kind: "info", text: ctx.costReport() });
  },
  "/status": (ctx) => {
    ctx.addItem({ kind: "info", text: ctx.statusReport() });
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
    const attribution = ctx.config.commitAttribution !== false;
    const trailerInstruction = attribution
      ? ` End the commit message with a trailer on its own line: ` +
        `"Generated-By: kritya (${ctx.provider}/${ctx.model})".`
      : "";
    return ctx.runAgent(
      "Review the current git changes (git status, git diff), stage the appropriate files, " +
        "and create a commit with a well-written conventional-commit message that describes " +
        `the change.${trailerInstruction} Do not push. Show the final commit hash and message.`
    );
  },
  "/flow-brainstorm": async (ctx) => {
    const req = takeFlowFlags(ctx.arg);
    if (req.error) {
      ctx.addItem({ kind: "info", text: req.error });
      return;
    }
    const input = req.arg;
    const existing = loadProjectState(ctx.workspace);
    if (!existing && !input) {
      ctx.addItem({
        kind: "info",
        text:
          `Usage: /flow-brainstorm <your project idea>. Starts the ${PHASE_ORDER.join(" → ")} workflow.\n` +
          `Name it yourself with a short prefix: /flow-brainstorm reverser: a script that reverses a string\n` +
          `Flags: --fast (run brainstorm and spec as one stretch) · --auto (no stops) · ` +
          `--until <phase> · --force`,
      });
      return;
    }
    // An idea always names the project. Reusing the existing project's name for
    // a freshly described idea (the old behaviour) silently wrote one project's
    // brainstorm into another project's folder.
    const parsed = parseIdea(input);
    const idea = input ? parsed.idea : "";
    const name = input ? slugify(parsed.name) : existing!.name;
    if (existing && existing.name !== name) {
      ctx.addItem({
        kind: "info",
        text:
          `Starting a new project "${name}". The previous project "${existing.name}" was in the ` +
          `${existing.phase} phase; its docs/${existing.name}/ artifacts are untouched, and ` +
          `/project goto ${existing.phase} after /flow-brainstorm ${existing.name} returns to it.`,
      });
    }
    saveProjectState(ctx.workspace, name, "brainstorm");
    // Brainstorming writes its doc, so make sure plan mode isn't left on.
    if (ctx.planMode) {
      ctx.agent.planMode = false;
      ctx.setPlanMode(false);
    }
    ctx.refreshWorkflow();
    // The idea belongs to the brainstorm phase; later phases in a --fast stretch
    // read its artifact rather than the raw idea again.
    return runFlow(ctx, "brainstorm", { ...req, arg: idea });
  },
  "/flow": async (ctx) => {
    const project = loadProjectState(ctx.workspace);
    if (!project) {
      ctx.addItem({
        kind: "info",
        text: "No active project workflow. Start one with /flow-brainstorm <idea>.",
      });
      return;
    }
    const req = takeFlowFlags(ctx.arg);
    if (req.error) {
      ctx.addItem({ kind: "info", text: req.error });
      return;
    }
    // The stored phase is the one that last ran, so continuing means the next
    // one — re-running what just finished is never what "continue" means.
    const from = nextPhase(project.phase);
    if (!from) {
      ctx.addItem({
        kind: "info",
        text:
          `"${project.name}" has run every phase (last: ${project.phase}). ` +
          `Run /project clear to end the workflow, or ${BACK_COMMAND} <phase> to redo one.`,
      });
      return;
    }
    // A revisit the fix phase recorded means a finding was never really closed.
    // Carrying on forward would run the rest of the workflow on top of a
    // requirement that is known to be wrong, so name it here rather than let
    // the user discover it by reading /project.
    const revisit = project.revisit;
    if (revisit && PHASE_ORDER.indexOf(revisit.to) < PHASE_ORDER.indexOf(from)) {
      ctx.addItem({
        kind: "info",
        text:
          `↩ ${revisit.to} is still flagged as needing a change — ${revisit.reason}\n` +
          `Run ${BACK_COMMAND} to redo it and everything after, or carry on anyway with ` +
          `${PHASE_COMMAND[from]}.`,
      });
    }
    return runFlow(ctx, from, req);
  },
  "/flow-back": async (ctx) => {
    const project = loadProjectState(ctx.workspace);
    if (!project) {
      ctx.addItem({
        kind: "info",
        text: "No active project workflow. Start one with /flow-brainstorm <idea>.",
      });
      return;
    }
    const req = takeFlowFlags(ctx.arg);
    if (req.error) {
      ctx.addItem({ kind: "info", text: req.error });
      return;
    }
    // Bare /flow-back acts on whatever the fix phase recorded; naming a phase
    // works whether or not anything was recorded.
    const recorded = project.revisit;
    const target = parsePhase(req.arg) ?? recorded?.to ?? null;
    if (!target) {
      ctx.addItem({
        kind: "info",
        text:
          `Usage: ${BACK_COMMAND} <${PHASE_ORDER.join("|")}> — rewind to a phase and re-run everything after it.\n` +
          `Nothing upstream was recorded either, so name the phase you want to redo.`,
      });
      return;
    }
    if (PHASE_ORDER.indexOf(target) >= PHASE_ORDER.indexOf(project.phase)) {
      ctx.addItem({
        kind: "info",
        text:
          `${BACK_COMMAND} rewinds, and ${target} is not before the current phase ` +
          `(${project.phase}). Use ${PHASE_COMMAND[target]} to move forward.`,
      });
      return;
    }
    if (revisitsRemaining(ctx.workspace) <= 0) {
      ctx.addItem({
        kind: "info",
        text:
          `"${project.name}" has already looped back ${MAX_REVISITS} time(s), which is the limit — ` +
          `another automatic pass would be guessing at what you want. Fix what you can by hand, ` +
          `then /project goto ${target} and ${PHASE_COMMAND[target]} if you still want to redo it.`,
      });
      return;
    }
    if (!takeRevisit(ctx.workspace, target)) {
      ctx.addItem({ kind: "info", text: `Could not rewind "${project.name}".` });
      return;
    }
    ctx.addItem({
      kind: "info",
      text:
        `↩ Rewinding to ${target}` +
        (recorded && recorded.to === target ? ` — ${recorded.reason}` : "") +
        `. Everything after it re-runs, because it all reads what ${target} writes.`,
    });
    ctx.refreshWorkflow();
    // Rewinding exists to regenerate what the wrong phase produced, and to put
    // the user back where they were — not to carry on past it. So it stops at
    // the phase the project had reached, unless the user asked for a longer or
    // shorter run with --auto / --until.
    //
    // `arg` is blanked deliberately: it held the phase name the user typed
    // (`/flow-back spec`), and passing it on would inject the literal string
    // "spec" into the phase prompt as if it were user input.
    const options: FlowRequest = { ...req, arg: "" };
    if (!req.auto && !req.until) options.until = project.phase;
    return runFlow(ctx, target, options);
  },
  // `/plan` (no `flow-` prefix) is pure plan-mode control — on/off or a bare
  // toggle — and never touches the project workflow. `/flow-plan` runs the
  // workflow's plan phase. Splitting these removes the ambiguity the old
  // combined `/plan` had, where a bare call meant different things depending
  // on whether a project happened to be active.
  "/plan": (ctx) => {
    const explicit = ctx.arg.trim().toLowerCase();
    const next = explicit ? explicit === "on" : !ctx.planMode;
    ctx.setPlanMode(next);
    ctx.agent.planMode = next;
    // Plan mode and accept-edits are mutually exclusive; entering one via
    // either path must turn the other off.
    if (next && ctx.acceptEdits) {
      ctx.agent.acceptEdits = false;
      ctx.setAcceptEdits(false);
    }
    ctx.addItem({
      kind: "info",
      text: next
        ? "Plan mode ON — read-only. The agent will explore and propose a plan; edits and shell are blocked. Run /plan off to execute."
        : "Plan mode OFF — the agent can make changes again.",
    });
  },
  "/flow-spec": phaseCommand("spec"),
  "/flow-plan": phaseCommand("plan"),
  "/flow-build": phaseCommand("build"),
  "/flow-review": phaseCommand("review"),
  "/flow-fix": phaseCommand("fix"),
  "/flow-ship": phaseCommand("ship"),
  "/project": (ctx) => {
    const [sub = "", ...rest] = ctx.arg.trim().split(/\s+/);
    const project = loadProjectState(ctx.workspace);
    if (sub.toLowerCase() === "clear") {
      if (!project) {
        ctx.addItem({ kind: "info", text: "No active project workflow." });
        return;
      }
      clearProjectState(ctx.workspace);
      ctx.refreshWorkflow();
      ctx.addItem({
        kind: "info",
        text: `Workflow for "${project.name}" ended. Its docs/${project.name}/ artifacts are kept.`,
      });
      return;
    }
    if (!project) {
      ctx.addItem({
        kind: "info",
        text: "No active project workflow. Start one with /flow-brainstorm <idea>.",
      });
      return;
    }
    if (sub.toLowerCase() === "rename") {
      const result = renameProject(ctx.workspace, project.name, rest.join(" "));
      if (!result.ok) {
        ctx.addItem({ kind: "info", text: result.error });
        return;
      }
      ctx.refreshWorkflow();
      ctx.addItem({
        kind: "info",
        text: `Renamed "${project.name}" to "${result.name}" — artifacts moved to docs/${result.name}/.`,
      });
      return;
    }
    if (sub.toLowerCase() === "goto") {
      const target = parsePhase(rest.join(" "));
      if (!target) {
        ctx.addItem({ kind: "info", text: `Usage: /project goto <${PHASE_ORDER.join("|")}>` });
        return;
      }
      saveProjectState(ctx.workspace, project.name, target);
      ctx.refreshWorkflow();
      ctx.addItem({
        kind: "info",
        text: `"${project.name}" set to the ${target} phase. Run ${PHASE_COMMAND[target]} to start it, or /flow to continue from here.`,
      });
      return;
    }
    const lines = PHASE_ORDER.map((p, i) => {
      const marker = p === project.phase ? "*" : " ";
      const artifact = artifactPath(project.name, p);
      // build has no document of its own, so there is nothing to look for.
      const written = artifact !== null && artifactExists(ctx.workspace, project.name, p);
      return (
        `  ${marker} ${String(i + 1).padStart(2)}. ${p.padEnd(11)}${PHASE_SUMMARY[p]}` +
        `\n         ${artifact ?? "(application code)"}${written ? "  ✓" : ""}`
      );
    });
    const stale = staleArtifacts(ctx.workspace, project.name, project.phase);
    const staleBlock = stale.length ? `\n\n${stale.join("\n")}` : "";
    const revisitBlock = project.revisit
      ? `\n\n↩ ${project.revisit.to} was flagged as needing a change: ${project.revisit.reason}` +
        `\n   ${BACK_COMMAND} redoes it and everything after it.`
      : "";
    ctx.addItem({
      kind: "info",
      text:
        `Project "${project.name}" — ${project.phase} phase ` +
        `(${phaseIndex(project.phase)}/${PHASE_ORDER.length})` +
        (project.updatedAt ? ` (since ${project.updatedAt.slice(0, 10)})` : "") +
        `\n\n${lines.join("\n")}` +
        staleBlock +
        revisitBlock +
        `\n\n/flow continues · ${PHASE_COMMAND[project.phase]} re-runs this phase · ` +
        `/project goto <phase> to move · /project rename <name> · /project clear to end the workflow.`,
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
  "/status",
  "/diff",
  "/budget",
  "/mcp",
  "/checkpoint",
  "/skills",
  "/plugins",
]);

/** Dispatch a slash command: built-in, then custom, then MCP prompt, then "unknown". */
export async function runCommand(cmd: string, ctx: CommandContext): Promise<void> {
  if (ctx.killed && !ALLOWED_WHILE_KILLED.has(cmd)) {
    ctx.addItem({
      kind: "info",
      text:
        `⛔ Kill switch ACTIVE${ctx.killReason ? ` — ${ctx.killReason}` : ""}. ` +
        `${cmd} is blocked. Release it with /kill off.`,
    });
    return;
  }

  // Rank the palette by what a user actually runs. Recorded here rather than
  // when the palette inserts the command: insertion only fills the input line
  // (the user may edit or abandon it), so that signal would rank
  // typed-and-abandoned commands above the ones really used. An unknown command
  // is not recorded — it never ran. See ui/recentCommands.ts.
  const known =
    handlers[cmd] !== undefined ||
    ctx.customCommands.some((c) => c.name === cmd) ||
    mcpPrompts().some((p) => p.command === cmd);
  if (known) recordCommandUse(cmd);

  const handler = handlers[cmd];
  if (handler) return handler(ctx);

  const custom = ctx.customCommands.find((c) => c.name === cmd);
  if (custom) {
    ctx.addItem({ kind: "user", text: ctx.raw.trim() });
    return ctx.runAgent(expandCommand(custom.body, await ctx.expandMentions(ctx.arg)));
  }

  // Checked after built-ins and the user's own command files, so a server
  // can't redefine /plan by naming a prompt "plan".
  const prompt = mcpPrompts().find((p) => p.command === cmd);
  if (prompt) {
    const missing = prompt.args.filter((a) => a.required).map((a) => a.name);
    if (missing.length && !ctx.arg.trim()) {
      ctx.addItem({
        kind: "info",
        text: `${cmd} needs ${missing.join(", ")}.\n\nUsage: ${cmd} <${missing.join("> <")}>`,
      });
      return;
    }
    ctx.addItem({ kind: "user", text: ctx.raw.trim() });
    ctx.setActivity(`Fetching ${prompt.name} from ${prompt.server}…`);
    let expanded: string;
    try {
      expanded = await prompt.expand(ctx.arg);
    } catch (err) {
      ctx.addItem({
        kind: "info",
        text: `${cmd} failed: ${err instanceof Error ? err.message : String(err)}`,
      });
      return;
    } finally {
      ctx.setActivity(null);
    }
    if (!expanded.trim()) {
      ctx.addItem({ kind: "info", text: `${cmd} returned an empty prompt.` });
      return;
    }
    // The server wrote this text, so it's untrusted input being handed to the
    // model as if the user typed it — label it rather than let it pass as ours.
    return ctx.runAgent(
      `[MCP prompt "${prompt.name}" from server "${prompt.server}" — external content]\n\n${expanded}`
    );
  }

  ctx.addItem({ kind: "info", text: `Unknown command: ${cmd}. Try /help` });
}
