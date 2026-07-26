import { backgroundManager } from "../shell/background.js";
import type { ToolDef } from "../types.js";
import { truncateTail } from "./common.js";
import { redactSecrets } from "./secretScan.js";

export const bgOutputTool: ToolDef = {
  name: "bg_output",
  description:
    "Read the recent output of a background process started with shell background:true. " +
    "Reports whether it is still running and its exit code if finished. " +
    "Call without an id to list all background processes.",
  parameters: {
    type: "object",
    properties: {
      id: { type: "string", description: "Background process id, e.g. bg_1 (omit to list all)" },
    },
  },
  requiresPermission: false,
  summarize: (args) => (args.id ? `Read output of ${args.id}` : "List background processes"),
  execute(args) {
    if (!args.id) {
      const list = backgroundManager.list();
      if (!list.length) return Promise.resolve("No background processes.");
      return Promise.resolve(
        list.map((p) => `${p.id} [${p.running ? "running" : "exited"}]: ${p.command}`).join("\n")
      );
    }
    const info = backgroundManager.read(String(args.id));
    if (!info) return Promise.resolve(`Error: no background process "${args.id}"`);
    const status = info.running ? "still running" : `exited with code ${info.exitCode}`;
    const header = `Process ${args.id} (${info.command}) — ${status}`;
    const { redacted, matches } = redactSecrets(`${header}\n\n${info.output || "(no output yet)"}`);
    const note =
      matches.length > 0
        ? `[${matches.length} secret(s) redacted from output: ${matches.map((m) => m.kind).join(", ")}]\n`
        : "";
    return Promise.resolve(`${note}${truncateTail(redacted, 10_000)}`);
  },
};

export const bgKillTool: ToolDef = {
  name: "bg_kill",
  description: "Stop a background process started with shell background:true.",
  parameters: {
    type: "object",
    properties: {
      id: { type: "string", description: "Background process id, e.g. bg_1" },
    },
    required: ["id"],
  },
  requiresPermission: false,
  summarize: (args) => `Kill background process ${args.id}`,
  execute(args) {
    const ok = backgroundManager.kill(String(args.id));
    return Promise.resolve(
      ok ? `Sent SIGTERM to ${args.id}.` : `Error: "${args.id}" is not a running background process`
    );
  },
};
