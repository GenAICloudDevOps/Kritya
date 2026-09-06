import { Text } from "ink";
import type { ProjectState } from "../agent/workflow.js";
import { displayModelId } from "../config/models.js";

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
  budgetPct: number;
  budgetStopped: boolean;
  totalCost: number;
  sandboxActive: boolean;
  persistenceWarningCount: number;
  privacyMode: boolean;
}

/**
 * The single dim status bar pinned to the bottom of the screen. Keeps only
 * the fields worth glancing at on every render; everything else (context %,
 * task checklist, elapsed time, token counts, workspace path, verbose flag)
 * moved to the on-demand `/status` command — see CommandContext.statusReport
 * in src/commands/registry.ts.
 */
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
  budgetPct,
  budgetStopped,
  totalCost,
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
      {displayModelId(provider, model)}
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
      {budgetStopped || budgetPct >= 80 ? (
        <Text color={budgetStopped ? "red" : "yellow"}> · budget {budgetPct}%</Text>
      ) : (
        ""
      )}
      {totalCost > 0 ? ` · $${totalCost.toFixed(4)}` : ""}
      {persistenceWarningCount > 0 ? (
        <Text color="yellow"> · ⚠ persistence warnings: {persistenceWarningCount}</Text>
      ) : (
        ""
      )}
      {privacyMode ? <Text color="cyan"> · privacy:on</Text> : ""}
      {" · /diff review · /undo revert · Ctrl+K stop · /status for details"}
    </Text>
  );
}
