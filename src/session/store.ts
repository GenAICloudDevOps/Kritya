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
 * Short, typeable handle for a session — a 5-character base36 code derived
 * deterministically from the transcript's filename.
 *
 * The full id (the ISO timestamp basename) stays the on-disk name and the key
 * that correlates the audit log and telemetry spans, and nothing here changes
 * that. This is only what the user reads and retypes: `2026-10-06T19-08-39-123Z`
 * is not a thing anyone types twice, which is why the exit notice and the
 * `--resume` picker both show this instead.
 *
 * Derived rather than stored on purpose — there is no index file to drift out
 * of sync with the directory, and the code is stable for the life of the
 * transcript. Uniqueness is therefore *checked* at lookup time rather than
 * assumed: see resolveSession(), which reports an ambiguous prefix instead of
 * silently opening the wrong conversation.
 */
export function shortSessionId(file: string): string {
  const name = path.basename(file, ".jsonl");
  const digest = crypto.createHash("sha1").update(name).digest();
  // Low-order base36 digits, so the code is uniformly distributed over the
  // alphabet rather than clustered by the timestamp's shared prefix.
  return digest.readUInt32BE(0).toString(36).padStart(5, "0").slice(-5);
}

/**
 * Turn a first user message into a short, typeable session name:
 * "Fix the login bug!!" -> "fix-the-login-bug". Lowercase, runs of
 * non-alphanumerics become one hyphen, capped at 40 characters so the name
 * stays something a person will actually retype. Returns "" when nothing
 * usable remains (empty input, only punctuation).
 */
export function slugifySessionName(text: string): string {
  const slug = text
    .slice(0, 80)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return slug;
}

/**
 * Pull plain text out of a message for naming/preview purposes. Content can
 * be a string, an array of content parts (text + images), or null — images
 * contribute nothing to a name.
 */
function messageText(message: ChatMessage): string {
  const content = message.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((p): p is { type: "text"; text: string } => p.type === "text")
      .map((p) => p.text)
      .join(" ");
  }
  return "";
}

/**
 * The first message that may name a session: a real user message, not one of
 * the synthetic "[...]" notes the agent writes to itself (undo, summaries).
 * Mirrors the filter listSessions() uses for its preview, so the name and
 * the preview always agree about what the conversation is about.
 */
