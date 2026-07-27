import type { PermissionDecision } from "../types.js";

const VALID_PERMISSION_DECISIONS: readonly string[] = ["yes", "always", "no"];

/**
 * IPC handlers in electron/main.mjs receive arguments straight from the
 * renderer with no schema — a compromised or buggy renderer can send any
 * shape. These guards are the boundary check before that data reaches
 * engine/config internals that assume well-formed input.
 */
export function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function isValidPermissionDecision(value: unknown): value is PermissionDecision {
  return typeof value === "string" && VALID_PERMISSION_DECISIONS.includes(value);
}

export function isValidStartOpts(value: unknown): value is { provider?: string; model?: string } {
  if (value === undefined) return true;
  if (value === null) return false;
  if (typeof value !== "object" || Array.isArray(value)) return false;
  const opts = value as Record<string, unknown>;
  if ("provider" in opts && opts.provider !== undefined && typeof opts.provider !== "string") {
    return false;
  }
  if ("model" in opts && opts.model !== undefined && typeof opts.model !== "string") {
    return false;
  }
  return true;
}
