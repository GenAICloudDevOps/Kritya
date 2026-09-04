import { Text } from "ink";
import path from "node:path";
import type { ProjectState } from "../agent/workflow.js";
import type { TaskItem, Usage } from "../types.js";

export interface StatusLineProps {
  killed: boolean;
  killReason?: string;
  dryRunMode: boolean;
  planMode: boolean;
  acceptEdits: boolean;
  autoApprovedCount: number;
  model: string;
  workflow: ProjectState | null;
  branch: string | null;
  tasks: TaskItem[];
  ctxPct: number;
  budgetPct: number;
  budgetStopped: boolean;
  phase: string;
  elapsed: number;
  totalUsage: Usage;
  totalCost: number;
  verbose: boolean;
  workspace: string;
  sandboxActive: boolean;
}

/** The single dim status bar pinned to the bottom of the screen. */
export function StatusLine({
  killed,
  killReason,
  dryRunMode,
  planMode,
  acceptEdits,
  autoApprovedCount,
  model,
  workflow,
  branch,
  tasks,
  ctxPct,
  budgetPct,
  budgetStopped,
  phase,
  elapsed,
  totalUsage,
  totalCost,
  verbose,
  workspace,
  sandboxActive,
}: StatusLineProps) {
  return (
    <Text dimColor>
      {killed ? (
        <Text bold color="red">
          ⛔ KILLED{killReason ? ` (${killReason})` : ""} ·{" "}
        </Text>
      ) : (
        ""
      )}
      {dryRunMode ? (
        <Text color="cyan">dry-run · </Text>
      ) : planMode ? (
        <Text color="cyan">plan · </Text>
      ) : acceptEdits ? (
        <Text color="green">accept edits ({autoApprovedCount} auto-approved) · </Text>
      ) : (
        ""
      )}
      {model}
      <Text color={sandboxActive ? "green" : "red"}>
        {" "}
        · {sandboxActive ? "🔒 sandbox:active" : "🔓 sandbox:inactive"}
      </Text>
      {workflow ? (
        <Text color="magenta">
          {" "}
          · ⚑ {workflow.name}:{workflow.phase}
        </Text>
      ) : (
        ""
      )}
      {branch ? ` · ⎇ ${branch}` : ""}
      {tasks.length > 0
        ? ` · tasks ${tasks.filter((t) => t.status === "done").length}/${tasks.length}`
        : ""}
      {ctxPct > 0 ? ` · ctx ${ctxPct}%` : ""}
      {budgetPct > 0 ? (
        <Text color={budgetStopped ? "red" : budgetPct >= 80 ? "yellow" : undefined}>
          {" "}
          · budget {budgetPct}%
        </Text>
      ) : (
        ""
      )}
      {phase === "working" && elapsed > 0 ? ` · ${elapsed}s` : ""} ·{" "}
      {totalUsage.estimated ? "~" : ""}
      {totalUsage.promptTokens.toLocaleString()} in
      {(totalUsage.cachedPromptTokens ?? 0) > 0
        ? ` (${Math.round(((totalUsage.cachedPromptTokens ?? 0) / totalUsage.promptTokens) * 100)}% cached)`
        : ""}{" "}
      / {totalUsage.completionTokens.toLocaleString()} out
      {totalCost > 0 ? ` · $${totalCost.toFixed(4)}` : ""}
      {verbose ? " · verbose" : ""} · {path.basename(workspace)}
    </Text>
  );
}
