# Security Policy

## Reporting a vulnerability

Please report security vulnerabilities privately rather than opening a public
issue. Use GitHub's "Report a vulnerability" (Security Advisories) on the
repository, or contact the maintainer directly. We aim to acknowledge reports
within a few days.

kritya is beta software. The properties below are implemented and covered by
automated checks (`npm audit`, Dependabot), but have not had a third-party
security audit or penetration test — treat them as defense-in-depth, not a
certified guarantee.

## Dependency scanning

CI runs `npm audit` through a reviewed gate
(`scripts/check-audit.mjs`) rather than a bare `--audit-level=high`, and the
package is also monitored on [Socket](https://socket.dev/npm/package/kritya).
Findings from both fall into two buckets:

- **High-severity CVEs with no available fix** are recorded in
  `scripts/audit-allowlist.json` with a reachability argument — why the
  vulnerable code path isn't reachable from kritya's own code — and an expiry
  date that forces a re-check. As of this writing, that covers two advisories
  in `image-size`'s ICNS/JXL/HEIF parsers (GHSA-w3rx-r6r6-pgpr,
  GHSA-5p2g-fcmc-qvqq), pulled in transitively via `pptxgenjs`. The parsers
  are only reached through `pptxgenjs`'s `addImage()`, which kritya never
  calls; no patched `image-size` exists, and npm's only suggested fix
  downgrades `pptxgenjs` to a version that removes the feature rather than
  fixing it.
