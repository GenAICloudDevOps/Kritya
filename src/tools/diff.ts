const MAX_SIDE_LINES = 30;

/**
 * Naive line diff: trims common leading/trailing lines, shows the changed
 * middle as removals then additions. Good enough for a permission preview;
 * not a real Myers diff.
 */
export function diffLines(oldText: string, newText: string): string {
  const oldLines = oldText === "" ? [] : oldText.split("\n");
  const newLines = newText === "" ? [] : newText.split("\n");

  let start = 0;
  while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) {
    start++;
  }
  let endOld = oldLines.length;
  let endNew = newLines.length;
  while (endOld > start && endNew > start && oldLines[endOld - 1] === newLines[endNew - 1]) {
    endOld--;
    endNew--;
  }

  const out: string[] = [];
  const context = oldLines.slice(Math.max(0, start - 2), start);
  for (const line of context) out.push(`  ${line}`);

  const removed = oldLines.slice(start, endOld);
  const added = newLines.slice(start, endNew);
  for (const line of cap(removed)) out.push(`- ${line}`);
  for (const line of cap(added)) out.push(`+ ${line}`);

  const trailing = oldLines.slice(endOld, Math.min(oldLines.length, endOld + 2));
  for (const line of trailing) out.push(`  ${line}`);

  return out.join("\n");
}

function cap(lines: string[]): string[] {
  if (lines.length <= MAX_SIDE_LINES) return lines;
  return [...lines.slice(0, MAX_SIDE_LINES), `… (${lines.length - MAX_SIDE_LINES} more lines)`];
}
