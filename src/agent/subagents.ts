import { Agent } from "./loop.js";
import type { KillSwitch } from "./killSwitch.js";
import {
  commitWorktree,
  createWorktree,
  isGitRepo,
  removeWorktree,
  worktreeDiffStat,
} from "./worktree.js";
import { PermissionManager } from "../permissions/permissions.js";
import { SessionStore } from "../session/store.js";
import type { AuditLog } from "../audit/audit.js";
import type { ProviderClient } from "../provider/client.js";
import type { SandboxMode } from "../shell/sandbox.js";
import type { Meter } from "../telemetry/metrics.js";
import type { AttrValue, Span, Tracer } from "../telemetry/tracer.js";
import type {
  AgentHandlers,
  SubagentResult,
  SubagentSpec,
  SubagentStopReason,
  ToolDef,
} from "../types.js";

/**
 * Batches are capped at six tasks by spawn_agent's own schema and at four by
 * spawn_write_agent's, so allowing more concurrency than the larger of the two
 * buys nothing — the extra slots can never be filled.
 */
export const MAX_SUBAGENT_CONCURRENCY = 6;
export const DEFAULT_SUBAGENT_CONCURRENCY = 3;
export const DEFAULT_SUBAGENT_TIMEOUT_MS = 10 * 60 * 1000;
/** Read-only agents get half the budget of write agents: they search, they don't build. */
export const DEFAULT_READ_SUBAGENT_STEPS = 15;
export const DEFAULT_WRITE_SUBAGENT_STEPS = 30;

/** Longest headline kept for the one-line progress report. */
const HEADLINE_MAX = 72;

/** Progress for one subagent: `(index, "step 4/15 · grep src/auth")`. */
export type SubagentProgress = (index: number, text: string) => void;

export interface SubagentRunnerDeps {
  client: ProviderClient;
  /** Read per call, so a /model change applies to subagents spawned afterwards. */
  model: () => string;
  /** Tools a read-only subagent may use. */
  readOnlyTools: ToolDef[];
  /**
   * Tools a write subagent may use. Must already exclude spawn_agent and
   * spawn_write_agent: a subagent that could spawn subagents would be an
   * unbounded fork bomb with no human in the loop to notice.
   */
  writeTools: ToolDef[];
  workspace: string;
  sandboxMode?: SandboxMode;
  trustWorkspace?: boolean;
  audit?: AuditLog;
  tracer?: Tracer;
  meter?: Meter;
  /**
   * The parent's kill switch, read lazily: this runner is built before the
   * parent Agent exists. A subagent with its own switch would keep running
   * after the user stopped the session.
   */
  kill: () => KillSwitch;
  /** Parent span, read lazily for the same reason — nests subagent work under the turn. */
  spanParent?: () => Span | undefined;
  /** Max subagents running at once. Clamped to 1..MAX_SUBAGENT_CONCURRENCY. */
  concurrency?: number;
  /** Wall-clock cap per subagent. */
  timeoutMs?: number;
  /** Model round-trips allowed per read-only subagent. */
  readMaxSteps?: number;
  /** Model round-trips allowed per write subagent. */
  writeMaxSteps?: number;
}

export interface SubagentRunner {
  spawnAgents(
    specs: SubagentSpec[],
    signal?: AbortSignal,
    onProgress?: SubagentProgress
  ): Promise<SubagentResult[]>;
}

/** A finite value floors to itself, bounded to 1..MAX_SUBAGENT_CONCURRENCY; anything else takes the default. */
export function clampConcurrency(value: number | undefined): number {
  const wanted =
    typeof value === "number" && Number.isFinite(value)
      ? Math.floor(value)
      : DEFAULT_SUBAGENT_CONCURRENCY;
  return Math.min(Math.max(wanted, 1), MAX_SUBAGENT_CONCURRENCY);
}

/**
 * Why an aborted subagent stopped, or undefined if it wasn't aborted.
 *
 * The raw abort message is identical for both cases ("this operation was
 * aborted"), so without this a ten-minute wall-clock cap reads exactly like the
 * user pressing Ctrl-C.
 */
export function abortOutcome(opts: {
  timedOut: boolean;
  cancelled: boolean;
}): { error: string; stoppedEarly: SubagentStopReason } | undefined {
  if (opts.timedOut) return { error: "timed out before finishing", stoppedEarly: "timeout" };
  if (opts.cancelled) return { error: "cancelled", stoppedEarly: "cancelled" };
  return undefined;
}

/** Joins the non-empty reasons a subagent's work could not be used, or undefined if there are none. */
export function mergeErrors(...messages: (string | undefined)[]): string | undefined {
  const kept = messages.filter((m): m is string => typeof m === "string" && m.trim() !== "");
  return kept.length > 0 ? kept.join(" ") : undefined;
}

