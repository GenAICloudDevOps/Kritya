import type { Checkpoint } from "../agent/loop.js";
import type { CommandDef } from "../commands/registry.js";

export interface PaletteItem {
  label: string;
  value: string;
  hint?: string;
}

/**
 * Subsequence match, case-insensitive: "rwd" matches "/rewind", "exmd"
 * matches "/export". Order matters ("mre" does not match "/rename") but
 * contiguity doesn't — this is what makes a palette feel like a palette
 * rather than the `/` prefix completion.
 */
export function fuzzyMatch(haystack: string, needle: string): boolean {
  const h = haystack.toLowerCase();
  const n = needle.trim().toLowerCase();
  if (!n) return true;
  let i = 0;
  for (const ch of h) {
    if (ch === n[i]) i++;
    if (i === n.length) return true;
  }
  return false;
}

/**
 * The palette's rows: every command first, then every checkpoint. Values are
 * prefixed so the selection handler knows what was picked without a second
 * lookup — `cmd:/rename` inserts the command into the input line (never runs
 * it blind: a fuzzy finder that executes on Enter is how conversations get
 * cleared by accident), `checkpoint:<name>` rewinds to that checkpoint.
 *
 * `recency` (command name → last-run epoch ms) floats recently *used*
 * commands above the rest. Only the unfiltered ordering is affected: once a
 * user is typing a fragment they are looking for that fragment, and reordering
 * under the cursor as matches arrive would be the opposite of helpful. Within
 * each group the sort is stable, so the declaration order stays the tiebreak
 * and the list is still predictable on a fresh install (`recency` omitted).
 */
export function buildPaletteItems(
  commands: CommandDef[],
  checkpoints: Checkpoint[],
  filter: string,
  recency?: Record<string, number>
): PaletteItem[] {
  const items: PaletteItem[] = [];
  // Sort first, filter second: filtering cannot change the relative order, and
  // doing it once here avoids re-sorting an already-sorted list per item.
  const ordered =
    !recency || filter.trim()
      ? commands
      : [...commands].sort((a, b) => (recency[b.name] ?? 0) - (recency[a.name] ?? 0));

  for (const c of ordered) {
    if (!fuzzyMatch(`${c.name} ${c.description}`, filter)) continue;
    items.push({ label: c.name, value: `cmd:${c.name}`, hint: c.description });
  }
  for (const cp of checkpoints) {
    if (!fuzzyMatch(`checkpoint ${cp.name}`, filter)) continue;
    items.push({
      label: `checkpoint: ${cp.name}`,
      value: `checkpoint:${cp.name}`,
      hint: `rewind · saved ${new Date(cp.createdAt).toLocaleTimeString()}`,
    });
  }
  return items;
}
