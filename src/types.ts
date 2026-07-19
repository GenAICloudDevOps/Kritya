import type OpenAI from "openai";

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

export type Phase = "input" | "working" | "permission" | "model" | "resume";

export interface UiBridge {
  onTasksUpdate(tasks: TaskItem[]): void;
}

export interface ToolContext {
  /** Absolute path of the workspace root; all file tools are confined to it. */
  workspace: string;
  /** Records file states before mutation so /undo can revert them. */
  undo?: { snapshot(absPath: string, relPath: string): void; beginTurn?(): void };
  /** Lets the update_tasks tool push checklist changes to the UI. */
  onTasksUpdate?(tasks: TaskItem[]): void;
  /** Runs a read-only subagent on a focused task and returns its findings. */
  spawnSubagent?(task: string, signal?: AbortSignal): Promise<string>;
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
}

/** Callbacks through which the agent loop reports progress to the UI. */
export interface AgentHandlers {
  onTextDelta(delta: string): void;
  onReasoningDelta(delta: string): void;
  /** A complete assistant text message was produced. */
  onAssistantText(text: string): void;
  onToolStart(name: string, summary: string): void;
  onToolEnd(name: string, summary: string, resultPreview: string, isError: boolean): void;
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