/** One collapsed line from a finished result, for the progress line. */
export function headline(result: SubagentResult): string {
  const text = (result.error ?? result.summary).replace(/\s+/g, " ").trim();
  if (text === "") return "no findings";
  return text.length > HEADLINE_MAX ? `${text.slice(0, HEADLINE_MAX - 1)}…` : text;
}

/**
 * The bracketed note the spawn_* tools append to a result, or undefined for a
 * clean run.
 *
 * Shared by both tools so a failure reads the same either way, and so the
 * single-task path can't lose it: that path returns the summary bare, which
 * used to mean a lone failing subagent came back as an empty string with the
 * reason nowhere in sight.
 */
export function subagentStatusNote(result: SubagentResult): string | undefined {
  const notes: string[] = [];
  if (result.error) notes.push(`[error: ${result.error}]`);
  if (result.stoppedEarly === "max-steps") {
    notes.push(
      "[stopped early: it hit its step limit, so the findings above are incomplete — " +
        "re-dispatch a narrower task, or raise subagentMaxSteps]"
    );
  } else if (result.stoppedEarly) {
    notes.push(`[stopped early: ${result.stoppedEarly}]`);
  }
  return notes.length > 0 ? notes.join("\n") : undefined;
}

export interface SubagentHandlersOptions {
  /**
   * Receives the subagent's assistant text *so far* — every call is the full
   * accumulation, not just the newest message.
   */
  onFinalText: (text: string) => void;
  requestPermission: AgentHandlers["requestPermission"];
  /** Receives a one-line "step 4/15 · grep src/auth" status as the agent works. */
  onStep?: (text: string) => void;
  /** Live step counter and cap; read at report time so the fraction is exact. */
  stepInfo?: () => { step: number; max: number };
}

/**
 * Handlers for a subagent's own agent loop: no streaming to a UI, but two
 * things this file has to get right.
 *
 * Assistant text is accumulated rather than replaced. The loop emits one
 * message per step, so the old `onAssistantText: (t) => (finalText = t)` kept
 * only the last one — a subagent that reported findings and then carried on
 * working silently lost them, and the summary came back as whatever it said
 * last.
 *
 * And progress is reported from onToolStart rather than onTextDelta: deltas
 * arrive per token, which would churn the parent's status line for no gain,
 * while tool starts are the natural "here's what it's doing now" beat.
 */
export function createSubagentHandlers(opts: SubagentHandlersOptions): AgentHandlers {
  const parts: string[] = [];
  return {
    onTextDelta: () => {},
    onReasoningDelta: () => {},
    onAssistantText: (text) => {
      const trimmed = text.trim();
      if (trimmed === "") return;
      parts.push(trimmed);
      opts.onFinalText(parts.join("\n\n"));
    },
    onToolStart: (_id, name, summary) => {
      if (!opts.onStep) return;
      const label = summary.trim() || name;
      const info = opts.stepInfo?.();
      opts.onStep(info && info.max > 0 ? `step ${info.step}/${info.max} · ${label}` : label);
    },
    onToolEnd: () => {},
    requestPermission: opts.requestPermission,
    onUsage: () => {},
  };
}

/**
 * Builds the `spawnAgents` implementation the spawn_agent / spawn_write_agent
 * tools call through `ToolContext`.
 *
 * Lives here rather than inline in the CLI entry point so the headless and
 * Electron entry points can wire the same runner instead of going without
 * subagents entirely, and so the logic is reachable from tests — `dist/index.js`
 * is excluded from coverage, which is how the swallowed-failure and
 * timeout-looks-like-cancel bugs survived in it.
 */
