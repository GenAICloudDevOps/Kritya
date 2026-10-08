import { fuzzyMatch } from "./palette.js";

/**
 * Reverse history search: the Ctrl+R prompt.
 *
 * ↑/↓ already walks history one entry at a time, which is fine when the entry
 * you want is the one just before this one and useless when it is forty back.
 * This filters the whole in-memory history by fragment the way `fuzzyMatch`
 * does elsewhere, so "dckr ps" finds `docker compose ps` without retyping it.
 *
 * Most-recent-first is the caller's job (pass history newest-first), but
 * `searchHistory` also de-duplicates: the same prompt often repeats, and
 * showing it twice would waste a row and make ↑↓ feel broken.
 */
export interface HistoryMatch {
  /** The history entry, as typed. */
  text: string;
  /** Its position in the original array, so the caller can restore ↑/↓ from there. */
  index: number;
}

/**
 * Match `query` against `history` (newest-first is the expected order) and
 * return the entries that match, preserving that order. An empty query matches
 * everything, which is what makes Ctrl+R useful before a fragment is typed:
 * it shows the recent prompts immediately.
 *
 * Duplicates are collapsed by text, keeping the newest occurrence — pressing
 * Ctrl+R after typing a prompt three times should not offer it three times.
 */
export function searchHistory(history: string[], query: string): HistoryMatch[] {
  const seen = new Set<string>();
  const out: HistoryMatch[] = [];
  for (let index = 0; index < history.length; index++) {
    const text = history[index];
    if (!fuzzyMatch(text, query)) continue;
    if (seen.has(text)) continue;
    seen.add(text);
    out.push({ text, index });
  }
  return out;
}
