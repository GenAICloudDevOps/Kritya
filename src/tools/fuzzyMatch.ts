/**
 * Edit matching for edit_file. Weaker models frequently reproduce a target
 * snippet with slightly different indentation or trailing whitespace, which
 * makes strict exact-string matching fail a lot. applyEdit tries an exact
 * match first, then a line-trimmed fallback that ignores per-line leading and
 * trailing whitespace while still requiring the lines to be contiguous and to
 * match in order — enough tolerance to be useful without matching the wrong code.
 */

export type MatchStrategy = "exact" | "line-trimmed" | "none";

export interface MatchResult {
  matched: boolean;
  /** Number of occurrences found (for the uniqueness check). */
  count: number;
  /** Resulting file content, present when a single match (or replace_all) applied. */
  result?: string;
  strategy: MatchStrategy;
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  return haystack.split(needle).length - 1;
}

/** Drop a single trailing empty line produced by a trailing newline in `s`. */
function toLines(s: string): string[] {
  const lines = s.split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function lineTrimmedMatch(
  content: string,
  oldStr: string,
  newStr: string,
  replaceAll: boolean
): MatchResult | null {
  const contentLines = content.split("\n");
  const oldLines = toLines(oldStr);
  if (oldLines.length === 0) return null;
  const trimmedOld = oldLines.map((l) => l.trim());

  const starts: number[] = [];
  for (let i = 0; i + oldLines.length <= contentLines.length; i++) {
    let ok = true;
    for (let j = 0; j < oldLines.length; j++) {
      if (contentLines[i + j].trim() !== trimmedOld[j]) {
        ok = false;
        break;
      }
    }
    if (ok) {
      starts.push(i);
      i += oldLines.length - 1;
    }
  }

  if (starts.length === 0) return null;
  if (starts.length > 1 && !replaceAll) {
    return { matched: true, count: starts.length, strategy: "line-trimmed" };
  }

  const newLines = toLines(newStr);
  const targets = replaceAll ? [...starts].reverse() : [starts[0]];
  for (const s of targets) {
    contentLines.splice(s, oldLines.length, ...newLines);
  }
  return {
    matched: true,
    count: starts.length,
    result: contentLines.join("\n"),
    strategy: "line-trimmed",
  };
}

export function applyEdit(
  content: string,
  oldStr: string,
  newStr: string,
  replaceAll: boolean
): MatchResult {
  const exactCount = countOccurrences(content, oldStr);
  if (exactCount > 0) {
    if (exactCount > 1 && !replaceAll) {
      return { matched: true, count: exactCount, strategy: "exact" };
    }
    const result = replaceAll
      ? content.split(oldStr).join(newStr)
      : content.replace(oldStr, newStr);
    return { matched: true, count: exactCount, result, strategy: "exact" };
  }

  return (
    lineTrimmedMatch(content, oldStr, newStr, replaceAll) ?? {
      matched: false,
      count: 0,
      strategy: "none",
    }
  );
}
