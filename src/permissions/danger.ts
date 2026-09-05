/**
 * Flags shell commands that are destructive or irreversible. When a command
 * matches, kritya forces a permission prompt with a warning even if the
 * command would otherwise be covered by an allowlist rule or an "always allow"
 * choice — so a blanket `shell(*)` allow can't silently run `rm -rf /`.
 *
 * This is pattern matching over command text, not a shell parser — it can
 * only see danger words that actually appear in the string. It normalizes
 * one specific evasion ($IFS in place of a space) and flags several ways of
 * running an opaque payload (eval, base64 -d, an interpreter's -c/-e,
 * PowerShell's -EncodedCommand), but a command that reassembles a dangerous
 * word at runtime without those (e.g. `a=r;b=m;$a$b -rf /`, or piping
 * through `tr`/`rev`) has no literal substring left to match and will not be
 * caught. Sandboxing (src/shell/sandbox.ts) is the actual backstop for that
 * gap, not a replacement for closing it here.
 */

interface DangerPattern {
  re: RegExp;
  label: string;
}

/**
 * `$IFS`/`${IFS}` in place of a literal space is a well-known filter-bypass
 * trick (`rm${IFS}-rf${IFS}/` runs exactly like `rm -rf /`, but every
 * pattern below that requires `\s+` between a command and its arguments
 * never sees a whitespace character to match). Since this is purely a
 * word-separator substitution — nothing about how the shell actually runs
 * the command — normalizing it to a literal space before pattern matching
 * catches the same commands the patterns already catch, without changing
 * what any of them mean.
 */
const IFS_RE = /\$\{IFS[^}]*\}|\$IFS\b/g;

function normalizeForDangerCheck(command: string): string {
  return command.replace(IFS_RE, " ");
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
  {
    // Shells' inline-command flag is -c specifically; unlike the
    // interpreters above, -e means something else for a shell (errexit) and
    // would false-positive on an ordinary `bash -e build.sh`.
    re: /\b(bash|sh|zsh|dash|ksh)\b\s+-c\b/i,
    label: "running an inline shell command (bypasses command-text inspection)",
  },
  {
    // PowerShell accepts any unambiguous prefix of -EncodedCommand (-enc,
    // -encodedcommand, ...); "en" is enough to disambiguate it from every
    // other powershell.exe flag (-ExecutionPolicy starts "ex", not "en").
    // This is the same base64-obfuscation evasion the generic `base64 -d`
    // pattern above catches for POSIX shells, just spelled differently.
    re: /\b(powershell(\.exe)?|pwsh)\b.*\s-en[a-z]*\b/i,
    label: "running a base64-encoded PowerShell command (-EncodedCommand)",
  },
  { re: /\bexec\s+\d*[<>]/i, label: "redirecting a shell's own file descriptors (exec)" },
];

/** Returns a human-readable danger label if the command is destructive, else null. */
export function classifyDanger(command: string): string | null {
  const cmd = normalizeForDangerCheck(command.trim());
  for (const { re, label } of PATTERNS) {
    if (re.test(cmd)) return label;
  }
  return null;
}