function nameableText(message: ChatMessage): string | undefined {
  if (message.role !== "user") return undefined;
  const text = messageText(message).replace(/\s+/g, " ").trim();
  if (!text || text.startsWith("[")) return undefined;
  return text;
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
  /**
   * Messages persisted to the current file so far. Tracked in memory rather
   * than re-read from disk because the exit notice needs it after the process
   * has already begun tearing down, where reading back a possibly 50 MB
   * transcript would be both slow and pointless.
   */
  private count = 0;

  /** When ephemeral, nothing is persisted to disk (used by subagents). */
  constructor(
    workspace: string,
    private ephemeral = false
  ) {
    this.dir = sessionDir(workspace);
    this.file = this.newFilePath();
  }

  /** How many messages this session has written. 0 means nothing is on disk yet. */
  get messageCount(): number {
    return this.count;
  }

  /**
   * Whether this file's name is settled — either a sidecar already exists
   * (written earlier, or by a previous process) or we just wrote one.
   * Reset by rotate(), which starts a new file that deserves its own name.
   */
  private nameResolved = false;

  /**
   * Name this session from its first real user message, once. Later messages
   * never rename it: the name is meant to stay stable so `-r <name>` keeps
   * working and the resume list doesn't shift under the user.
   */
  private maybeNameSession(message: ChatMessage): void {
    if (this.nameResolved || this.ephemeral) return;
    if (SessionStore.readName(this.file)) {
      this.nameResolved = true;
      return;
    }
    const text = nameableText(message);
    if (!text) return;
    const slug = slugifySessionName(text);
    if (!slug) return;
    try {
      writeSessionFile(SessionStore.nameFilePathFor(this.file), slug + "\n");
      this.nameResolved = true;
    } catch (err) {
      // Naming is cosmetic; never fail a turn over it.
      debugLog(`SessionStore.maybeNameSession(${this.file})`, err);
    }
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

  /**
   * What `-r <name>` and the exit notice call this session right now: the
   * auto-derived or user-set name, or the short hash code when unnamed.
   */
  get displayName(): string {
    return this.ephemeral ? this.id : SessionStore.displayName(this.file);
  }

  /**
   * Override the session's name (see /rename). Unlike the auto-derived name,
   * this is explicit: it replaces whatever was there. The slug rules are the
   * same — the name has to stay something `-r` can match. Returns the slug
   * that was set, or undefined when ephemeral or when nothing usable remains
   * (so the caller can say why instead of silently keeping the old name).
   */
  setName(raw: string): string | undefined {
    if (this.ephemeral) return undefined;
    const slug = slugifySessionName(raw);
    if (!slug) return undefined;
    try {
      fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      hardenWindowsDir(CONFIG_DIR);
      writeSessionFile(SessionStore.nameFilePathFor(this.file), slug + "\n");
    } catch (err) {
      debugLog(`SessionStore.setName(${this.file})`, err);
      return undefined;
    }
    this.nameResolved = true;
    return slug;
  }

  /** Path of the sidecar file that holds this session's task checklist. */
  private tasksFilePath(): string {
    return SessionStore.tasksFilePathFor(this.file);
  }

  private static tasksFilePathFor(sessionFile: string): string {
    return sessionFile.replace(/\.jsonl$/, ".tasks.json");
  }

  /**
   * Sidecar holding the session's human-readable name (see
   * slugifySessionName), written once from the first real user message.
   * A sidecar rather than a rename: the transcript filename is the session's
   * stable id for audit/telemetry correlation, and renaming it mid-session
   * would churn that id plus the tasks sidecar that keys off it.
   */
  private static nameFilePathFor(sessionFile: string): string {
    return sessionFile.replace(/\.jsonl$/, ".name");
  }

  /** The auto-derived name for a session file, if it earned one yet. */
  static readName(sessionFile: string): string | undefined {
    try {
      const name = fs.readFileSync(SessionStore.nameFilePathFor(sessionFile), "utf8").trim();
      return name || undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * What the user types and sees: the auto-derived name when the session has
   * one, otherwise the short hash code. Every surface that names a session —
   * the exit notice, the crash report, the `--resume` picker, `-r <name>` —
   * goes through here so they can never disagree.
   */
  static displayName(sessionFile: string): string {
    return SessionStore.readName(sessionFile) ?? shortSessionId(sessionFile);
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
    this.count = seed.length;
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
      this.count++;
      this.maybeNameSession(message);
    } catch (err) {
      // Persistence is best-effort; never crash the session over it.
      warnPersistenceFailure(`SessionStore.append(${this.file})`, err);
    }
  }

  /** Start over with a fresh session file (used by /clear). */
  rotate(): void {
    this.file = this.newFilePath();
    this.count = 0;
    // The new file deserves its own name, from its own first message.
    this.nameResolved = false;
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
      this.count = messages.length;
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

  /**
   * Turn a user-typed session handle into a transcript file.
   *
   * Accepts the short code shown by the exit notice and the `--resume` picker,
   * or the full timestamp basename, or any unambiguous prefix of either — the
   * whole point is that the user can retype something short. Deliberately
   * searches the entire directory rather than listSessions()' display window of
   * 20, so a code copied from an earlier exit notice still resolves.
   *
   * Returns an error string instead of throwing so the CLI can print it and
   * exit(1) without the caller having to distinguish "no such session" from
   * "ambiguous" itself.
   */
  static resolveSession(workspace: string, name: string): { file: string } | { error: string } {
    const query = name.trim().toLowerCase();
    if (!query) return { error: "No session name given." };

    const dir = sessionDir(workspace);
    let entries: string[];
    try {
      entries = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
    } catch {
      return { error: "No saved sessions for this directory yet." };
    }
    if (!entries.length) return { error: "No saved sessions for this directory yet." };

    // Keyed by file, not appended to a list: a query can prefix both a
    // transcript's short code *and* its timestamp basename (every basename
    // starts with the year), and counting that file twice would report a
    // perfectly unambiguous name as ambiguous.
    const matches = new Map<string, string>();
    for (const entry of entries) {
      const file = path.join(dir, entry);
      // Same containment check the IPC path uses — a symlink dropped into the
      // session directory must not turn `--resume <name>` into an arbitrary
      // file read.
      if (!SessionStore.isSessionFile(workspace, file)) continue;
      const base = path.basename(entry, ".jsonl").toLowerCase();
      const short = shortSessionId(file);
      const slug = SessionStore.readName(file)?.toLowerCase();
      if (
        short.startsWith(query) ||
        base.startsWith(query) ||
        (slug !== undefined && (slug === query || slug.startsWith(query)))
      )
        matches.set(file, short);
    }

    if (!matches.size) {
      return {
        error: `No session matching "${name}" in this directory. Run \`kritya -r\` to list them.`,
      };
    }
    if (matches.size > 1) {
      const codes = [...matches.values()].join(", ");
      return {
        error: `"${name}" matches ${matches.size} sessions (${codes}) — use more characters.`,
      };
    }
    return { file: [...matches.keys()][0] };
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
            fs.rmSync(SessionStore.nameFilePathFor(file), { force: true });
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
      sessions.push({
        file,
        date,
        preview,
        title,
        name: SessionStore.readName(file) ?? "",
        shortId: shortSessionId(file),
        count: lines.length,
      });
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
  /**
   * Auto-derived slug from the first user message ("" when the session never
   * earned one). Shown in the picker and accepted by `-r <name>`.
   */
  name: string;
  /** Short typeable handle (see shortSessionId) — what the picker shows and `-r <name>` accepts. */
  shortId: string;
  count: number;
}
