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
  {
    re: /\brm\s+.*(-[a-z]*[rf][a-z]*\b|--recursive\b|--force\b|--no-preserve-root\b)/i,
    label: "recursive/forced file deletion (rm -rf)",
  },
  { re: /(?<!git\s)\brm\b\s+\S/i, label: "file deletion (rm)" },
  { re: /\brmdir\s+\/s/i, label: "recursive directory deletion" },
  {
    re: /\bgit\s+push\b.*(--force(-with-lease)?|-f)\b/i,
    label: "force push (rewrites remote history)",
  },
  { re: /\bgit\s+reset\s+--hard/i, label: "hard reset (discards local changes)" },
  {
    re: /\bgit\s+clean\s+.*(-[a-z]*f[a-z]*\b|--force\b)/i,
    label: "git clean (deletes untracked files)",
  },
  {
    // git restore discards working-tree changes — except the pure --staged
    // form, which only unstages (safe) unless --worktree is also given.
    re: /\bgit\s+checkout\s+--\s|\bgit\s+restore\b(?!\s+--staged\b(?!.*--worktree))/i,
    label: "discards uncommitted changes",
  },
  { re: /\bgit\s+branch\s+(?:\S+\s+)*-D\b/, label: "force-deleting a branch" },
  { re: /\bfind\b.*\s-delete\b/i, label: "bulk file deletion (find -delete)" },
  { re: /\bshred\b/i, label: "irrecoverable file destruction (shred)" },
  { re: /\btruncate\b.*\s-s\s*0\b/i, label: "truncating a file to zero size" },
  { re: /\bxargs\b.*\brm\b/i, label: "bulk file deletion (xargs rm)" },
  { re: /\bdel\b\s+\S*\/(s|q|f)\b/i, label: "bulk file deletion (del)" },
  { re: /\brd\s+\/s/i, label: "recursive directory deletion (rd /s)" },
  { re: /\bformat\s+[a-z]:/i, label: "disk format" },
  {
    re: /\bremove-item\b.*(-recurse\b|-force\b)/i,
    label: "recursive/forced deletion (Remove-Item)",
  },
  { re: /\bmkfs\b/i, label: "filesystem format" },
  { re: /\bdd\b.*\bof=\/dev\//i, label: "raw disk write (dd)" },
  { re: />\s*\/dev\/(sd|nvme|hd|disk)/i, label: "writing to a raw disk device" },
  {
    re: /\bchmod\s+.*(-R\b|--recursive\b).*\b777\b|\bchmod\s+.*\b777\b.*(-R\b|--recursive\b)/i,
    label: "world-writable recursive chmod",
  },
  { re: /\bchown\s+(-R\b|--recursive\b)/i, label: "recursive ownership change" },
  { re: /:\(\)\s*\{.*\}\s*;/, label: "fork bomb" },
  {
    re: /\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(sh|bash|zsh)\b/i,
    label: "piping a remote script into a shell",
  },
  { re: /\bsudo\b/i, label: "elevated privileges (sudo)" },
  { re: /\bshutdown\b|\breboot\b|\bhalt\b|\bpoweroff\b/i, label: "system power state change" },
  { re: /\bnpm\s+publish\b|\byarn\s+publish\b/i, label: "publishing a package" },
  { re: /\bkillall\b|\bkill\s+-9\s+-1\b/i, label: "mass process kill" },

  // Exfiltration: every prior pattern above is about local destruction —
  // none of them catch a command whose actual purpose is sending local files
  // (credentials, source, secrets) to a remote host. classifyDanger forces a
  // warning prompt even under an allowlist, so these need the same coverage.
  {
    re: /\bcurl\b[^|]*(-d|--data(-raw|-binary|-urlencode)?|-F|--form|-T|--upload-file)\b/i,
    label: "uploading data to a remote server (curl)",
  },
  {
    re: /\bwget\b[^|]*(--post-data|--post-file)\b/i,
    label: "uploading data to a remote server (wget)",
  },
  { re: /\bscp\b\s+\S+\s+\S+@/i, label: "copying files to a remote host (scp)" },
  { re: /\brsync\b.*\S+@\S+:/i, label: "syncing files to a remote host (rsync)" },
  { re: /\bnc\b|\bncat\b|\bnetcat\b/i, label: "raw network connection (nc/ncat)" },
  {
    re: /\bcurl\b[^|]*\|\s*\S|\bwget\b\s+-[^|]*-O\s*-[^|]*\|\s*\S/i,
    label: "piping downloaded content into another command",
  },

  // Interpreter/eval evasion: a way to run arbitrary code that doesn't spell
  // out a recognizable destructive command, so the patterns above can't see
  // it — e.g. `eval "$(echo cm0gLXJmIC8=|base64 -d)"` or `python -c "..."`.
  { re: /\beval\b/i, label: "dynamic code evaluation (eval)" },
  { re: /\bbase64\b.*(-d|--decode)\b/i, label: "decoding base64 (often obfuscated payload)" },
  {
    re: /\b(python3?|node|ruby|perl)\b\s+(-c|-e)\b/i,
    label: "running an inline script (bypasses command-text inspection)",
  },
  { re: /\bexec\s+\d*[<>]/i, label: "redirecting a shell's own file descriptors (exec)" },
];

/** Returns a human-readable danger label if the command is destructive, else null. */
export function classifyDanger(command: string): string | null {
  const cmd = command.trim();
  for (const { re, label } of PATTERNS) {
    if (re.test(cmd)) return label;
  }
  return null;
}
