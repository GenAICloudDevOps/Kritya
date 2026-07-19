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
}

const MAX_ENTRIES = 100;

/**
 * Stack of file states captured before each agent write/edit, grouped by turn.
 * /undo reverts everything the most recent changing turn did and records the
 * inverse so /redo can reapply it. Making a new change clears the redo stack.
 */
export class UndoStack {
  private entries: UndoEntry[] = [];
  private redoStack: FileState[][] = [];
  private turn = 0;

  /** Mark the start of a new agent turn; subsequent snapshots group under it. */
  beginTurn(): void {
    this.turn++;
  }

  /** Capture the current state of a file before it is modified. */
  snapshot(absPath: string, relPath: string): void {
    this.entries.push({ relPath, absPath, content: readOrNull(absPath), turn: this.turn });
    // Evict whole turns, never part of one — a half-evicted turn would make
    // /undo silently restore only some of that turn's files. If a single turn
    // alone exceeds the cap, keep it intact rather than truncate it.
    while (
      this.entries.length > MAX_ENTRIES &&
      this.entries[0].turn !== this.entries[this.entries.length - 1].turn
    ) {
      const oldest = this.entries[0].turn;
      while (this.entries.length && this.entries[0].turn === oldest) this.entries.shift();
    }
    // A fresh change invalidates any redo history.
    this.redoStack = [];
  }

  get size(): number {
    return this.entries.length;
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
      results.push(restore(entry));
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
      results.push(restore(state));
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
