import type { ParsedToolCall } from "./client.js";

/**
 * Recover tool calls a model wrote into its text instead of the tool-call
 * channel.
 *
 * Every OpenAI-compatible provider is supposed to return tool calls as
 * structured `tool_calls` deltas, and almost always does. But models do slip —
 * mid-conversation, after a long tool chain — and emit the call as prose
 * instead: a bare JSON object, often inside a code fence or a `<tool_call>`
 * tag. Nothing downstream recognizes that, so the turn ends as if the model
 * were done: the action never runs, and the user is shown a wall of raw JSON
 * as the final answer. That is a silent, wrong-looking failure at exactly the
 * moment the work was nearly finished.
 *
 * Recovery is deliberately narrow, because guessing wrong means running a tool
 * the model never asked for:
 *
 *  - the text must be *entirely* the payload (after unwrapping one fence or
 *    tag), so prose that merely quotes a tool call is left alone;
 *  - it must parse as JSON;
 *  - every call in it must name a tool that actually exists — one unknown name
 *    and the whole recovery is abandoned rather than partly applied.
 */

/** Wrappers models put around a text-channel tool call. */
const TAG_RE =
  /^<\s*(tool_call|toolcall|tool▁call|function_call|tool_use)\s*>([\s\S]*?)<\s*\/\s*\1\s*>$/i;

/** Keys a model uses for the tool's name, and for its arguments. */
const NAME_KEYS = ["name", "tool", "tool_name", "function", "recipient_name"];
const ARG_KEYS = ["arguments", "parameters", "args", "input", "parameter", "tool_input"];

/** Strip one layer of code fence and/or `<tool_call>`-style tag. */
function unwrap(text: string): string {
  let body = text.trim();
  for (let i = 0; i < 3; i++) {
    const tagged = TAG_RE.exec(body);
    if (tagged) {
      body = tagged[2].trim();
      continue;
    }
    if (body.startsWith("```")) {
      // ```json\n{...}\n```  — the closing fence is sometimes missing when the
      // model ran out of tokens, so it is optional.
      const stripped = body
        .replace(/^```[a-zA-Z0-9_-]*[ \t]*\r?\n?/, "")
        .replace(/\r?\n?```$/, "")
        .trim();
      if (stripped === body) break;
      body = stripped;
      continue;
    }
    // A trailing fence with no opening one — the shape seen when a model
    // starts the JSON immediately but still closes the block.
    if (body.endsWith("```")) {
      body = body.slice(0, -3).trim();
      continue;
    }
    break;
  }
  return body;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** Pull `{name, args}` out of one entry, in whichever shape the model used. */
function toCall(
  entry: unknown,
  isKnown: (name: string) => boolean
): { name: string; args: unknown } | null {
  const obj = asRecord(entry);
  if (!obj) return null;

  // {"function": {"name": "...", "arguments": {...}}} — the OpenAI wire shape.
  const fn = asRecord(obj.function);
  if (fn && typeof fn.name === "string") {
    return { name: fn.name, args: pickArgs(fn) };
  }

  // {"name": "write_file", "arguments": {...}} and its synonyms.
  for (const key of NAME_KEYS) {
    const value = obj[key];
    if (typeof value === "string" && value.trim()) {
      return { name: value.trim(), args: pickArgs(obj) };
    }
  }

  // {"write_file": {...}} — the tool name as the only key.
  const keys = Object.keys(obj);
  if (keys.length === 1 && isKnown(keys[0])) {
    return { name: keys[0], args: obj[keys[0]] };
  }
  return null;
}

function pickArgs(obj: Record<string, unknown>): unknown {
  for (const key of ARG_KEYS) {
    if (key in obj) return obj[key];
  }
  return {};
}

/** Arguments as the JSON string the rest of the pipeline expects. */
function argsToJson(args: unknown): string {
  if (typeof args === "string") {
    const trimmed = args.trim();
    // Providers double-encode arguments as often as not; either is fine here,
    // but a non-JSON string is not arguments at all.
    try {
      const parsed: unknown = JSON.parse(trimmed);
      return asRecord(parsed) ? JSON.stringify(parsed) : "{}";
    } catch {
      return "{}";
    }
  }
  const record = asRecord(args);
  return record ? JSON.stringify(record) : "{}";
}

export function recoverToolCalls(text: string, knownTools: Set<string>): ParsedToolCall[] {
  if (!text.trim() || knownTools.size === 0) return [];
  const body = unwrap(text);
  if (!body.startsWith("{") && !body.startsWith("[")) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return [];
  }

  const isKnown = (name: string) => knownTools.has(name);
  const entries = Array.isArray(parsed) ? parsed : [parsed];
  if (entries.length === 0) return [];

  const calls: ParsedToolCall[] = [];
  for (const [i, entry] of entries.entries()) {
    const call = toCall(entry, isKnown);
    // All or nothing: a payload we only partly understand is one we don't.
    if (!call || !isKnown(call.name)) return [];
    calls.push({
      id: `recovered_${i}_${Date.now().toString(36)}`,
      name: call.name,
      argsJson: argsToJson(call.args),
    });
  }
  return calls;
}
