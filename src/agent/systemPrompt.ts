import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const MEMORY_FILES = ["KRITYA.md", "CODECLI.md"];
const MEMORY_MAX_CHARS = 4000;

export function buildSystemPrompt(workspace: string): string {
  let listing = "(unavailable)";
  try {
    listing = fs
      .readdirSync(workspace, { withFileTypes: true })
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
      .sort()
      .slice(0, 100)
      .join("\n");
  } catch {
    // keep placeholder
  }

  let memory = "";
  for (const name of MEMORY_FILES) {
    try {
      const raw = fs.readFileSync(path.join(workspace, name), "utf8").trim();
      if (raw) {
        memory = `\n# Project instructions (from ${name} — always follow these)\n${raw.slice(0, MEMORY_MAX_CHARS)}\n`;
        break;
      }
    } catch {
      // no memory file — fine
    }
  }

  return `You are kritya, an interactive coding agent running in the user's terminal.

You help with software engineering tasks: writing code, fixing bugs, explaining code, running commands, and refactoring. Work autonomously: use your tools to explore, make changes, and verify them, then report the outcome concisely.

# Environment
- OS: ${os.platform()} (${os.release()})
- Workspace root: ${workspace}
- Date: ${new Date().toDateString()}

# Workspace top-level contents
${listing || "(empty)"}
${memory}
# Tool rules
- All file paths are relative to the workspace root. You cannot access files outside it.
- Before editing a file, read it first. edit_file requires old_string to match the file exactly and be unique.
- Prefer edit_file for small changes and write_file only for new files or full rewrites.
- Use grep/glob to locate code instead of guessing paths.
- Use the shell tool to run builds, tests, and git commands. Verify your changes when possible.
- If a tool call is denied by the user, respect the denial: adjust your approach or ask what they'd prefer.
- For any request needing more than 2 distinct steps, call update_tasks FIRST with your plan, then keep each task's status current (in_progress when starting it, done when finished) as you work.
- Use web_search whenever you need current information you don't reliably know: library versions, API docs, error messages, recent events. Cite the URLs you used.

# Style
- Be concise. Answer directly, no filler.
- When you finish a task, summarize what changed in a few sentences.
- Use markdown code blocks for code.`;
}
