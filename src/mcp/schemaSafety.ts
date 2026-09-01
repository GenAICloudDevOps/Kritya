/**
 * JSON-Schema dialect / `$ref` / composition-keyword safety hardening for
 * MCP-declared tool `inputSchema`s.
 *
 * kritya never runs a JSON Schema *validator* against tool-call arguments —
 * the model fills tool arguments and kritya forwards `inputSchema` to the
 * provider's function-calling API as opaque JSON. What kritya does expose,
 * unfiltered, is every MCP-declared tool's `inputSchema` to the agent and to
 * the user. This module is the registration-time gate that keeps an unsafe
 * schema from ever reaching either: see the spec's "JSON Schema Usage"
 * section (2026-07-28/basic) for the three requirements this implements.
 *
 * This is a separate, general-purpose check from `validateToolHeaders` in
 * transportModern.ts, which walks a schema for a narrow, HTTP-only purpose
 * (finding/validating `x-mcp-header` annotations) and only runs for
 * modern+HTTP servers. This module applies to every tool from every server,
 * legacy or modern, stdio or HTTP.
 */

export interface SchemaSafetyResult {
  ok: boolean;
  /** Present when ok is false: why the schema was rejected. */
  reason?: string;
}

/**
 * Dialect strings accepted as "JSON Schema 2020-12", the spec's default and
 * required dialect. The canonical URI is
 * "https://json-schema.org/draft/2020-12/schema"; real-world schemas vary in
 * small, harmless ways (a trailing slash, a trailing `#` fragment, or the
 * legacy `http://` scheme some tooling still emits for a `https://`-canonical
 * URI), so this list is deliberately a little lenient about exact string
 * matching without accepting anything that names a genuinely different
 * dialect (draft-07, draft-04, an unrecognized string, etc.).
 */
const ACCEPTED_2020_12_DIALECTS = new Set([
  "https://json-schema.org/draft/2020-12/schema",
  "https://json-schema.org/draft/2020-12/schema#",
  "https://json-schema.org/draft/2020-12/schema/",
  "http://json-schema.org/draft/2020-12/schema",
  "http://json-schema.org/draft/2020-12/schema#",
  "http://json-schema.org/draft/2020-12/schema/",
]);

/**
 * Bounds on the untrusted-schema walk below, in the same spirit as (and with
 * the same values as) validateToolHeaders's walk in transportModern.ts. A
 * malicious or buggy server's inputSchema must not be able to hang or crash
 * kritya, or run a validator out of memory, while it's inspected.
 */
const MAX_SCHEMA_DEPTH = 50;
const MAX_SCHEMA_NODES = 5000;

const COMPOSITION_KEYWORDS = ["oneOf", "anyOf", "allOf"] as const;
const CONDITIONAL_KEYWORDS = ["if", "then", "else"] as const;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** True when a `$ref` value would require a network fetch to resolve. */
function isNetworkRef(ref: string): boolean {
  try {
    const url = new URL(ref);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    // Not an absolute URI at all (e.g. "#/$defs/foo", a relative path) — no
    // network fetch is implied.
    return false;
  }
}

/**
 * Check one MCP tool's declared `inputSchema` (or `outputSchema`, or any
 * other JSON-Schema-shaped value) for the three safety requirements the MCP
 * spec calls out under "JSON Schema Usage":
 *
 * 1. Dialect: an absent `$schema` defaults to 2020-12 (fine); a `$schema`
 *    naming anything other than 2020-12 is rejected, since kritya only
 *    supports the required dialect today.
 * 2. `$ref` resolution: kritya never dereferences a remote `$ref` (there is
 *    no such code anywhere in this codebase, and this check doesn't add
 *    any) — so a `$ref` that names an http(s) URI is rejected outright
 *    rather than silently treated as permissive. A local pointer (`#...`)
 *    is normal same-document JSON Schema and is left alone.
 * 3. Bounds: the walk into `properties`, `items`/`prefixItems`,
 *    `oneOf`/`anyOf`/`allOf`, `not`, `if`/`then`/`else`, and
 *    `$defs`/`definitions` is capped on depth and total node count, so a
 *    pathological schema can't act as a DoS vector.
 */
export function checkSchemaSafety(schema: unknown): SchemaSafetyResult {
  if (!isPlainObject(schema)) return { ok: true };

  const dialect = schema["$schema"];
  if (dialect !== undefined) {
    if (typeof dialect !== "string") {
      return { ok: false, reason: `"$schema" must be a string, got ${typeof dialect}` };
    }
    if (!ACCEPTED_2020_12_DIALECTS.has(dialect)) {
      return {
        ok: false,
        reason: `unsupported JSON Schema dialect "${dialect}" — kritya only supports 2020-12`,
      };
    }
  }

  let nodeCount = 0;

  function visit(node: unknown, depth: number): string | undefined {
    if (!isPlainObject(node)) return undefined;
    nodeCount++;
    if (nodeCount > MAX_SCHEMA_NODES) {
      return `inputSchema exceeds the maximum node count (${MAX_SCHEMA_NODES})`;
    }
    if (depth > MAX_SCHEMA_DEPTH) {
      return `inputSchema exceeds the maximum nesting depth (${MAX_SCHEMA_DEPTH})`;
    }

    if (Object.prototype.hasOwnProperty.call(node, "$ref")) {
      const ref = node["$ref"];
      if (typeof ref === "string" && isNetworkRef(ref)) {
        return (
          `"$ref" resolves to a network URI ("${ref}") — kritya never dereferences a remote ` +
          `$ref, so this schema can't be validated`
        );
      }
    }

    if (isPlainObject(node.properties)) {
      for (const val of Object.values(node.properties)) {
        const err = visit(val, depth + 1);
        if (err) return err;
      }
    }
    if ("items" in node) {
      const items = node.items;
      if (Array.isArray(items)) {
        for (const it of items) {
          const err = visit(it, depth + 1);
          if (err) return err;
        }
      } else {
        const err = visit(items, depth + 1);
        if (err) return err;
      }
    }
    if (Array.isArray(node.prefixItems)) {
      for (const it of node.prefixItems) {
        const err = visit(it, depth + 1);
        if (err) return err;
      }
    }
    for (const kw of COMPOSITION_KEYWORDS) {
      if (Array.isArray(node[kw])) {
        for (const sub of node[kw] as unknown[]) {
          const err = visit(sub, depth + 1);
          if (err) return err;
        }
      }
    }
    if ("not" in node) {
      const err = visit(node.not, depth + 1);
      if (err) return err;
    }
    for (const kw of CONDITIONAL_KEYWORDS) {
      if (kw in node) {
        const err = visit(node[kw], depth + 1);
        if (err) return err;
      }
    }
    for (const defsKey of ["$defs", "definitions"] as const) {
      if (isPlainObject(node[defsKey])) {
        for (const val of Object.values(node[defsKey] as Record<string, unknown>)) {
          const err = visit(val, depth + 1);
          if (err) return err;
        }
      }
    }
    return undefined;
  }

  const err = visit(schema, 0);
  if (err) return { ok: false, reason: err };
  return { ok: true };
}
