import fs from "node:fs";
import path from "node:path";

interface UndoEntry {
  relPath: string;
  absPath: string;
  /** File content before the change; null if the file did not exist. */
  prevContent: string | null;
  /** Which agent turn made this change; /undo reverts a whole turn. */
  turn: number;
}

const MAX_ENTRIES = 50;

/**
 * Stack of file states captured before each agent write/edit. Entries are
 * grouped by turn so /undo reverts everything the last turn changed.
 */
export class UndoStack {
  private entries: UndoEntry[] = [];
  private turn = 0;

  /** Mark the start of a new agent turn; subsequent snapshots group under it. */
  beginTurn(): void {
    this.turn++;
  }

  /** Capture the current state of a file before it is modified. */
  snapshot(absPath: string, relPath: string): void {
    let prevContent: string | null = null;
    try {
      prevContent = fs.readFileSync(absPath, "utf8");
    } catch {
      prevContent = null;
    }
    this.entries.push({ relPath, absPath, prevContent, turn: this.turn });
    if (this.entries.length > MAX_ENTRIES) this.entries.shift();
  }

  get size(): number {
    return this.entries.length;
  }

  /** Revert every change from the most recent turn that changed files. Returns a description, or null if empty. */
  undo(): string | null {
    const last = this.entries[this.entries.length - 1];
    if (!last) return null;
    const turn = last.turn;
    const results: string[] = [];
    while (this.entries.length && this.entries[this.entries.length - 1].turn === turn) {
      const entry = this.entries.pop()!;
      results.push(this.revert(entry));
    }
    return results.length === 1
      ? results[0]
      : `Reverted ${results.length} file changes from the last turn:\n  ${results.join("\n  ")}`;
  }

  private revert(entry: UndoEntry): string {
    if (entry.prevContent === null) {
      try {
        fs.unlinkSync(entry.absPath);
      } catch {
        return `Nothing to delete: ${entry.relPath} no longer exists`;
      }
      return `Deleted ${entry.relPath} (it did not exist before the change)`;
    }
    fs.mkdirSync(path.dirname(entry.absPath), { recursive: true });
    fs.writeFileSync(entry.absPath, entry.prevContent, "utf8");
    return `Restored ${entry.relPath} to its previous content`;
  }
}
