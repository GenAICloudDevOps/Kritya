#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import React from "react";
import { render } from "ink";
import { Agent } from "./agent/loop.js";
import {
  CONFIG_DIR,
  loadConfig,
  loadDotEnv,
  resolveApiKey,
  NVIDIA_BASE_URL,
} from "./config/config.js";
import { DEFAULT_MODEL } from "./config/models.js";
import { PermissionManager } from "./permissions/permissions.js";
import { loadAllowRules } from "./permissions/rules.js";
import { NvidiaClient } from "./provider/client.js";
import { SessionStore } from "./session/store.js";
import { backgroundManager } from "./shell/background.js";
import { ALL_TOOLS } from "./tools/index.js";
import { UndoStack } from "./undo/undo.js";
import { App, type UiBridge } from "./ui/App.js";
import type { TaskItem } from "./types.js";

const VERSION = "0.2.0";

const USAGE = `kritya — a coding agent for NVIDIA build.nvidia.com models

Usage: kritya [directory] [options]

Options:
  -c, --continue     resume the most recent session for this directory
  -r, --resume       pick a past session for this directory from a list
  -m, --model <id>   model ID to use (any model on build.nvidia.com)
  -h, --help         show this help
  -v, --version      show version

Setup:
  1. Get an API key at https://build.nvidia.com (free credits available)
  2. export NVIDIA_API_KEY=nvapi-...        (Linux/macOS)
     setx NVIDIA_API_KEY nvapi-...          (Windows)
  3. cd your-project && kritya .

Config file: ~/.kritya/config.json  { "apiKey", "model", "customModels": [{"id"}] }`;

function parseArgs(argv: string[]) {
  const args = { dir: ".", continue: false, resume: false, model: "", help: false, version: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-c" || a === "--continue") args.continue = true;
    else if (a === "-r" || a === "--resume") args.resume = true;
    else if (a === "-m" || a === "--model") args.model = argv[++i] ?? "";
    else if (a === "-h" || a === "--help") args.help = true;
    else if (a === "-v" || a === "--version") args.version = true;
    else if (!a.startsWith("-")) args.dir = a;
    else {
      console.error(`Unknown option: ${a}\n\n${USAGE}`);
      process.exit(1);
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));

if (args.help) {
  console.log(USAGE);
  process.exit(0);
}
if (args.version) {
  console.log(VERSION);
  process.exit(0);
}

const workspace = path.resolve(args.dir);
if (!fs.existsSync(workspace) || !fs.statSync(workspace).isDirectory()) {
  console.error(`Not a directory: ${workspace}`);
  process.exit(1);
}

loadDotEnv([
  path.join(workspace, ".env"),
  path.join(process.cwd(), ".env"),
  path.join(CONFIG_DIR, ".env"),
]);

const config = loadConfig();
const apiKey = resolveApiKey(config);
if (!apiKey) {
  console.error(
    `No API key found.\n\nGet one at https://build.nvidia.com, then one of:\n` +
      `  put NVIDIA_API_KEY=nvapi-... in a .env file (workspace or ~/.kritya/.env)\n` +
      `  export NVIDIA_API_KEY=nvapi-...\n` +
      `  add "apiKey" to ~/.kritya/config.json`
  );
  process.exit(1);
}

if (!process.stdin.isTTY) {
  console.error("kritya is interactive and requires a TTY.");
  process.exit(1);
}

const modelRef = { current: args.model || config.model || DEFAULT_MODEL };
const client = new NvidiaClient(apiKey, config.baseUrl ?? NVIDIA_BASE_URL);
const session = new SessionStore(workspace);

const initialHistory = args.continue ? SessionStore.loadLatest(workspace) ?? [] : [];
session.start(initialHistory);

const resumeSessions = args.resume ? SessionStore.listSessions(workspace) : [];

process.on("exit", () => backgroundManager.killAll());

const undoStack = new UndoStack();
const uiBridge: UiBridge = { onTasksUpdate: (_tasks: TaskItem[]) => {} };

const agent = new Agent(
  client,
  () => modelRef.current,
  ALL_TOOLS,
  {
    workspace,
    undo: undoStack,
    onTasksUpdate: (tasks) => uiBridge.onTasksUpdate(tasks),
  },
  new PermissionManager(loadAllowRules(workspace)),
  session,
  initialHistory
);
agent.contextWindow = config.contextWindow ?? 120_000;

render(
  <App
    agent={agent}
    workspace={workspace}
    modelRef={modelRef}
    config={config}
    resumedCount={initialHistory.length}
    undoStack={undoStack}
    uiBridge={uiBridge}
    resumeSessions={resumeSessions.length ? resumeSessions : undefined}
  />
);
