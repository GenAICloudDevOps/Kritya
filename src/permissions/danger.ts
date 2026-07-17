/**
 * Flags shell commands that are destructive or irreversible. When a command
 * matches, kritya forces a permission prompt with a warning even if the
 * command would otherwise be covered by an allowlist rule or an "always allow"
 * choice — so a blanket `shell(*)` allow can't silently run `rm -rf /`.
 */

interface DangerPattern {
  re: RegExp;
  label: string;
}

const PATTERNS: DangerPattern[] = [
  { re: /\brm\s+(-[a-z]*\s+)*-[a-z]*[rf]/i, label: "recursive/forced file deletion (rm -rf)" },
  { re: /\brmdir\s+\/s/i, label: "recursive directory deletion" },
  { re: /\bgit\s+push\b.*(--force|-f)\b/i, label: "force push (rewrites remote history)" },
  { re: /\bgit\s+reset\s+--hard/i, label: "hard reset (discards local changes)" },
  { re: /\bgit\s+clean\s+-[a-z]*f/i, label: "git clean (deletes untracked files)" },
  { re: /\bgit\s+checkout\s+--\s|\bgit\s+restore\b/i, label: "discards uncommitted changes" },
  { re: /\bmkfs\b/i, label: "filesystem format" },
  { re: /\bdd\b.*\bof=\/dev\//i, label: "raw disk write (dd)" },
  { re: />\s*\/dev\/(sd|nvme|hd|disk)/i, label: "writing to a raw disk device" },
  { re: /\bchmod\s+-R\s+777\b/i, label: "world-writable recursive chmod" },
  { re: /\bchown\s+-R\b/i, label: "recursive ownership change" },
  { re: /:\(\)\s*\{.*\}\s*;/, label: "fork bomb" },
  {
    re: /\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(sh|bash|zsh)\b/i,
    label: "piping a remote script into a shell",
  },
  { re: /\bsudo\b/i, label: "elevated privileges (sudo)" },
  { re: /\bshutdown\b|\breboot\b|\bhalt\b|\bpoweroff\b/i, label: "system power state change" },
  { re: /\bnpm\s+publish\b|\byarn\s+publish\b/i, label: "publishing a package" },
  { re: /\bkillall\b|\bkill\s+-9\s+-1\b/i, label: "mass process kill" },
];

/** Returns a human-readable danger label if the command is destructive, else null. */
export function classifyDanger(command: string): string | null {
  const cmd = command.trim();
  for (const { re, label } of PATTERNS) {
    if (re.test(cmd)) return label;
  }
  return null;
}
