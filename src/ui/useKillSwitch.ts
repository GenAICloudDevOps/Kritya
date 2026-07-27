import { useState, type RefObject } from "react";
import type { Agent } from "../agent/loop.js";
import type { ItemBody, Phase } from "../types.js";
import type { PendingPermission } from "./useAgent.js";

export interface UseKillSwitchParams {
  agent: Agent;
  addItem(item: ItemBody): void;
  abortRef: RefObject<AbortController | null>;
  permission: PendingPermission | null;
  setPermission(p: PendingPermission | null): void;
  setInFlight(v: { id: string; name: string; summary: string }[]): void;
  setActivity(v: string | null): void;
  setStream(v: string): void;
  setThinking(v: boolean): void;
  setPhase(v: Phase): void;
}

/** The line shown for anything the user tries while the switch is engaged. */
export function killActiveNotice(reason?: string): string {
  return (
    `⛔ Kill switch ACTIVE${reason ? ` — ${reason}` : ""}. Nothing will run. ` +
    `Release it with /kill off.`
  );
}

/** Owns the kill-switch UI state: engaging/releasing it and tearing down whatever turn was in flight. */
export function useKillSwitch({
  agent,
  addItem,
  abortRef,
  permission,
  setPermission,
  setInFlight,
  setActivity,
  setStream,
  setThinking,
  setPhase,
}: UseKillSwitchParams) {
  const [killed, setKilled] = useState(agent.kill.active);
  const [killReason, setKillReason] = useState<string | undefined>(agent.kill.reason);

  /**
   * Engage the kill switch: abort the in-flight turn, answer any open
   * permission prompt with "no" (otherwise the tool call would hang forever
   * waiting on a promise nobody will resolve), and drop back to the input
   * line. The agent-side gates in agent/loop.ts are what actually enforce it;
   * this is the UI half.
   */
  const engageKill = (reason?: string) => {
    if (!agent.kill.engage(reason)) return; // already engaged
    setKilled(true);
    setKillReason(agent.kill.reason);
    abortRef.current?.abort();
    permission?.resolve("no");
    setPermission(null);
    setInFlight([]);
    setActivity(null);
    setStream("");
    setThinking(false);
    setPhase("input");
    agent.audit?.logTool({
      tool: "kill-switch",
      summary: `kill switch engaged${agent.kill.reason ? `: ${agent.kill.reason}` : ""}`,
      outcome: "blocked",
    });
    agent.turnSpan?.addEvent("kill_switch.engaged", {
      "kritya.kill_reason": agent.kill.reason ?? "",
    });
    process.stdout.write("\x07"); // bell: something just stopped hard
    addItem({
      kind: "info",
      text:
        `⛔ KILL SWITCH ENGAGED${agent.kill.reason ? ` — ${agent.kill.reason}` : ""}.\n` +
        `Everything in flight was aborted; no model calls, tools, or subagents will run.\n` +
        `Release it with /kill off when you're ready to continue.`,
    });
  };

  const releaseKill = () => {
    if (!agent.kill.release()) {
      addItem({ kind: "info", text: "The kill switch isn't engaged." });
      return;
    }
    setKilled(false);
    setKillReason(undefined);
    agent.audit?.logTool({
      tool: "kill-switch",
      summary: "kill switch released",
      outcome: "ok",
    });
    addItem({
      kind: "info",
      text: "Kill switch released — the agent can run again. The interrupted turn is not resumed; send a new message.",
    });
  };

  return { killed, killReason, engageKill, releaseKill };
}
