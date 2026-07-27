import type { Agent } from "../agent/loop.js";
import { SessionStore, type SessionMeta } from "../session/store.js";
import type { ItemBody, Phase, TaskItem } from "../types.js";

export interface UseSessionResumeParams {
  agent: Agent;
  resumeSessions?: SessionMeta[];
  addItem(item: ItemBody): void;
  setPhase(p: Phase): void;
  setTasks(tasks: TaskItem[]): void;
}

/** Loading a saved session file into the agent's history and replaying its last few turns to the transcript. */
export function useSessionResume({
  agent,
  resumeSessions,
  addItem,
  setPhase,
  setTasks,
}: UseSessionResumeParams) {
  const agentLoadSession = (file: string): number => {
    const messages = SessionStore.loadFile(file);
    agent.loadHistory(messages);
    const replay = messages.filter(
      (m) =>
        (m.role === "user" || m.role === "assistant") &&
        typeof m.content === "string" &&
        m.content.trim() &&
        !(m.role === "user" && m.content.startsWith("["))
    );
    for (const m of replay.slice(-6)) {
      addItem({
        kind: m.role === "user" ? "user" : "assistant",
        text: String(m.content),
      });
    }
    return messages.length;
  };

  const onResumeSelect = (file: string) => {
    setPhase("input");
    if (!file) {
      addItem({ kind: "info", text: "Starting a fresh session." });
      return;
    }
    const meta = resumeSessions?.find((s) => s.file === file);
    const messages = agentLoadSession(file);
    const restoredTasks = SessionStore.loadTasksForSession(file);
    setTasks(restoredTasks);
    const done = restoredTasks.filter((t) => t.status === "done").length;
    const taskNote = restoredTasks.length
      ? ` — checklist restored (${done}/${restoredTasks.length} done)`
      : "";
    addItem({
      kind: "info",
      text: `Resumed session from ${meta?.date ?? "?"} (${messages} messages)${taskNote}.`,
    });
  };

  return { onResumeSelect };
}
