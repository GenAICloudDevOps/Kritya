import fs from "node:fs";
import path from "node:path";

interface FileState {
  relPath: string;
  absPath: string;
  /** File content to restore; null means the file should not exist. */
  content: string | null;
}

interface UndoEntry extends FileState {
  /** Which agent turn made this change; undo/redo operate a whole turn at a time. */
  turn: number;
  /** True if this checkpoint came from a file-watcher detecting an edit kritya didn't make. */
  external?: boolean;
}

const MAX_ENTRIES = 100;
// A watcher event this soon after our own snapshot() is treated as kritya's
// own write settling to disk, not an external edit — write+watch-event
// latency on a local disk is milliseconds, so this is a generous margin.
const OWN_WRITE_GRACE_MS = 750;
// One logical write can fire several raw filesystem events (create, write,
// close); wait for them to go quiet before reading the file, so we don't
// catch it mid-write.
const WATCHER_DEBOUNCE_MS = 100;

/**
 * Stack of file states captured before each agent write/edit, grouped by turn.
 * /undo reverts everything the most recent changing turn did and records the
 * inverse so /redo can reapply it. Making a new change clears the redo stack.
 *
 * Also watches every file kritya has touched this session for changes made
 * outside kritya (the user editing in their own editor between turns) and
 * checkpoints those too, as their own undo-able step in the right
 * chronological position — instead of only implicitly and fragilely
 * preserving them via whatever the redo stack happens to capture.
 */
export class UndoStack {
  private entries: UndoEntry[] = [];
  private redoStack: FileState[][] = [];
  private turn = 0;

  // File-watcher checkpointing. Scoped to files kritya has itself snapshotted
  // this session — never a whole-repo recursive watch — so this can't pick up
  // noise from build output, node_modules, or unrelated files, and can't leak
  // anything not already touched by an undo-tracked write.
  private trackedFiles = new Map<string, string>(); // absPath -> relPath
  private lastKnownContent = new Map<string, string | null>(); // absPath -> content we believe is on disk
  private lastOwnWriteAt = new Map<string, number>(); // absPath -> Date.now() of our last snapshot()
  private watchedDirs = new Map<string, fs.FSWatcher>(); // parent dir -> watcher
  private debounceTimers = new Map<string, NodeJS.Timeout>(); // absPath -> pending settle check
  private ownWriteSyncTimers = new Map<string, NodeJS.Timeout>(); // absPath -> pending self-write re-read
  /** Fires when a file-watcher checkpoint is created for an external edit. */
  onExternalChange?: (relPath: string) => void;

  /** Mark the start of a new agent turn; subsequent snapshots group under it. */
  beginTurn(): void {
    this.turn++;
  }

  /** Capture the current state of a file before it is modified. */
  snapshot(absPath: string, relPath: string): void {
    this.entries.push({ relPath, absPath, content: readOrNull(absPath), turn: this.turn });
    this.evictOldestTurnsOverCap();
    // A fresh change invalidates any redo history.
    this.redoStack = [];
    this.lastOwnWriteAt.set(absPath, Date.now());
    this.watchForExternalEdits(absPath, relPath);
    this.scheduleOwnWriteSync(absPath);
  }

