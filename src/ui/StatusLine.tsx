import { Text } from "ink";
import type { ProjectState } from "../agent/workflow.js";
import type { TaskItem, Usage } from "../types.js";

export interface StatusLineProps {
  killed: boolean;
  killReason?: string;
  dryRunMode: boolean;
  planMode: boolean;
  acceptEdits: boolean;
  autoApprovedCount: number;
  provider: string;
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
  persistenceWarningCount: number;
  privacyMode: boolean;
}

/** The single dim status bar pinned to the bottom of the screen. */
export function StatusLine({
  killed,
  killReason,
  dryRunMode,
  planMode,
  acceptEdits,
  autoApprovedCount,
  provider,
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
  persistenceWarningCount,
  privacyMode,
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
      <Text color={dryRunMode || planMode ? "cyan" : acceptEdits ? "green" : undefined}>
        mode:{" "}
        {dryRunMode
          ? "dry-run"
          : planMode
            ? "plan"
            : acceptEdits
              ? `accept-edits (${autoApprovedCount} auto)`
              : "default"}
        {" · "}
      </Text>
      {provider}/{model}
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
      tokens: {totalUsage.promptTokens.toLocaleString()} in
      {(totalUsage.cachedPromptTokens ?? 0) > 0
        ? ` (${Math.round(((totalUsage.cachedPromptTokens ?? 0) / totalUsage.promptTokens) * 100)}% cached)`
        : ""}{" "}
      / {totalUsage.completionTokens.toLocaleString()} out
      {totalCost > 0 ? ` · $${totalCost.toFixed(4)}` : ""}
      {persistenceWarningCount > 0 ? (
        <Text color="yellow"> · ⚠ persistence warnings: {persistenceWarningCount}</Text>
      ) : (
        ""
      )}
      {privacyMode ? <Text color="cyan"> · privacy:on</Text> : ""}
      {verbose ? " · verbose" : ""} · workspace: {workspace}
    </Text>
  );
}
