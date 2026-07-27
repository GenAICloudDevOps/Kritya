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

const MODE_FLAG_KEYS = ["planMode", "dryRunMode", "acceptEdits"] as const;

export interface ModeFlags {
  planMode?: boolean;
  dryRunMode?: boolean;
  acceptEdits?: boolean;
}

export function isValidModeFlags(value: unknown): value is ModeFlags {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const flags = value as Record<string, unknown>;
  for (const key of Object.keys(flags)) {
    if (!(MODE_FLAG_KEYS as readonly string[]).includes(key)) return false;
  }
  for (const key of MODE_FLAG_KEYS) {
    if (key in flags && typeof flags[key] !== "boolean") return false;
  }
  return true;
}

/**
 * Permission request ids are minted as `perm-${webContentsId}-${counter}`
 * (see the requestPermission handler in electron/main.mjs). Used to find and
 * reject only the prompts that belong to a given window/session when it's
 * killed or closed, without disturbing other windows' pending prompts.
 */
export function permissionIdBelongsToSession(id: string, webContentsId: number): boolean {
  return id.startsWith(`perm-${webContentsId}-`);
}
