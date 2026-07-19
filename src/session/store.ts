import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { CONFIG_DIR } from "../config/config.js";
import type { ChatMessage, TaskItem } from "../types.js";

function sessionDir(workspace: string): string {
  const hash = crypto.createHash("sha1").update(workspace).digest("hex").slice(0, 12);
  return path.join(CONFIG_DIR, "sessions", hash);
}

/**
 * Persists the conversation as one JSON message per line. A session maps to
 * one file; --continue reloads the most recent file for the workspace.
 */
export class SessionStore {
  private dir: string;
  private file: string;

  /** When ephemeral, nothing is persisted to disk (used by subagents). */
  constructor(
    workspace: string,
    private ephemeral = false
  ) {
    this.dir = sessionDir(workspace);
    this.file = this.newFilePath();
  }

  private newFilePath(): string {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    return path.join(this.dir, `${stamp}.jsonl`);
  }

  /** Path of the sidecar file that holds this session's task checklist. */
  private tasksFilePath(): string {
    return SessionStore.tasksFilePathFor(this.file);
  }

  private static tasksFilePathFor(sessionFile: string): string {
    return sessionFile.replace(/\.jsonl$/, ".tasks.json");
  }

  /**
   * Persists the current task checklist alongside the session, so `-c`/`-r`
   * can restore not just the conversation but what was done vs. pending.
   * Best-effort, same as append() — never let this crash a turn.
   */
  saveTasks(tasks: TaskItem[]): void {
    if (this.ephemeral) return;
    try {
      fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      if (!tasks.length) {
        fs.rmSync(this.tasksFilePath(), { force: true });
        return;
      }
      fs.writeFileSync(this.tasksFilePath(), JSON.stringify(tasks), { mode: 0o600 });
    } catch {
      // best-effort
    }
  }

  /** Loads the task checklist saved alongside a given session file, if any. */
  static loadTasksForSession(sessionFile: string): TaskItem[] {
    try {
      const raw = fs.readFileSync(SessionStore.tasksFilePathFor(sessionFile), "utf8");
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(
        (t): t is TaskItem =>
          !!t &&
          typeof t === "object" &&
          typeof (t as TaskItem).text === "string" &&
          ["pending", "in_progress", "done"].includes((t as TaskItem).status)
      );
    } catch {
      return [];
    }
  }

  /** Begin a session, optionally seeded with resumed history. */
  start(seed: ChatMessage[] = []): void {
    if (this.ephemeral) return;
    // Session transcripts can contain secrets that passed through tool
    // output — keep them readable only by the owner.
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    if (seed.length) {
      fs.writeFileSync(this.file, seed.map((m) => JSON.stringify(m) + "\n").join(""), {
        mode: 0o600,
      });
    }
  }

  append(message: ChatMessage): void {
    if (this.ephemeral) return;
    try {
      fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      fs.appendFileSync(this.file, JSON.stringify(message) + "\n", { mode: 0o600 });
    } catch {
      // Persistence is best-effort; never crash the session over it.
    }
  }

  /** Start over with a fresh session file (used by /clear). */
  rotate(): void {
    this.file = this.newFilePath();
  }

  static loadFile(filePath: string): ChatMessage[] {
    const messages: ChatMessage[] = [];
    let raw: string;
    try {
      raw = fs.readFileSync(filePath, "utf8");
    } catch {
      return messages;
    }
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        messages.push(JSON.parse(line) as ChatMessage);
      } catch {
        // Skip corrupt lines rather than failing the resume.
      }
    }
    return messages;
  }

  /** Lines of a session file, one JSON message per non-blank line (unparsed). */
  private static readLines(filePath: string): string[] {
    let raw: string;
    try {
      raw = fs.readFileSync(filePath, "utf8");
    } catch {
      return [];
    }
    return raw.split("\n").filter((line) => line.trim());
  }

  /** True if any message's content in the session file contains query (case-insensitive). Used for --resume search beyond the title preview. */
  static matchesContent(filePath: string, query: string): boolean {
    if (!query.trim()) return true;
    const needle = query.toLowerCase();
    for (const line of SessionStore.readLines(filePath)) {
      let message: ChatMessage;
      try {
        message = JSON.parse(line) as ChatMessage;
      } catch {
        continue;
      }
      if (typeof message.content === "string" && message.content.toLowerCase().includes(needle)) {
        return true;
      }
    }
    return false;
  }

  /** Delete session files older than `retentionDays` across all workspaces. Best-effort. */
  static cleanupOldSessions(retentionDays = 30): void {
    const root = path.join(CONFIG_DIR, "sessions");
    const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    let dirs: string[];
    try {
      dirs = fs.readdirSync(root);
    } catch {
      return;
    }
    for (const d of dirs) {
      const dir = path.join(root, d);
      let files: string[];
      try {
        files = fs.readdirSync(dir);
      } catch {
        continue;
      }
      for (const f of files) {
        if (!f.endsWith(".jsonl")) continue;
        const file = path.join(dir, f);
        try {
          if (fs.statSync(file).mtimeMs < cutoff) {
            fs.unlinkSync(file);
            fs.rmSync(SessionStore.tasksFilePathFor(file), { force: true });
          }
        } catch {
          // best-effort
        }
      }
    }
  }

  static loadLatest(workspace: string): ChatMessage[] | null {
    const latest = SessionStore.listSessions(workspace)[0];
    if (!latest) return null;
    const messages = SessionStore.loadFile(latest.file);
    return messages.length ? messages : null;
  }

  /** The task checklist saved alongside the most recent session for `workspace`, if any. */
  static loadLatestTasks(workspace: string): TaskItem[] {
    const latest = SessionStore.listSessions(workspace)[0];
    return latest ? SessionStore.loadTasksForSession(latest.file) : [];
  }

  /** Sessions for a workspace, newest first, with a preview of the first user message. */
  static listSessions(workspace: string): SessionMeta[] {
    const dir = sessionDir(workspace);
    let files: string[];
    try {
      files = fs
        .readdirSync(dir)
        .filter((f) => f.endsWith(".jsonl"))
        .sort()
        .reverse();
    } catch {
      return [];
    }
    const sessions: SessionMeta[] = [];
    for (const f of files.slice(0, 20)) {
      const file = path.join(dir, f);
      const lines = SessionStore.readLines(file);
      if (!lines.length) continue;
      let cleaned = "";
      for (const line of lines) {
        let message: ChatMessage;
        try {
          message = JSON.parse(line) as ChatMessage;
        } catch {
          continue; // skip corrupt lines rather than failing the preview
        }
        if (
          message.role === "user" &&
          typeof message.content === "string" &&
          message.content.trim() &&
          !message.content.startsWith("[") // skip synthetic notes (undo, summaries)
        ) {
          cleaned = message.content.replace(/\s+/g, " ").trim();
          break;
        }
      }
      const preview = cleaned ? cleaned.slice(0, 60) : "(no preview)";
      const title = cleaned ? cleaned.slice(0, 48) : "(untitled session)";
      let date = "";
      try {
        date = fs.statSync(file).mtime.toLocaleString();
      } catch {
        // leave empty
      }
      sessions.push({ file, date, preview, title, count: lines.length });
    }
    return sessions;
  }
}

export interface SessionMeta {
  file: string;
  date: string;
  preview: string;
  /** First user message, cleaned, for display and search in --resume. */
  title: string;
  count: number;
}
