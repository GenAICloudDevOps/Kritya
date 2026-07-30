# Security Policy

## Reporting a vulnerability

Please report security vulnerabilities privately rather than opening a public
issue. Use GitHub's "Report a vulnerability" (Security Advisories) on the
repository, or contact the maintainer directly. We aim to acknowledge reports
within a few days.

## Scope and design notes

kritya runs an autonomous agent that can read and modify files and run shell
commands in the workspace you launch it in. Some safety properties to be aware
of:

- **Permission prompts** gate every mutating tool (`write_file`, `edit_file`,
  `shell`) unless you allowlist them in `settings.json`.
- **Deny rules** (`deny` in `settings.json`) block matching tool calls outright
  and cannot be overridden by an allow rule or an "always allow" choice.
- **Destructive-command detection** forces a warning prompt for commands like
  `rm -rf`, `git push --force`, and `curl | sh`, even when allowlisted. This is
  a regex-based backstop, not a guarantee — it can be evaded (e.g. long-form
  flags like `--recursive --force`, or obfuscation via `$(...)`, `eval`, or a
  base64-encoded payload). Don't rely on it as the sole safeguard for a
  blanket `shell(*)` allow rule.
- **Sandboxed execution** (`sandboxExec` in config, opt-in — see README) adds
  an OS-enforced backstop for the case above: matched commands (or, in
  `"always"` mode, every command) run under `bwrap` (Linux) or `sandbox-exec`
  (macOS) with writes confined to the workspace, so evading the regex no
  longer means unrestricted write access to the rest of the machine. It does
  not confine reads or network access, and there's no equivalent on Windows
  yet — treat it as raising the cost of an evasion, not eliminating one.
- **File access is confined** to the workspace root, and paths that look like
  secrets (`.env*`, `.git/config`, `*credentials*`, `*secret*`, private keys)
  are blocked from being read or written by tools, regardless of allowlist
  rules.
- **Untrusted content** from web search and MCP tools is wrapped in explicit
  markers, and the system prompt instructs the model to treat all tool output
  as data, never as instructions. Prompt injection via file/command/web content
  is nonetheless a real risk with any LLM agent — review changes before trusting
  them, and use plan mode (`/plan`) for unfamiliar repositories.

## Privacy / telemetry

kritya collects **no telemetry** by default. It talks only to the model
provider you configure (and to Tavily if you use web search). The one opt-in
exception is `KRITYA_OTEL_ENDPOINT`: if explicitly set, tracing/metrics spans
are exported to the OpenTelemetry Collector endpoint you configure — nothing
leaves the machine unless you set that yourself. See the README's
Observability and Privacy sections.
