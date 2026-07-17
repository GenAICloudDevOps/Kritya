import fs from "node:fs";
import path from "node:path";

interface UndoEntry {
  relPath: string;
  absPath: string;
  /** File content before the change; null if the file did not exist. */
  prevContent: string | null;
}

const MAX_ENTRIES = 50;

/**
 * Stack of file states captured before each agent write/edit, so /undo can
 * revert the most recent change.
 */
export class UndoStack {
  private entries: UndoEntry[] = [];

  /** Capture the current state of a file before it is modified. */
  snapshot(absPath: string, relPath: string): void {
    let prevContent: string | null = null;
    try {
      prevContent = fs.readFileSync(absPath, "utf8");
    } catch {
      prevContent = null;
    }
    this.entries.push({ relPath, absPath, prevContent });
    if (this.entries.length > MAX_ENTRIES) this.entries.shift();
  }

  get size(): number {
    return this.entries.length;
  }

  /** Revert the most recent change. Returns a description, or null if empty. */
  undo(): string | null {
    const entry = this.entries.pop();
    if (!entry) return null;
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
