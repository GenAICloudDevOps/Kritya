import { useCallback, useRef, useState, type RefObject } from "react";
import type { Agent } from "../agent/loop.js";
import {
  cacheSavingsFor,
  costFor,
  crossedBudgetWarnThreshold,
  tokenBudgetFor,
} from "../agent/budget.js";
import { crossedContextWarnThreshold } from "../agent/contextWarning.js";
import type { CliConfig } from "../config/config.js";
import type { ItemBody, Usage } from "../types.js";

export interface UseUsageBudgetParams {
  agent: Agent;
  config: CliConfig;
  modelRef: { current: string };
  model: string;
  addItem(item: ItemBody): void;
  abortRef: RefObject<AbortController | null>;
}

/** Owns context/usage/cost tracking and the token-budget cap for the session. */
export function useUsageBudget({
  agent,
  config,
  modelRef,
  model,
  addItem,
  abortRef,
}: UseUsageBudgetParams) {
  const [usageByModel, setUsageByModel] = useState<Record<string, Usage>>({});
  const [ctxPct, setCtxPct] = useState(0);
  const ctxPctRef = useRef(0);
  const [tokenBudget, setTokenBudget] = useState(() => tokenBudgetFor(config));
  const [budgetPct, setBudgetPct] = useState(0);
  const budgetPctRef = useRef(0);
  const [budgetUsed, setBudgetUsed] = useState(0);
  const totalTokensRef = useRef(0);
  const [budgetStopped, setBudgetStopped] = useState(false);

  const totalUsage = Object.values(usageByModel).reduce(
    (acc, u) => ({
      promptTokens: acc.promptTokens + u.promptTokens,
      completionTokens: acc.completionTokens + u.completionTokens,
      cachedPromptTokens: (acc.cachedPromptTokens ?? 0) + (u.cachedPromptTokens ?? 0),
      estimated: acc.estimated || Boolean(u.estimated),
    }),
    { promptTokens: 0, completionTokens: 0, cachedPromptTokens: 0, estimated: false }
  );

  const totalCost = Object.entries(usageByModel).reduce((sum, [id, u]) => {
    const p = config.pricing?.[id];
    return p ? sum + costFor(u, p) : sum;
  }, 0);

  const costReport = useCallback(() => {
    const lines = Object.entries(usageByModel).map(([id, u]) => {
      const p = config.pricing?.[id];
      const dollars = p ? ` ≈ $${costFor(u, p).toFixed(4)}` : "";
      const cached = u.cachedPromptTokens ?? 0;
      const hitRate =
        cached > 0 && u.promptTokens > 0
          ? ` (${cached.toLocaleString()} cached, ${Math.round((cached / u.promptTokens) * 100)}% hit rate)`
          : "";
      // Some providers omit real token counts; those turns fall back to a
      // text-length estimate (see agent/loop.ts). Flag it here rather than
      // let an approximate number pass as an exact one.
      const estNote = u.estimated ? " (some figures estimated — provider didn't report usage)" : "";
      return `  ${id}: ${u.promptTokens.toLocaleString()} in${hitRate} / ${u.completionTokens.toLocaleString()} out${dollars}${estNote}`;
    });
    if (!lines.length) return "No usage yet this session.";
    const totalSavings = Object.entries(usageByModel).reduce((sum, [id, u]) => {
      const p = config.pricing?.[id];
      return p ? sum + cacheSavingsFor(u, p) : sum;
    }, 0);
    const savingsNote =
      totalSavings > 0 ? ` (saved $${totalSavings.toFixed(4)} via prompt caching)` : "";
    const total = totalCost > 0 ? `\nEstimated total: $${totalCost.toFixed(4)}${savingsNote}` : "";
    const ctxNote = `\nContext window: ${ctxPctRef.current}% used`;
    const budgetNote =
      `\nToken budget: ${budgetUsed.toLocaleString()} / ${tokenBudget.toLocaleString()} ` +
      `(${budgetPct}%)${budgetStopped ? " — STOPPED, run /budget reset or /budget <number>" : ""}`;
    const hint =
      totalCost > 0
        ? ""
        : `\nTip: add per-model prices (USD per 1M tokens) to ~/.kritya/config.json to see $ estimates:\n  "pricing": { "${model}": { "input": 0.6, "output": 2.4, "cachedInput": 0.15 } }\n("cachedInput" is optional — the discounted rate for cache-hit prompt tokens, for cache-savings reporting.)`;
    return `Usage this session:\n${lines.join("\n")}${total}${ctxNote}${budgetNote}${hint}`;
  }, [usageByModel, config, totalCost, budgetUsed, tokenBudget, budgetPct, budgetStopped, model]);

  const resetBudget = () => {
    totalTokensRef.current = 0;
    budgetPctRef.current = 0;
    setBudgetUsed(0);
    setBudgetPct(0);
    setBudgetStopped(false);
    addItem({ kind: "info", text: "Token budget usage reset for this session." });
  };

  const setBudgetLimit = (n: number) => {
    setTokenBudget(n);
    const pct = Math.min(999, Math.round((totalTokensRef.current / n) * 100));
    budgetPctRef.current = pct;
    setBudgetPct(pct);
    if (pct < 100) setBudgetStopped(false);
    addItem({ kind: "info", text: `Token budget set to ${n.toLocaleString()} for this session.` });
  };

  /** Feed a turn's reported usage into the running totals; call from onUsage. */
  const recordUsage = useCallback(
    (u: Usage) => {
      const pct = Math.round(agent.contextUsage() * 100);
      if (crossedContextWarnThreshold(ctxPctRef.current, pct)) {
        addItem({
          kind: "info",
          text: `⚠ Context usage at ${pct}% — kritya will auto-compact older history soon to stay within the model's context window.`,
        });
      }
      ctxPctRef.current = pct;
      setCtxPct(pct);
      const id = modelRef.current;
      setUsageByModel((prev) => ({
        ...prev,
        [id]: {
          promptTokens: (prev[id]?.promptTokens ?? 0) + u.promptTokens,
          completionTokens: (prev[id]?.completionTokens ?? 0) + u.completionTokens,
          cachedPromptTokens: (prev[id]?.cachedPromptTokens ?? 0) + (u.cachedPromptTokens ?? 0),
          // Once any turn's usage for this model was estimated rather
          // than provider-reported, the running total is no longer
          // exact — keep it flagged for the rest of the session.
          estimated: Boolean(prev[id]?.estimated) || Boolean(u.estimated),
        },
      }));

      totalTokensRef.current += u.promptTokens + u.completionTokens;
      setBudgetUsed(totalTokensRef.current);
      const bPct = Math.min(999, Math.round((totalTokensRef.current / tokenBudget) * 100));
      if (crossedBudgetWarnThreshold(budgetPctRef.current, bPct)) {
        addItem({
          kind: "info",
          text:
            `⚠ Token budget at ${bPct}% (${totalTokensRef.current.toLocaleString()} / ` +
            `${tokenBudget.toLocaleString()} tokens this session). kritya will stop once it ` +
            `hits 100% — run /budget to check or raise it.`,
        });
        agent.audit?.logTool({
          tool: "budget",
          summary: `token budget at ${bPct}% (${totalTokensRef.current}/${tokenBudget})`,
          outcome: "ok",
        });
        agent.turnSpan?.addEvent("budget.warn", { "kritya.budget_pct": bPct });
      }
      if (bPct >= 100 && budgetPctRef.current < 100) {
        addItem({
          kind: "info",
          text:
            `⛔ Token budget reached (${totalTokensRef.current.toLocaleString()} / ` +
            `${tokenBudget.toLocaleString()} tokens). Stopping further turns — run ` +
            `/budget reset to clear it, or /budget <number> to raise the cap.`,
        });
        agent.audit?.logTool({
          tool: "budget",
          summary: `token budget reached, stopping (${totalTokensRef.current}/${tokenBudget})`,
          outcome: "blocked",
        });
        agent.turnSpan?.addEvent("budget.stopped", { "kritya.budget_pct": bPct });
        setBudgetStopped(true);
        abortRef.current?.abort();
      }
      budgetPctRef.current = bPct;
      setBudgetPct(bPct);
    },
    [agent, addItem, modelRef, tokenBudget, abortRef]
  );

  return {
    usageByModel,
    totalUsage,
    totalCost,
    costReport,
    ctxPct,
    ctxPctRef,
    setCtxPct,
    tokenBudget,
    budgetPct,
    budgetUsed,
    budgetStopped,
    resetBudget,
    setBudgetLimit,
    recordUsage,
    totalTokensRef,
  };
}
