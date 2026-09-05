import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { writeFileAtomicSync } from "../atomicWrite.js";
import { CONFIG_DIR } from "../config/config.js";
import { hardenWindowsDir } from "../config/winAcl.js";
import { debugLog, warnPersistenceFailure } from "../config/debug.js";
import type { ChatMessage, TaskItem } from "../types.js";

/**
 * A session file loaded whole into memory has no upper bound otherwise —
 * `--continue` on a pathologically large transcript (corruption, a runaway
 * write loop, or an adversarial file dropped into the session directory)
 * would try to allocate the entire thing at once. Above this size, only the
 * most recent bytes are read; older history is dropped rather than the
 * resume failing outright.
 */
const MAX_SESSION_FILE_BYTES = 50 * 1024 * 1024;

/**
 * Upper bound on a single message body persisted to a session file. Guards
 * against a runaway model response or tool result ballooning the transcript
 * — the live in-memory turn is unaffected, only what gets written to disk
 * (and so what a future `loadFile` would have to hold in memory at once).
 */
const MAX_MESSAGE_CONTENT_CHARS = 2_000_000;

/** Cap `message.content` in place when it's a plain string over the limit. */
function capMessageContent(message: ChatMessage): ChatMessage {
  if (typeof message.content !== "string" || message.content.length <= MAX_MESSAGE_CONTENT_CHARS) {
    return message;
  }
  return {
    ...message,
    content:
      message.content.slice(0, MAX_MESSAGE_CONTENT_CHARS) +
      `\n... [truncated, ${message.content.length - MAX_MESSAGE_CONTENT_CHARS} more characters]`,
  } as ChatMessage;
}

/**
 * Read `filePath`, capped to the last `maxBytes` bytes when it exceeds that
 * size. The byte cut can land mid-line, so the leading partial line is
 * dropped — callers parse one JSON message per line and would otherwise
 * choke on (or silently misparse) a truncated first line.
 */
export function readSessionFileCapped(filePath: string, maxBytes = MAX_SESSION_FILE_BYTES): string {
  const size = fs.statSync(filePath).size;
  if (size <= maxBytes) return fs.readFileSync(filePath, "utf8");

  const fd = fs.openSync(filePath, "r");
  try {
    const buffer = Buffer.alloc(maxBytes);
    fs.readSync(fd, buffer, 0, maxBytes, size - maxBytes);
    const text = buffer.toString("utf8");
    const firstNewline = text.indexOf("\n");
    return firstNewline === -1 ? "" : text.slice(firstNewline + 1);
  } finally {
    fs.closeSync(fd);
  }
}

function sessionDir(workspace: string): string {
  const hash = crypto.createHash("sha1").update(workspace).digest("hex").slice(0, 12);
  return path.join(CONFIG_DIR, "sessions", hash);
}

/**
 * Transcripts can contain secrets that passed through tool output, so they are
 * always written 0o600 rather than inheriting whatever mode the file had.
 * writeFileAtomicSync is the shared implementation (see src/atomicWrite.ts):
 * a sibling temp file renamed over the target, so a crash mid-write can never
 * leave a half-written transcript behind.
 */