export function createSubagentRunner(deps: SubagentRunnerDeps): SubagentRunner {
  const concurrency = clampConcurrency(deps.concurrency);
  const timeoutMs = deps.timeoutMs ?? DEFAULT_SUBAGENT_TIMEOUT_MS;
  const readMaxSteps = deps.readMaxSteps ?? DEFAULT_READ_SUBAGENT_STEPS;
  const writeMaxSteps = deps.writeMaxSteps ?? DEFAULT_WRITE_SUBAGENT_STEPS;

  /** Fields every subagent Agent shares, so the two runners can't drift apart. */
  function baseAgent(
    tools: ToolDef[],
    maxSteps: number,
    task: string,
    spanAttributes: Record<string, AttrValue>
  ) {
    const sub = new Agent(
      deps.client,
      deps.model,
      tools,
      {
        workspace: deps.workspace,
        sandboxMode: deps.sandboxMode,
        trustWorkspace: deps.trustWorkspace,
      },
      new PermissionManager([], deps.workspace),
      new SessionStore(deps.workspace, true),
      []
    );
    sub.maxSteps = maxSteps;
    sub.audit = deps.audit;
    // Both have non-optional NOOP defaults, so only overwrite when supplied.
    if (deps.tracer) sub.tracer = deps.tracer;
    if (deps.meter) sub.meter = deps.meter;
    sub.kill = deps.kill();
    sub.spanParent = deps.spanParent?.();
    sub.spanAttributes = { ...spanAttributes, "kritya.subagent_task": task.slice(0, 120) };
    return sub;
  }

  async function runReadOnlyAgent(
    task: string,
    signal: AbortSignal,
    onProgress?: (text: string) => void
  ): Promise<SubagentResult> {
    const sub = baseAgent(deps.readOnlyTools, readMaxSteps, task, { "kritya.subagent": true });
    let finalText = "";
    await sub.runTurn(
      task,
      createSubagentHandlers({
        onFinalText: (t) => (finalText = t),
        // read-only tools never require permission, so this is never invoked
        requestPermission: async () => "no",
        onStep: onProgress,
        stepInfo: () => ({ step: sub.stepIndex, max: sub.maxSteps }),
      }),
      signal
    );
    return {
      task,
      write: false,
      summary: finalText.trim() || "(subagent returned no findings)",
      // Hitting the cap is the "wants to keep going" case: the findings are
      // real but incomplete, unlike a timeout, which is infrastructure.
      ...(sub.hitStepLimit ? { stoppedEarly: "max-steps" as const } : {}),
    };
  }

  async function runWriteAgent(
    task: string,
    signal: AbortSignal,
    onProgress?: (text: string) => void
  ): Promise<SubagentResult> {
    if (!isGitRepo(deps.workspace)) {
      return {
        task,
        write: true,
        summary: "",
        error:
          "the workspace is not a git repository, so an isolated worktree could not be created",
      };
    }
    const wt = createWorktree(deps.workspace);
    if (!wt) {
      deps.audit?.logTool({
        tool: "subagent_worktree",
        summary: `worktree creation failed for task: ${task.slice(0, 72)}`,
        outcome: "error",
      });
      return { task, write: true, summary: "", error: "failed to create an isolated git worktree" };
    }
    deps.audit?.logTool({
      tool: "subagent_worktree",
      summary: `created branch "${wt.branch}" for task: ${task.slice(0, 72)}`,
      outcome: "ok",
    });

    let finalText = "";
    // A subagent that died mid-run must not come back looking like a success:
    // the tool renders `[error: …]` only when this is set, so without it a
    // crash was reported as an ordinary summary that merely happened to begin
    // with "(subagent stopped: …)" — and its partial edits were still committed.
    let runError: string | undefined;
    let stoppedEarly: SubagentStopReason | undefined;
    try {
      // Auto-allow ordinary writes/edits/shell (no human is watching this run),
      // but a destructive command still forces `warning` via classifyDanger in
      // the agent loop regardless of the allowlist — fail-safe deny it there,
      // since there's no one to confirm it and letting it run unattended would
      // be unsafe even inside an isolated worktree (it still has real shell/
      // network access).
      const sub = new Agent(
        deps.client,
        deps.model,
        deps.writeTools,
        {
          workspace: wt.dir,
          sandboxMode: deps.sandboxMode,
          trustWorkspace: deps.trustWorkspace,
        },
        new PermissionManager({ allow: ["write_file", "edit_file", "shell(*)"], deny: [] }, wt.dir),
        new SessionStore(wt.dir, true),
        []
      );
      sub.maxSteps = writeMaxSteps;
      // No human is watching this run (see the auto-allow comment above) —
      // the forced unsandboxed-fallback warning must resolve on its own via
      // the handler below rather than be raised at all.
      sub.interactive = false;
      sub.audit = deps.audit;
      if (deps.tracer) sub.tracer = deps.tracer;
      if (deps.meter) sub.meter = deps.meter;
      sub.kill = deps.kill(); // see runReadOnlyAgent
      sub.spanParent = deps.spanParent?.();
      sub.spanAttributes = {
        "kritya.subagent": true,
        "kritya.subagent_write": true,
        "kritya.subagent_task": task.slice(0, 120),
        "kritya.subagent_branch": wt.branch,
      };
      await sub.runTurn(
        task,
        createSubagentHandlers({
          onFinalText: (t) => (finalText = t),
          requestPermission: async (_name, _summary, _diff, warning) => (warning ? "no" : "yes"),
          onStep: onProgress,
          stepInfo: () => ({ step: sub.stepIndex, max: sub.maxSteps }),
        }),
        signal
      );
      if (sub.hitStepLimit) stoppedEarly = "max-steps";
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      runError = `the subagent stopped before finishing: ${message}`;
      if (!finalText) finalText = `(subagent stopped: ${message})`;
    }

    const commitState = commitWorktree(wt, `kritya subagent: ${task.slice(0, 72)}`);
    deps.audit?.logTool({
      tool: "subagent_worktree",
      summary: `branch "${wt.branch}": commit ${commitState}`,
      outcome: commitState === "failed" ? "error" : "ok",
    });
    if (commitState === "clean") {
      const cleaned = removeWorktree(deps.workspace, wt, true);
      const summary = finalText.trim() || "(no changes made)";
      // Surface this rather than silently leave an empty orphaned branch: a
      // failed `git branch -D` (e.g. a transient ref lock) shouldn't look
      // identical to a subagent that genuinely made no changes.
      return {
        task,
        write: true,
        summary,
        error: mergeErrors(
          runError,
          cleaned
            ? undefined
            : `made no changes, but its empty scratch branch "${wt.branch}" could not be ` +
                `auto-deleted (a transient git lock) — safe to remove manually with ` +
                `\`git branch -D ${wt.branch}\``
        ),
        ...(stoppedEarly ? { stoppedEarly } : {}),
      };
    }
    if (commitState === "failed") {
      // Don't discard the worktree: the subagent's edits are real work, even
      // if a commit hook rejected them. Leave it on disk for manual recovery.
      return {
        task,
        write: true,
        summary: finalText.trim(),
        error: mergeErrors(
          runError,
          "changes could not be committed (a commit hook may have rejected them) — " +
            `left uncommitted at ${wt.dir}`
        ),
        ...(stoppedEarly ? { stoppedEarly } : {}),
      };
    }
    const diffstat = worktreeDiffStat(deps.workspace, wt);
    removeWorktree(deps.workspace, wt, false);
    return {
      task,
      write: true,
      branch: wt.branch,
      summary: `${finalText.trim() || "(no summary)"}${diffstat ? `\n\n${diffstat}` : ""}`,
      error: runError,
      ...(stoppedEarly ? { stoppedEarly } : {}),
    };
  }

  async function runOneAgent(
    spec: SubagentSpec,
    parentSignal?: AbortSignal,
    onProgress?: (text: string) => void
  ): Promise<SubagentResult> {
    const controller = new AbortController();
    const onParentAbort = () => controller.abort();
    parentSignal?.addEventListener("abort", onParentAbort);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    try {
      const result = spec.write
        ? await runWriteAgent(spec.task, controller.signal, onProgress)
        : await runReadOnlyAgent(spec.task, controller.signal, onProgress);
      if (result.error === undefined && result.stoppedEarly === undefined) return result;
      const aborted = abortOutcome({ timedOut, cancelled: parentSignal?.aborted === true });
      // A step-cap stop is the agent asking for more room, not an abort, so
      // only overwrite when this run was actually cut short.
      if (aborted && (timedOut || parentSignal?.aborted === true)) return { ...result, ...aborted };
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const aborted = abortOutcome({ timedOut, cancelled: parentSignal?.aborted === true });
      return {
        task: spec.task,
        write: Boolean(spec.write),
        summary: "",
        error: aborted?.error ?? message,
        ...(aborted ? { stoppedEarly: aborted.stoppedEarly } : {}),
      };
    } finally {
      clearTimeout(timer);
      parentSignal?.removeEventListener("abort", onParentAbort);
    }
  }

  return {
    // Runs subagents concurrently, capped at `concurrency` at a time, so a
    // burst of parallel tasks can't exhaust API rate limits or system resources.
    async spawnAgents(specs, signal, onProgress) {
      // Don't stand up worktrees and API calls for work that the shared kill
      // switch would abort on its first step anyway.
      if (deps.kill().active) {
        return specs.map((s) => ({
          task: s.task,
          write: Boolean(s.write),
          summary: "",
          error: "not started — the kill switch is active",
        }));
      }
      const results: SubagentResult[] = new Array(specs.length);
      let next = 0;
      const workers = Array.from({ length: Math.min(concurrency, specs.length) }, async () => {
        while (next < specs.length) {
          const i = next++;
          results[i] = await runOneAgent(specs[i], signal, (text) => onProgress?.(i, text));
          // Reported the moment it lands rather than only once the slowest
          // sibling finishes: a six-way batch is otherwise invisible for as
          // long as its slowest member takes.
          onProgress?.(i, `done — ${headline(results[i])}`);
        }
      });
      await Promise.all(workers);
      return results;
    },
  };
}
