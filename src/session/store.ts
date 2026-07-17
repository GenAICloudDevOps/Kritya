import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { CONFIG_DIR } from "../config/config.js";
import type { ChatMessage } from "../types.js";

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

  /** Begin a session, optionally seeded with resumed history. */
  start(seed: ChatMessage[] = []): void {
    if (this.ephemeral) return;
    fs.mkdirSync(this.dir, { recursive: true });
    if (seed.length) {
      fs.writeFileSync(this.file, seed.map((m) => JSON.stringify(m) + "\n").join(""));
    }
  }

  append(message: ChatMessage): void {
    if (this.ephemeral) return;
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      fs.appendFileSync(this.file, JSON.stringify(message) + "\n");
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

  static loadLatest(workspace: string): ChatMessage[] | null {
    const latest = SessionStore.listSessions(workspace)[0];
    if (!latest) return null;
    const messages = SessionStore.loadFile(latest.file);
    return messages.length ? messages : null;
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