function writeSessionFile(filePath: string, data: string): void {
  writeFileAtomicSync(filePath, data, { mode: 0o600 });
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

  /**
   * Stable identifier for this session (the transcript file's basename), used
   * to correlate the audit log and telemetry spans with the session. Updates
   * when the session rotates via reset(), so all three stay in lockstep.
   */
  get id(): string {
    return path.basename(this.file, ".jsonl");
  }

  /**
   * Absolute path of this session's transcript, or undefined when ephemeral
   * (nothing is on disk). Used by the crash handler to tell the user where the
   * conversation survives — a crash is exactly when that matters.
   */
  get path(): string | undefined {
    return this.ephemeral ? undefined : this.file;
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
      hardenWindowsDir(CONFIG_DIR);
      if (!tasks.length) {
        fs.rmSync(this.tasksFilePath(), { force: true });
        return;
      }
      writeSessionFile(this.tasksFilePath(), JSON.stringify(tasks));
    } catch (err) {
      warnPersistenceFailure(`SessionStore.saveTasks(${this.tasksFilePath()})`, err);
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
    hardenWindowsDir(CONFIG_DIR);
    if (seed.length) {
      writeSessionFile(
        this.file,
        seed.map((m) => JSON.stringify(capMessageContent(m)) + "\n").join("")
      );
    }
  }

  /**
   * Appends one JSON-encoded message per call — a crash mid-write can only
   * ever corrupt the single line currently being written, never anything
   * appended before it (each prior line was already a completed, separate
   * write). loadFile/matchesContent/listSessions all parse line-by-line and
   * skip a line that fails JSON.parse, so a truncated last line loses at
   * most that one message rather than the whole session.
   */
  append(message: ChatMessage): void {
    if (this.ephemeral) return;
    try {
      fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      hardenWindowsDir(CONFIG_DIR);
      fs.appendFileSync(this.file, JSON.stringify(capMessageContent(message)) + "\n", {
        mode: 0o600,
      });
    } catch (err) {
      // Persistence is best-effort; never crash the session over it.
      warnPersistenceFailure(`SessionStore.append(${this.file})`, err);
    }
  }

  /** Start over with a fresh session file (used by /clear). */
  rotate(): void {
    this.file = this.newFilePath();
  }

  /**
   * Rewrite the session file to hold exactly `messages`, atomically. The log
   * is otherwise append-only; this is the one place it's rewound — used by
   * /rewind to drop the messages after a checkpoint. The atomic write means a
   * reader (e.g. a concurrent --continue) never sees a half-written file.
   */
  overwrite(messages: ChatMessage[]): void {
    if (this.ephemeral) return;
    try {
      fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      hardenWindowsDir(CONFIG_DIR);
      writeSessionFile(
        this.file,
        messages.map((m) => JSON.stringify(capMessageContent(m)) + "\n").join("")
      );
    } catch (err) {
      // Persistence is best-effort; never crash the session over it.
      warnPersistenceFailure(`SessionStore.overwrite(${this.file})`, err);
    }
  }

  /**
   * True if `filePath` is a real session transcript belonging to `workspace`
   * — i.e. resolves inside that workspace's session directory. Callers that
   * accept a session path from outside the process (e.g. the Electron
   * renderer over IPC) must check this before loading it: without it,
   * "load this session" is really "read any file the OS user can read".
   *
   * The lexical check (path.relative on the unresolved names) only rules out
   * `..` segments in the string itself — it doesn't notice a symlink planted
   * inside the session directory that points somewhere else entirely. Such a
   * symlink would have a path that lexically resolves inside the session dir
   * while the filesystem happily follows it out. Canonicalizing with
   * fs.realpathSync and re-checking containment against that catches it: a
   * symlink escaping the directory resolves to a real path outside it and
   * gets rejected, exactly like an out-of-tree file would.
   */
  static isSessionFile(workspace: string, filePath: string): boolean {
    const dir = sessionDir(workspace);
    const resolved = path.resolve(dir, filePath);
    const relative = path.relative(dir, resolved);
    if (
      !resolved.endsWith(".jsonl") ||
      relative === "" ||
      relative.startsWith("..") ||
      path.isAbsolute(relative)
    ) {
      return false;
    }
    let realDir: string;
    let realFile: string;
    try {
      realDir = fs.realpathSync(dir);
      realFile = fs.realpathSync(resolved);
    } catch {
      // Doesn't exist, or a component along the way isn't accessible —
      // either way there's nothing real to load.
      return false;
    }
    const realRelative = path.relative(realDir, realFile);
    if (realRelative === "" || realRelative.startsWith("..") || path.isAbsolute(realRelative)) {
      return false;
    }
    try {
      return fs.statSync(realFile).isFile();
    } catch {
      return false;
    }
  }

  static loadFile(filePath: string): ChatMessage[] {
    const messages: ChatMessage[] = [];
    let raw: string;
    try {
      raw = readSessionFileCapped(filePath);
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
      raw = readSessionFileCapped(filePath);
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

  /**
   * Delete session files older than `retentionDays` across all workspaces.
   * Best-effort. 0 or negative means "keep forever" — auto-delete is
   * disabled rather than treated as an immediate-expiry retention window.
   */
  static cleanupOldSessions(retentionDays: number): void {
    if (retentionDays <= 0) return;
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
        } catch (err) {
          debugLog(`SessionStore.cleanupOldSessions(${file})`, err);
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