- **Socket's supply-chain heuristics** ("obfuscated code," "deprecated,"
  "AI-detected anomaly," etc.) are reviewed rather than acted on
  automatically, since they flag patterns, not confirmed exploits:
  - "Obfuscated code" on `exceljs`, `pdf-lib`, `underscore`,
    `electron-winstaller`, `tiny-async-pool`, and `yargs` is a false positive
    on normal packaging, not real obfuscation — checked directly: none of
    the flagged files show minification or bundling signatures (longest
    lines run 81-1540 characters of readable code, consistent with
    TypeScript-compiled output or a bundled `dist` shipped for browser use,
    not mangled/packed code). `exceljs`, `pdf-lib`, and `underscore` are
    already pinned to their latest published version, and higher-profile
    alternatives in this space (e.g. SheetJS/`xlsx` in place of `exceljs`)
    carry a worse CVE history while triggering the same flag.
    `electron-winstaller`, `tiny-async-pool`, and `yargs` (the latter also
    via `c8`) are transitive `electron-builder`/dev-tooling dependencies
    that never ship in the published package (`files: ["dist"]` in
    `package.json` excludes `dist/test` and `dist/electron`).
  - "Deprecated" on `boolean` and `rimraf@2.6.3` traces to
    `electron-builder`'s own dependency tree (via `@electron/get` →
    `global-agent`, and `electron-builder-squirrel-windows` →
    `electron-winstaller`), 4-5 levels deep. `electron-builder` is already on
    its latest release; this is a maintainer-status flag on transitive deps
    kritya doesn't control, not a vulnerability.
  - `@xmldom/xmldom@0.8.15` carries a maintainer deprecation notice
    ("this version has critical issues, please update to the latest
    version"). The latest release, `0.9.12`, was tried via an `overrides`
    pin and reverted: `0.9.x` requires an explicit `mimeType` argument to
    `DOMParser.parseFromString`, which `mammoth@1.12.2` (itself the latest
    release, and the package that pulls `xmldom` in for `.docx` parsing)
    calls without one, breaking `.docx` reading (3 test failures in
    `document.test.js`). `mammoth` still declares `^0.8.6` for `xmldom`, so
    there is currently no combination that gets the deprecation fix without
    breaking `.docx` support. Revisit once `mammoth` adapts to the new
    `xmldom` API.

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
- **Sandboxed execution** (`sandboxExec` in config — see
  [Sandboxed execution](docs/CONFIGURATION.md#sandboxed-execution)) adds an
  OS-enforced backstop for the case above: shell commands run under `bwrap`
  (Linux) or `sandbox-exec` (macOS) with writes confined to the workspace, so
  evading the regex no longer means unrestricted write access to the rest of
  the machine. Default is `"auto"`, which sandboxes every command on
  Linux/macOS when the required binary is present, and (since there's no
  sandbox binary to fall back to) only commands flagged as dangerous on
  Windows; `"always"` and `"strict"` sandbox every command on every platform.
  It does not confine reads or network access — treat it as raising the cost
  of an evasion, not eliminating one. `"auto"` and `"always"` fall back to an
  unsandboxed run (with a warning) if the sandbox binary isn't available;
  `"strict"` refuses to run the command at all in that case instead.
- **File access is confined** to the workspace root — including via a symlink
  inside the workspace that points outside it — and paths that look like
  secrets (`.env*`, `.git/config`, `*credentials*`, `*secret*`, private keys)
  are blocked from being read or written by tools, regardless of allowlist
  rules. The `shell` tool gets the same filename-based check: a command whose
  text references a sensitive path (`cat .env`, `grep foo .env`) is refused
  rather than relying on output redaction alone. That check can only see the
  literal filename in the command text, so shell expansion or unusual quoting
  can slip past it.
- **Secret scanning on write.** Filename checks only cover secrets kept in
  files that _look_ sensitive; they do nothing to stop the model writing a
  real key it saw in some tool output into an ordinary file like `README.md`.
  So `write_file` and `edit_file` also scan the **content** being written for
  known key formats (AWS, GitHub, GitLab, Slack, Stripe, Google, OpenAI,
  Anthropic, npm, PyPI, Azure, GCP, private key blocks, …) and high-entropy
  secret-shaped assignments, and block the write. Shell and
  background-process output is redacted with the same patterns before it
  reaches the transcript. Both are heuristics — they can miss a novel key
  format and can false-positive on random-looking fixtures.
- **SSRF guard.** `fetch_url` and the MCP HTTP transport share one host check
  that refuses private, loopback, link-local, and carrier-grade-NAT ranges, so
  neither can be steered into your internal network or a cloud metadata
  endpoint.
- **Workspace trust.** A repository's own `.kritya/settings.json` allow rules,
  hooks, `.env`, custom commands, `.mcp.json`, and `.kritya/plugins/` are all
  inert until you trust that workspace, so cloning a hostile repo can't
  self-grant permissions or run code just by being opened. Trust is keyed on a
  hash of the gated content, so changing it re-prompts. In headless/CI mode
  this is off unless `--trust` is passed, since CI often checks out untrusted
  branches and PRs.
- **Per-server MCP trust.** Every MCP server is arbitrary code (stdio) or a
  remote endpoint (HTTP) running with your credentials, so each one _also_
  gets its own first-use confirmation on top of workspace trust — approving a
  repo's `.mcp.json` once does not blanket-approve servers a later commit
  adds. The fingerprint covers the declared, pre-expansion config (never
  expanded env/header values, which may hold live secrets); if a server's
  command, args, cwd, url, tool filter, or env/header key names change, it
  counts as new and re-prompts. `/mcp trust` lists approvals and
  `/mcp trust revoke <name>` withdraws them.
- **Agent Plugins** are covered by both gates: a workspace plugin is only
  discovered once the workspace is trusted, and any MCP server it declares
  still needs its own per-server approval. See
  [Agent Plugins](docs/CONFIGURATION.md#agent-plugins).
- **Untrusted content** from web search and MCP tools is wrapped in explicit
  markers, and the system prompt instructs the model to treat all tool output
  as data, never as instructions. Prompt injection via file/command/web content
  is nonetheless a real risk with any LLM agent — review changes before trusting
  them, and use plan mode (`/plan`) for unfamiliar repositories.
- **Subagents** inherit these limits rather than escaping them. Read-only
  subagents get no write, edit, or shell tool at all; write-capable subagents
  are isolated on their own git worktree/branch and have destructive commands
  blocked outright, since there's no one present to confirm a prompt.

## AI disclosure (EU AI Act Article 50)

kritya is an AI agent: you launch it by name and it reads/writes files and
runs shell commands via a model you configure, so there is no disguise to
disclose — Article 50(1)'s "obvious from the circumstances" exemption
applies. On first interactive run in a workspace, kritya prints a one-time
notice to that effect, recording the acknowledgment (with a timestamp, not
just a boolean) in `~/.kritya/ai-disclosure.json`, keyed by workspace path —
so it shows again in a new project rather than being silently suppressed
machine-wide. By default, `/commit` appends a
`Generated-By: kritya (<provider>/<model>)` trailer to the commit message it
writes, disclosing that the change was AI-assisted; set `commitAttribution`
to `false` in config to opt out.

**Headless/CI mode.** `kritya --prompt` never shows the interactive notice —
this is a deliberate scope decision, not an oversight. There is no TTY to
show a notice to and no human present to read one; the workspace's own
`.kritya/settings.json` allow rules, hooks, `.env`, and custom commands stay
inert there unless `--trust` is passed explicitly (see "Scope and design
notes" above), and that explicit flag is itself the informed, deliberate
invocation Article 50(1)'s "obvious from the circumstances" exemption turns
on.

**Scope.** kritya's own disclosure covers kritya as the AI _system_ under
Article 50(1) — it does not, and cannot, discharge whatever separate
obligations your chosen model provider (NVIDIA, OpenAI, Anthropic, etc.) has
as a GPAI _model_ provider under Title VIII. Those are a different party's
responsibility under the Act.

## Privacy / telemetry

kritya collects **no telemetry** by default. It talks only to the model
provider you configure (and to Tavily if you use web search). The one opt-in
exception is `KRITYA_OTEL_ENDPOINT`: if explicitly set, tracing/metrics spans
are exported to the OpenTelemetry Collector endpoint you configure — nothing
leaves the machine unless you set that yourself. See the README's
[Privacy](README.md#privacy) section,
[Audit log & telemetry](docs/CONFIGURATION.md#audit-log--telemetry), and
[docs/observability.md](docs/observability.md) for the local collector setup.

### Data at rest

Everything kritya keeps — config, session transcripts, the audit log, MCP
OAuth tokens, and trust manifests — lives under `~/.kritya/`.

- Those files are created `0600` inside `0700` directories. Because POSIX mode
  bits are a no-op on NTFS, on Windows kritya additionally strips inherited
  ACEs from `~/.kritya/` and grants full control to only the current user and
  SYSTEM, so the same owner-only isolation applies there.
- Session transcripts, audit logs, and telemetry files are auto-deleted after
  **15 days** by default (`retentionDays` in config, or
  `KRITYA_RETENTION_DAYS`). Set it to `0` to keep everything indefinitely. See
  [Audit log & telemetry](docs/CONFIGURATION.md#audit-log--telemetry).

Note that the audit log is a local, user-owned record rather than telemetry —
it is never transmitted anywhere.
