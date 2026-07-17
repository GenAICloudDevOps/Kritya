import fs from "node:fs";
import path from "node:path";
import { CONFIG_DIR } from "../config/config.js";

/**
 * User-defined slash commands. Each markdown file under .kritya/commands/
 * (workspace) or ~/.kritya/commands/ (global) becomes a command named after
 * the file: `deploy.md` -> `/deploy`. The file body is a prompt sent to the
 * agent; `$ARGUMENTS` (or `{{args}}`) is replaced with whatever the user typed
 * after the command. An optional first-line `# description` HTML/blank comment
 * is used as the listing description.
 */
export interface CustomCommand {
  name: string; // includes leading slash, e.g. "/deploy"
  description: string;
  body: string;
}

function readCommandsFrom(dir: string): CustomCommand[] {
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".md"));
  } catch {
    return [];
  }
  const commands: CustomCommand[] = [];
  for (const file of files) {
    try {
      const raw = fs.readFileSync(path.join(dir, file), "utf8");
      const name = "/" + path.basename(file, ".md");
      const { description, body } = parseCommand(raw);
      commands.push({ name, description, body });
    } catch {
      // Skip unreadable command files.
    }
  }
  return commands;
}

/** Extract an optional `description:` front-matter-ish first line. */
function parseCommand(raw: string): { description: string; body: string } {
  const lines = raw.split("\n");
  const first = lines[0]?.trim() ?? "";
  const m = /^(?:<!--\s*)?description:\s*(.+?)(?:\s*-->)?$/i.exec(first);
  if (m) {
    return { description: m[1].trim(), body: lines.slice(1).join("\n").trim() };
  }
  return { description: "custom command", body: raw.trim() };
}

/**
 * Load custom commands; workspace entries override global ones by name.
 * Workspace commands are attacker-controllable prompts in a cloned repo, so
 * they're only loaded once the workspace has been trusted (see
 * src/trust/trust.ts); global (~/.kritya/commands/) commands are always
 * trusted.
 */
export function loadCustomCommands(workspace: string, trustWorkspace = true): CustomCommand[] {
  const byName = new Map<string, CustomCommand>();
  for (const cmd of readCommandsFrom(path.join(CONFIG_DIR, "commands"))) {
    byName.set(cmd.name, cmd);
  }
  if (trustWorkspace) {
    for (const cmd of readCommandsFrom(path.join(workspace, ".kritya", "commands"))) {
      byName.set(cmd.name, cmd);
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Substitute the user's arguments into a command body. */
export function expandCommand(body: string, args: string): string {
  if (!/\$ARGUMENTS|\{\{args\}\}/.test(body)) {
    return args ? `${body}\n\n${args}` : body;
  }
  return body.replace(/\$ARGUMENTS|\{\{args\}\}/g, args);
}
