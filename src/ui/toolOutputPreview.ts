import { truncateToWidth } from "./inline.js";

/**
 * Preview of tool output: a few lines by default, everything when verbose.
 * Tabs are expanded first — `read` emits a padded line number and a tab, which
 * the terminal takes to the next 8-column stop, leaving a ragged gap that made
 * previews look broken. Lines are clipped rather than wrapped, so a preview
 * stays the size it claims to be.
 */
export function toolOutputPreview(
  output: string,
  verbose: boolean,
  width: number,
  isError = false
): string {
  const lines = output
    .replace(/\s+$/, "")
    .split("\n")
    // The untrusted-content fence is an instruction to the model about how to
    // treat what follows. It says nothing to the person reading the screen.
    .filter((l) => !/^<<<(end_)?external_untrusted_content/i.test(l.trim()))
    .map((l) => l.replace(/^(\s*\d+)\t/, "$1 ").replace(/\t/g, "  "));
  while (lines.length && !lines[0].trim()) lines.shift();
  // Drop indentation every line shares — `read` pads its line numbers to five
  // columns, which is dead space in a preview that is already indented.
  const common = Math.min(
    ...lines.filter((l) => l.trim()).map((l) => /^ */.exec(l)![0].length),
    Infinity
  );
  if (common > 0 && common < Infinity) {
    for (let i = 0; i < lines.length; i++) lines[i] = lines[i].slice(common);
  }
  if (verbose) return lines.join("\n");
  // A failure is exactly when the detail is worth the rows.
  const keep = isError ? 8 : 3;
  const head = lines.slice(0, keep).map((l) => truncateToWidth(l, width));
  return lines.length > keep
    ? `${head.join("\n")}\n… (+${lines.length - keep} lines · Ctrl+O)`
    : head.join("\n");
}
