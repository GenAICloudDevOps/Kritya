import { shortSessionId } from "./store.js";

export interface ExitNoticeInput {
  /** --privacy: nothing was persisted, so there is no session to point at. */
  privacyMode: boolean;
  /** Messages written to the transcript, from SessionStore.messageCount. */
  messageCount: number;
  /** Transcript path, or undefined when nothing was actually written to disk. */
  file?: string;
  /** The resolved workspace — sessions are keyed by directory. */
  workspace: string;
  /** Where the process was launched, so the resume command can be shown as-is. */
  cwd: string;
  /** Whether stdout is a terminal — colour codes are omitted when it is not. */
  isTTY: boolean;
}

/**
 * The sign-off printed when an interactive session ends, or null when there is
 * nothing worth saying.
 *
 * This is the only place the session's short name is discoverable without
 * re-running `--resume`, so it is the whole point of the feature: quit, and the
 * terminal tells you the exact command that brings this conversation back.
 *
 * Pulled out of the CLI entry point as a pure function on purpose. It is the
 * one piece of the exit path with real logic — privacy mode, an empty session,
 * singular/plural, and whether the resume command even works from here — and
 * `index.tsx` is excluded from coverage, so anything left in there is logic
 * nothing measures.
 */
export function exitNotice(input: ExitNoticeInput): string | null {
  if (input.privacyMode) return "Session not saved (--privacy).";
  if (!input.file || input.messageCount <= 0) return null;

  const dim = input.isTTY ? "\x1b[2m" : "";
  const plain = input.isTTY ? "\x1b[22m" : "";
  const n = input.messageCount;
  // `kritya -r <code>` only resolves from the directory the session belongs to,
  // so say where that was when it is not where the user is standing.
  const where = input.workspace === input.cwd ? "" : ` ${input.workspace}`;

  return (
    `${dim}Session saved · ${n} message${n === 1 ? "" : "s"}${plain}\n` +
    `${dim}  resume  ${plain}kritya -r ${shortSessionId(input.file)}${where}\n` +
    `${dim}  list    ${plain}kritya -r`
  );
}
