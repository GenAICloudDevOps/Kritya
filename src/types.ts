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
  | {
      kind: "tool";
      name: string;
      summary: string;
      error: boolean;
      output?: string;
      /** One-line description of the result; when present it replaces the preview. */
      resultSummary?: string;
    }
  | { kind: "info"; text: string }
  | { kind: "banner"; subtitle: string };

export type Phase =
  "input" | "working" | "permission" | "model" | "resume" | "confirmMode" | "elicitation";

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
  /** OS-level sandboxing policy for the `shell` tool (see config's sandboxExec). Default "auto". */
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
  /**
   * Override the agent's per-tool time limit, in milliseconds. Set 0 for a
   * tool that enforces its own deadline (`shell`, subagents, MCP calls) —
   * wrapping those in a second, shorter limit would cut short work the tool
   * had every right to still be doing.
   */
  timeoutMs?: number;
  /**
   * One line describing what the call produced — "10 files", "79 lines". The
   * UI shows this instead of the first few lines of output, which for a
   * listing or a search are noise: the shape of the result is what a human
   * wants, and Ctrl+O still expands the real thing.
   */
  resultSummary?(output: string, args: Record<string, unknown>): string | null;
  /**
   * Whether output the tool returned normally still represents a failure.
   * `shell` resolves on a nonzero exit rather than throwing — the model needs
   * the output either way — but the user shouldn't see a green check on a
   * command that failed.
   */
  failed?(output: string): boolean;
  /** `signal` aborts when the user cancels; long-running tools should honor it. */
  execute(args: Record<string, unknown>, ctx: ToolContext, signal?: AbortSignal): Promise<string>;
}

export type PermissionDecision = "yes" | "always" | "no";

export type ElicitationField =
  | { name: string; kind: "string"; label: string }
  | { name: string; kind: "boolean"; label: string }
  | { name: string; kind: "enum"; label: string; options: string[] };

export type ElicitationResult =
  | { action: "accept"; content: Record<string, string | boolean> }
  | { action: "decline" }
  | { action: "cancel" };

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  /** Prompt tokens served from the provider's prompt cache (subset of promptTokens). */
  cachedPromptTokens?: number;
  /**
   * True when the provider didn't report real token counts and this is a
   * rough estimate from text length instead. Cost/budget figures built from
   * an estimated Usage should be shown as approximate, not exact.
   */
  estimated?: boolean;
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
  onToolEnd(
    id: string,
    name: string,
    summary: string,
    resultPreview: string,
    isError: boolean,
    resultSummary?: string
  ): void;
  requestPermission(
    name: string,
    summary: string,
    diff?: string,
    warning?: string
  ): Promise<PermissionDecision>;
  /** Unused by the agent loop itself — surfaced only so MCP elicitation
   *  wiring (index.tsx) can reach the same prompt UI tool calls use. */
  requestElicitation?(message: string, fields: ElicitationField[]): Promise<ElicitationResult>;
  onUsage(usage: Usage): void;
  /** A transient provider error is being retried. */
  onRetry?(attempt: number, status?: number): void;
}