  /**
   * Re-read the file once the own-write grace window closes, and record that
   * as what we believe is on disk.
   *
   * `lastKnownContent` used to be updated only when a watcher event arrived,
   * which quietly assumed every write produces one. macOS coalesces FSEvents
   * and can drop the event for a write that lands just after the watch is
   * registered — and when the event for *our own* write goes missing, the
   * baseline stays at whatever it was before (typically null, for a file we
   * just created). The next genuine hand-edit is then checkpointed against
   * that null, and undoing it deletes the user's file rather than restoring
   * it. Reading the file ourselves removes the dependency on the event.
   */
  private scheduleOwnWriteSync(absPath: string): void {
    const existing = this.ownWriteSyncTimers.get(absPath);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.ownWriteSyncTimers.delete(absPath);
      // Only meaningful while the grace window is the reason we'd ignore a
      // change; a checkpoint taken in the meantime already set the baseline.
      this.lastKnownContent.set(absPath, readOrNull(absPath));
    }, OWN_WRITE_GRACE_MS);
    timer.unref();
    this.ownWriteSyncTimers.set(absPath, timer);
  }

  /** Evict whole turns, never part of one — a half-evicted turn would make
   *  /undo silently restore only some of that turn's files. If a single turn
   *  alone exceeds the cap, keep it intact rather than truncate it. */
  private evictOldestTurnsOverCap(): void {
    while (
      this.entries.length > MAX_ENTRIES &&
      this.entries[0].turn !== this.entries[this.entries.length - 1].turn
    ) {
      const oldest = this.entries[0].turn;
      while (this.entries.length && this.entries[0].turn === oldest) this.entries.shift();
    }
  }

  /** Starts watching `absPath`'s parent directory the first time we see this file. */
  private watchForExternalEdits(absPath: string, relPath: string): void {
    if (this.trackedFiles.has(absPath)) return;
    this.trackedFiles.set(absPath, relPath);
    this.lastKnownContent.set(absPath, readOrNull(absPath));

    // Watch the parent directory, not the file itself: many editors save by
    // writing a temp file and renaming it over the original, which would
    // silently stop a watch on the file's own (now-replaced) inode.
    const dir = path.dirname(absPath);
    if (this.watchedDirs.has(dir)) return;
    try {
      const watcher = fs.watch(dir, (_eventType, filename) => {
        if (!filename) return;
        const target = path.join(dir, filename);
        if (this.trackedFiles.has(target)) this.scheduleWatcherCheck(target);
      });
      watcher.on("error", () => {
        // Best-effort: undo still works via normal snapshotting even if the
        // watcher errors out (e.g. the directory was removed).
      });
      // Don't let a background checkpoint watcher keep the process alive —
      // closeAll() closes these explicitly on normal exit, but nothing else
      // (tests, a crash path, an unexpected early return) should hang waiting
      // on a handle that only exists for a nice-to-have.
      watcher.unref();
      this.watchedDirs.set(dir, watcher);
    } catch {
      // Watching isn't available (platform limits, permissions, etc.) — the
      // rest of undo/redo is unaffected, we just won't catch hand edits.
    }
  }

  /**
   * A single logical write (create + write + close) can fire several raw
   * filesystem events, and reading the file synchronously on the first one
   * can catch it mid-write (e.g. truncated to empty). Debounce so we only
   * ever inspect the file once it's settled.
   */
  private scheduleWatcherCheck(absPath: string): void {
    const existing = this.debounceTimers.get(absPath);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.debounceTimers.delete(absPath);
      this.handleWatcherEvent(absPath);
    }, WATCHER_DEBOUNCE_MS);
    timer.unref();
    this.debounceTimers.set(absPath, timer);
  }

  private handleWatcherEvent(absPath: string): void {
    const relPath = this.trackedFiles.get(absPath);
    if (!relPath) return;
    const current = readOrNull(absPath);
    const isOwnWrite = Date.now() - (this.lastOwnWriteAt.get(absPath) ?? 0) < OWN_WRITE_GRACE_MS;
    const known = this.lastKnownContent.get(absPath) ?? null;
    this.lastKnownContent.set(absPath, current);
    if (isOwnWrite || current === known) return; // our own write, or no real change

    this.turn++;
    this.entries.push({ relPath, absPath, content: known, turn: this.turn, external: true });
    this.evictOldestTurnsOverCap();
    this.redoStack = [];
    this.onExternalChange?.(relPath);
  }

  /** Stop all file watchers — call on process exit to avoid dangling handles. */
  closeAll(): void {
    for (const watcher of this.watchedDirs.values()) {
      try {
        watcher.close();
      } catch {
        // best-effort
      }
    }
    this.watchedDirs.clear();
    for (const timer of this.debounceTimers.values()) clearTimeout(timer);
    this.debounceTimers.clear();
    for (const timer of this.ownWriteSyncTimers.values()) clearTimeout(timer);
    this.ownWriteSyncTimers.clear();
  }

  get size(): number {
    return this.entries.length;
  }

  /** The current turn counter — used to mark a checkpoint's position in time. */
  currentTurn(): number {
    return this.turn;
  }

  /**
   * Revert every file change made after `targetTurn` — used by /rewind to roll
   * the files back to a checkpoint. Reverts one turn at a time via undo(), so
   * each reverted turn is still individually redoable afterwards. Returns a
   * summary, or null if nothing newer than the checkpoint needed reverting.
   */
  rewindTo(targetTurn: number): string | null {
    const results: string[] = [];
    while (this.entries.length && this.entries[this.entries.length - 1].turn > targetTurn) {
      const result = this.undo();
      if (result === null) break;
      results.push(result);
    }
    return results.length ? results.join("\n") : null;
  }

  /** Revert every change from the most recent changing turn. Returns a description, or null if empty. */
  undo(): string | null {
    const last = this.entries[this.entries.length - 1];
    if (!last) return null;
    const turn = last.turn;
    const group: UndoEntry[] = [];
    while (this.entries.length && this.entries[this.entries.length - 1].turn === turn) {
      group.push(this.entries.pop()!);
    }
    const redoGroup: FileState[] = [];
    const results: string[] = [];
    for (const entry of group) {
      redoGroup.push({
        relPath: entry.relPath,
        absPath: entry.absPath,
        content: readOrNull(entry.absPath),
      });
      // undo/redo's own restores must not be mistaken for external edits by
      // the file watcher — mark them the same way snapshot() marks a write.
      this.lastOwnWriteAt.set(entry.absPath, Date.now());
      results.push(restore(entry));
      this.lastKnownContent.set(entry.absPath, entry.content);
    }
    this.redoStack.push(redoGroup);
    return summarize(results, "Reverted");
  }

  /** Reapply the most recently undone turn. Returns a description, or null if nothing to redo. */
  redo(): string | null {
    const group = this.redoStack.pop();
    if (!group) return null;
    this.turn++;
    const results: string[] = [];
    for (const state of group) {
      this.entries.push({ ...state, content: readOrNull(state.absPath), turn: this.turn });
      this.lastOwnWriteAt.set(state.absPath, Date.now());
      results.push(restore(state));
      this.lastKnownContent.set(state.absPath, state.content);
    }
    return summarize(results, "Reapplied");
  }
}

// "latin1" maps each byte 0-255 to the same code point, so it round-trips
// arbitrary binary content (docx/xlsx/pptx/pdf) losslessly, unlike "utf8"
// which would corrupt byte sequences that aren't valid UTF-8.
function readOrNull(absPath: string): string | null {
  try {
    return fs.readFileSync(absPath, "latin1");
  } catch {
    return null;
  }
}

function restore(state: FileState): string {
  if (state.content === null) {
    try {
      fs.unlinkSync(state.absPath);
    } catch {
      return `Nothing to remove: ${state.relPath}`;
    }
    return `Removed ${state.relPath}`;
  }
  fs.mkdirSync(path.dirname(state.absPath), { recursive: true });
  fs.writeFileSync(state.absPath, state.content, "latin1");
  return `Restored ${state.relPath}`;
}

function summarize(results: string[], verb: string): string {
  return results.length === 1
    ? results[0]
    : `${verb} ${results.length} files:\n  ${results.join("\n  ")}`;
}
