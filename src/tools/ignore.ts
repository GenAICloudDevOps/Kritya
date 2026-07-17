import fs from "node:fs";
import path from "node:path";

const IGNORE_FILE = ".krityaignore";

/** Converts one gitignore-style line into fast-glob ignore pattern(s). */
function toGlobPatterns(line: string): string[] {
  let pattern = line.trim();
  if (!pattern || pattern.startsWith("#") || pattern.startsWith("!")) return [];
  const isDir = pattern.endsWith("/");
  if (isDir) pattern = pattern.slice(0, -1);
  const anchored = pattern.startsWith("/");
  if (anchored) pattern = pattern.slice(1);
  const base = anchored ? pattern : `**/${pattern}`;
  return isDir ? [`${base}/**`] : [base, `${base}/**`];
}

/** Reads `<workspace>/.krityaignore` (gitignore-style, one pattern per line) as fast-glob ignore patterns. */
export function loadIgnorePatterns(workspace: string): string[] {
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(workspace, IGNORE_FILE), "utf8");
  } catch {
    return [];
  }
  return raw.split("\n").flatMap(toGlobPatterns);
}
