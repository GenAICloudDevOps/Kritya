/**
 * Shared bounds checks for JSON config files (config.json, .mcp.json) read
 * from disk. These files are small by nature, so a huge file or pathological
 * nesting is either corruption or a deliberately hostile input (e.g. a
 * malicious .mcp.json checked into a repo someone was talked into trusting)
 * — either way, better to refuse it than to hand an unbounded string or
 * object graph to JSON.parse and whatever reads the result afterwards.
 */

/** Config files this small in practice; anything past this is refused outright. */
export const MAX_CONFIG_JSON_BYTES = 5 * 1024 * 1024;

/**
 * Deep nesting costs stack frames in every recursive consumer downstream
 * (JSON.stringify on save, object spreads, etc.), not just JSON.parse
 * itself. Real configs nest a handful of levels deep at most.
 */
export const MAX_JSON_DEPTH = 64;

export class JsonSafetyError extends Error {}

/** Throws if `raw` is larger than `maxBytes` (measured in UTF-8 bytes, not chars). */
export function assertJsonSizeWithinLimit(
  raw: string,
  maxBytes: number = MAX_CONFIG_JSON_BYTES,
  label = "JSON"
): void {
  if (Buffer.byteLength(raw, "utf8") > maxBytes) {
    throw new JsonSafetyError(`${label} exceeds ${maxBytes} byte limit`);
  }
}

/**
 * Throws if the raw JSON text nests objects/arrays deeper than `maxDepth`.
 * Scans the text directly rather than the parsed tree, so a hostile input is
 * rejected before JSON.parse ever builds it. String contents (which may
 * contain unbalanced-looking brace/bracket characters) are skipped rather
 * than scanned, respecting escapes so an escaped quote doesn't end the
 * string early.
 */
export function assertJsonDepthWithinLimit(
  raw: string,
  maxDepth: number = MAX_JSON_DEPTH,
  label = "JSON"
): void {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === "{" || ch === "[") {
      depth++;
      if (depth > maxDepth) {
        throw new JsonSafetyError(`${label} nests deeper than ${maxDepth} levels`);
      }
    } else if (ch === "}" || ch === "]") {
      depth--;
    }
  }
}

/** Runs both the size and depth checks together — the usual entry point before JSON.parse. */
export function assertJsonWithinLimits(
  raw: string,
  label: string,
  maxBytes: number = MAX_CONFIG_JSON_BYTES,
  maxDepth: number = MAX_JSON_DEPTH
): void {
  assertJsonSizeWithinLimit(raw, maxBytes, label);
  assertJsonDepthWithinLimit(raw, maxDepth, label);
}
