import path from "node:path";

/**
 * Files inside the workspace that can run code later, outside the sandbox.
 *
 * The sandbox confines what a command *does* while it runs. It says nothing
 * about what a command *leaves behind*, and the workspace is writable by
 * design — so a hook, a lifecycle script, or a direnv config planted today runs
 * tomorrow, when the user types `git commit` or `npm install` in their own
 * terminal, with none of the sandbox around it. That is the one escape route
 * the sandbox cannot close, because the harm happens on the user's next move
 * rather than the agent's.
 *
 * Two mechanisms here, deliberately different:
 *
 *  - {@link classifyLaterExec} feeds the permission prompt, so writing one of
 *    these paths asks the user first — the same forced prompt `rm -rf` gets,
 *    which an allowlist rule cannot silence.
 *  - {@link recordLaterExec} accumulates what was touched so the session can
 *    end with a list. A prompt catches the write; the list catches the case
 *    where the write went through a shell redirect the prompt never saw, or
 *    was approved without the consequence being obvious at the time.
 */

/** Why a path is dangerous, phrased for someone reading a prompt. */
export interface LaterExecMatch {
  /** Workspace-relative, `/`-separated. */
  path: string;
  /** One line a human can act on. */
  label: string;
}

interface Rule {
  re: RegExp;
  label: string;
  /**
   * True when the path is only interesting if the written text introduces a
   * script — `package.json` is edited for dependencies constantly, and warning
   * on every dependency bump would train the user to click through.
   */
  contentSensitive?: boolean;
}

/**
 * Lifecycle scripts npm runs on its own: `npm install` fires preinstall,
 * install, postinstall and prepare; `npm publish` fires prepublishOnly,
 * prepack and postpack. Any of them is a shell command attached to an
 * everyday action.
 */
const LIFECYCLE_RE = /"(pre|post)?(install|prepare|publish|pack)(Only)?"\s*:/i;

const RULES: Rule[] = [
  {
    re: /^\.git\/hooks\/[^/]+$/,
    label: "a git hook (runs on your next git command)",
  },
  { re: /^\.husky\/[^/]+$/, label: "a husky hook (runs on your next git command)" },
  {
    re: /^\.git\/config$/,
    label: "git config (can redirect hooks or define shell aliases)",
  },
  { re: /^\.envrc$/, label: "direnv config (runs when you enter this directory)" },
  {
    re: /^\.vscode\/(tasks|launch)\.json$/,
    label: "a VS Code task (runs when you launch it)",
  },
  {
    re: /^\.pre-commit-config\.ya?ml$/,
    label: "a pre-commit config (runs on your next commit)",
  },
  {
    re: /^package\.json$/,
    label: "package.json scripts (npm runs them on install and publish)",
    contentSensitive: true,
  },
];

/** `.\git\hooks\x` and `./.git/hooks/x` both become `.git/hooks/x`. */
function normalizeRel(p: string): string {
  return p
    .split(path.sep)
    .join("/")
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/\/+$/, "")
    .toLowerCase();
}

/** A workspace-relative, `/`-separated form of `target`, or null if it is outside. */
export function workspaceRelative(workspace: string, target: string): string | null {
  const abs = path.resolve(workspace, target);
  const rel = path.relative(workspace, abs);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join("/");
}

/**
 * The label for a path that runs code later, or null when it is an ordinary
 * file.
 *
 * `text` is the content being written, when the caller has it — only the
 * `contentSensitive` rules look at it, and only to decide whether the edit
 * actually introduces a script.
 */
export function classifyLaterExec(relPath: string, text?: string): string | null {
  const rel = normalizeRel(relPath);
  // Git ships .git/hooks/*.sample as documentation; writing one of those runs
  // nothing.
  if (rel.endsWith(".sample")) return null;
  for (const rule of RULES) {
    if (!rule.re.test(rel)) continue;
    if (rule.contentSensitive && !(text && LIFECYCLE_RE.test(text))) continue;
    return rule.label;
  }
  return null;
}

/**
 * The same check for a shell command, by looking at what it redirects into.
 *
 * Only redirects are inspected — `> file` and `>> file` — because that is the
 * one way a shell command writes a specific path without going through the
 * file tools. Anything cleverer (a script that writes the hook itself) has no
 * path to match, and is what the end-of-session list is for.
 */
export function classifyLaterExecInShell(
  command: string,
  workspace: string
): LaterExecMatch | null {
  const re = />>?\s*(?:"([^"]+)"|'([^']+)'|([^\s;|&()<>]+))/g;
  for (let m = re.exec(command); m !== null; m = re.exec(command)) {
    const target = m[1] ?? m[2] ?? m[3];
    if (!target || target === "/dev/null" || target.startsWith("&")) continue;
    const rel = workspaceRelative(workspace, target);
    if (!rel) continue;
    const label = classifyLaterExec(rel, command);
    if (label) return { path: rel, label };
  }
  return null;
}

// --- Session record ---------------------------------------------------------

/**
 * Paths touched this session, keyed by relative path. A Map rather than a Set
 * so the same file touched twice is listed once, with its label.
 */
const touched = new Map<string, string>();

/** Remembers a file that can run code later. */
export function recordLaterExec(match: LaterExecMatch): void {
  touched.set(match.path, match.label);
}

/** Everything recorded so far this session, sorted for a stable list. */
export function laterExecFiles(): LaterExecMatch[] {
  return [...touched.entries()]
    .map(([p, label]) => ({ path: p, label }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

/** Test-only: forgets the session's record. */
export function resetLaterExec(): void {
  touched.clear();
}

/**
 * The end-of-session list, or null when nothing was touched.
 *
 * Kept separate from the prompt on purpose: the prompt interrupts a write, and
 * an interrupted write is easy to approve without reading. This is the last
 * thing on screen, after the agent has stopped, which is when the question
 * "what did I just let it leave here?" actually gets asked.
 */
export function laterExecNotice(files: LaterExecMatch[], isTTY = false): string | null {
  if (files.length === 0) return null;
  const dim = isTTY ? "\x1b[2m" : "";
  const plain = isTTY ? "\x1b[22m" : "";
  const n = files.length;
  const lines = files.map((f) => `  ${f.path}  ${dim}${f.label}${plain}`);
  return (
    `${dim}${n} file${n === 1 ? "" : "s"} here can run code later, outside the sandbox:${plain}\n` +
    lines.join("\n") +
    `\n${dim}  review before your next git or npm command${plain}`
  );
}
