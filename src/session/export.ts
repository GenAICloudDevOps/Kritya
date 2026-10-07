import path from "node:path";
import { resolveSafe } from "../tools/common.js";
import type { ChatMessage } from "../types.js";

export interface ExportMeta {
  sessionName: string;
  model: string;
  provider: string;
  exportedAt: Date;
}

/** Tool outputs longer than this are cut — a transcript export is for reading, not replay. */
const MAX_TOOL_OUTPUT_CHARS = 4000;

/** Tool call arguments longer than this are cut; the full call is in the audit log. */
const MAX_TOOL_ARGS_CHARS = 1000;

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + `\n… [truncated, ${text.length - max} more characters]`;
}

/** Plain text of a message; image parts become a placeholder line. */
function messageText(message: ChatMessage): string {
  const content = message.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => {
        if (p.type === "text") return p.text;
        if (p.type === "image_url") return "[image attached]";
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

interface ToolCallInfo {
  name: string;
  args: string;
}

/** Map tool_call_id -> the assistant's call, so results render under their call. */
function indexToolCalls(messages: ChatMessage[]): Map<string, ToolCallInfo> {
  const index = new Map<string, ToolCallInfo>();
  for (const m of messages) {
    if (m.role !== "assistant" || !("tool_calls" in m) || !m.tool_calls?.length) continue;
    for (const call of m.tool_calls) {
      if (call.type !== "function") continue;
      index.set(call.id, {
        name: call.function.name,
        args: truncate(call.function.arguments ?? "", MAX_TOOL_ARGS_CHARS),
      });
    }
  }
  return index;
}

/**
 * Render the agent's history as markdown. System prompts are skipped (they're
 * scaffolding, not conversation); everything else renders in order — user and
 * assistant turns as sections, tool results under the call that produced them.
 */
export function transcriptToMarkdown(messages: ChatMessage[], meta: ExportMeta): string {
  const calls = indexToolCalls(messages);
  const lines: string[] = [
    `# Kritya session: ${meta.sessionName}`,
    "",
    `- Exported: ${meta.exportedAt.toLocaleString()}`,
    `- Model: ${meta.provider}/${meta.model}`,
    `- Messages: ${messages.filter((m) => m.role !== "system").length}`,
    "",
    "---",
  ];
  for (const m of messages) {
    if (m.role === "system") continue;
    if (m.role === "user") {
      const text = messageText(m).trim();
      if (!text) continue;
      lines.push("", "## User", "", text);
    } else if (m.role === "assistant") {
      const text = messageText(m).trim();
      lines.push("", "## Assistant", "");
      if (text) lines.push(text);
    } else if (m.role === "tool") {
      const id = "tool_call_id" in m ? String(m.tool_call_id ?? "") : "";
      const info = calls.get(id);
      const output = truncate(messageText(m).trim(), MAX_TOOL_OUTPUT_CHARS);
      lines.push("", `### Tool: ${info?.name ?? "result"}`, "");
      if (info?.args.trim()) lines.push("```json", info.args.trim(), "```", "");
      if (output) lines.push("```", output, "```");
    }
  }
  return lines.join("\n") + "\n";
}

function stampForFilename(now: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}` +
    `-${p(now.getHours())}${p(now.getMinutes())}`
  );
}

/**
 * Where `/export` writes. No argument → `kritya-<session>-<stamp>.md` in the
 * workspace; a bare name gets `.md`; anything else resolves inside the
 * workspace (traversal outside it is rejected, like the file tools).
 */
export function resolveExportPath(
  workspace: string,
  arg: string,
  sessionName: string,
  now = new Date()
): string {
  let target = arg.trim();
  if (!target) {
    target = `kritya-${sessionName}-${stampForFilename(now)}.md`;
  } else if (!path.extname(target)) {
    target += ".md";
  }
  return resolveSafe(workspace, target);
}
