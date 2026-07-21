import type OpenAI from "openai";
import type { SandboxMode } from "./shell/sandbox.js";

export type ChatMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;

export interface TaskItem {
  text: string;
  status: "pending" | "in_progress" | "done";
}

export type ItemBody =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | { kind: "tool"; name: string; summary: string; error: boolean; output?: string }
  | { kind: "info"; text: string }
  | { kind: "banner"; subtitle: string };

export type Phase = "input" | "working" | "permission" | "model" | "resume" | "confirmMode";

export interface UiBridge {
  onTasksUpdate(tasks: TaskItem[]): void;
  /** Fires when the file-watcher detects an edit kritya didn't make itself. */
  onExternalEdit?(relPath: string): void;
}

/** One subagent dispatch request: a self-contained task, and whether it may mutate files. */
export interface SubagentSpec {
  task: string;
  /** If true, runs in an isolated git worktree/branch with write+shell access. */
  write?: boolean;
}

/** Outcome of one subagent run. */
export interface SubagentResult {
  task: string;
  write: boolean;
  /** The subagent's findings, or a summary of what it changed. */
  summary: string;
  /** Set for write agents that committed changes — the branch holding them. */
  branch?: string;
  /** Set if the subagent's work could not be safely reconciled (e.g. commit hook rejected it). */
  error?: string;
}

export interface ToolContext {
  /** Absolute path of the workspace root; all file tools are confined to it. */
  workspace: string;
  /** OS-level sandboxing policy for the `shell` tool (see config's sandboxExec). Default "off". */
  sandboxMode?: SandboxMode;
  /** Records file states before mutation so /undo can revert them. */
  undo?: { snapshot(absPath: string, relPath: string): void; beginTurn?(): void };
  /** Lets the update_tasks tool push checklist changes to the UI. */
  onTasksUpdate?(tasks: TaskItem[]): void;
  /**
   * Runs one or more subagents concurrently, each with its own fresh context.
   * Read-only agents can only inspect the repo. Write agents get an isolated
   * git worktree + branch, so their edits and shell commands never touch the
   * real working tree until the user reviews and merges the branch.
   */
  spawnAgents?(specs: SubagentSpec[], signal?: AbortSignal): Promise<SubagentResult[]>;
}

export interface ToolDef {
  name: string;
  description: string;
  /** JSON schema for the tool's arguments. */
  parameters: Record<string, unknown>;
  /** Whether the tool mutates state and must be approved by the user. */
  requiresPermission: boolean;
  /** Tool returns content from outside the workspace (web); output is wrapped as untrusted. */
  external?: boolean;
  /** One-line human-readable description of a concrete invocation. */
  summarize(args: Record<string, unknown>): string;
  /** Optional diff/preview shown in the permission prompt. */
  preview?(args: Record<string, unknown>, ctx: ToolContext): Promise<string | null>;
  /** `signal` aborts when the user cancels; long-running tools should honor it. */
  execute(args: Record<string, unknown>, ctx: ToolContext, signal?: AbortSignal): Promise<string>;
}

export type PermissionDecision = "yes" | "always" | "no";

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  /** Prompt tokens served from the provider's prompt cache (subset of promptTokens). */
  cachedPromptTokens?: number;
}

/** Callbacks through which the agent loop reports progress to the UI. */
export interface AgentHandlers {
  onTextDelta(delta: string): void;
  onReasoningDelta(delta: string): void;
  /** A complete assistant text message was produced. */
  onAssistantText(text: string): void;
  /** `id` is the tool call's unique id, so the UI can track each concurrent
   *  call independently (a turn's read-only calls run in parallel). */
  onToolStart(id: string, name: string, summary: string): void;
  onToolEnd(id: string, name: string, summary: string, resultPreview: string, isError: boolean): void;
  requestPermission(
    name: string,
    summary: string,
    diff?: string,
    warning?: string
  ): Promise<PermissionDecision>;
  onUsage(usage: Usage): void;
  /** A transient provider error is being retried. */
  onRetry?(attempt: number, status?: number): void;
}
