import fs from "node:fs";
import path from "node:path";
import type { ChatMessage } from "../types.js";
import { CONFIG_DIR } from "../config/config.js";
import { writeFileAtomicSync } from "../atomicWrite.js";

/**
 * Prompt templates: named starter prompts kept in ~/.kritya/templates.json.
 * `/template <name> [words...]` drops the template into the input line with
 * `{{input}}` replaced by the words (nothing runs without the user hitting
 * Enter); `/template save <name>` stores the last sent message as a template.
 */

const TEMPLATES_FILE = "templates.json";
const INPUT_PLACEHOLDER = "{{input}}";
const MAX_NAME_LENGTH = 32;
const NAME_RE = /^[a-zA-Z0-9_-]+$/;

/** Starter templates; a user template with the same name wins. */
export const BUILTIN_TEMPLATES: Record<string, string> = {
  review: "Review this diff for bugs, edge cases, and style issues:\n\n{{input}}",
  explain: "Explain this code like I'm new to the codebase:\n\n{{input}}",
};

export function isValidName(name: string): boolean {
  return name.length > 0 && name.length <= MAX_NAME_LENGTH && NAME_RE.test(name);
}

/** The user's own templates from disk. Never throws — missing or broken file means none. */
export function loadTemplates(dir: string = CONFIG_DIR): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(path.join(dir, TEMPLATES_FILE), "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === "string" && isValidName(k)) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

export function saveTemplates(custom: Record<string, string>, dir: string = CONFIG_DIR): void {
  fs.mkdirSync(dir, { recursive: true });
  writeFileAtomicSync(path.join(dir, TEMPLATES_FILE), JSON.stringify(custom, null, 2) + "\n");
}

/** Built-ins under the user's own, so a custom template can override a starter. */
export function allTemplates(custom: Record<string, string>): Record<string, string> {
  return { ...BUILTIN_TEMPLATES, ...custom };
}

/**
 * Fill `{{input}}` with the user's words. With no words, the placeholder is
 * dropped rather than left visible; with no placeholder, the words are
 * appended so `/template review src/foo.ts` still does something sensible.
 */
export function applyTemplate(template: string, input: string): string {
  const words = input.trim();
  if (!template.includes(INPUT_PLACEHOLDER)) {
    return words ? `${template.trimEnd()} ${words}` : template;
  }
  const filled = template.split(INPUT_PLACEHOLDER).join(words);
  return words ? filled : filled.replace(/\n{3,}/g, "\n\n").trimEnd();
}

/**
 * The last prompt the user actually sent. Slash commands never reach the
 * agent history, but anything starting with "/" is skipped anyway, along
 * with non-text (multimodal) messages.
 */
export function lastUserText(history: ChatMessage[]): string | null {
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (m.role !== "user" || typeof m.content !== "string") continue;
    const text = m.content.trim();
    if (!text || text.startsWith("/")) continue;
    return text;
  }
  return null;
}
