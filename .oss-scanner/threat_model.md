# kritya — Threat Model

This document describes kritya's intended security goals and how we rate
severity, so OSS Scanner can prioritise findings the way we would.

## What kritya is

kritya is a command-line coding agent. It reads, writes, and edits files in a
user's project directory, searches code, and runs shell commands, looping
autonomously until the request is done. It talks to an OpenAI-compatible LLM
endpoint (NVIDIA build.nvidia.com by default; any compatible provider
otherwise). It supports MCP servers and agent plugins, and has a headless/CI
mode for scripted runs.

The trust model is unusual and it matters for triage: **kritya runs with the
user's own privileges, on the user's own machine, against code the user chose
to point it at.** The asset is the user's machine and credentials, not a
server-side tenant boundary. Findings should be rated with that in mind —
"an attacker with local code execution can read files" is not a finding;
"hostile input from a _lower_ trust level can reach code execution which the
permission system should have blocked" is.

## Assets and trust boundaries

1. **The host filesystem and shell.** kritya can read/write/edit files and run
   shell commands. Everything that mutates state is permission-gated: writes,
   edits, and shell commands ask the user first, subject to configurable
   allow/deny rules.
2. **The sandbox.** On Linux, mutating operations are confined by an
   OS-enforced sandbox (`bwrap`); on macOS by `sandbox-exec`. Writes are
   meant to stay inside the workspace. If the sandbox binary is absent,
   kritya proceeds unsandboxed **with a warning**. That fallback is
   intentional and documented.
3. **Untrusted input.** Three sources:
   - **Repository contents** — file contents, filenames, and command output
     read during a task. This is untrusted and is the primary vector for
     prompt injection.
   - **Tool/command output** — stdout/stderr of shell commands, MCP server
     responses.
   - **The model endpoint** — responses from a provider kritya does not
     control.
4. **Credentials.** Provider API keys (env/config), and whatever secrets
   already exist in the user's environment or project. kritya must not
   exfiltrate these.
5. **Persistence.** Transcript, audit log, and telemetry are written by
   default. **Privacy mode** (`--privacy`, `KRITYA_PRIVACY=1`, or
   `"privacyMode": true`) disables all three. Privacy mode is a
   confidentiality control and its bypass is a security bug.

## Severity guidance

- **Critical**
  - Sandbox escape: a mutation reaching outside the workspace when the sandbox
    is active, or silently disabling the sandbox without the documented
    warning.
  - An action that should have prompted for permission executing **without**
    asking (the permission gate is the core guarantee).
  - Prompt injection from repository contents or tool output that leads to
    code execution, data exfiltration, or credential theft without a user
    prompt.
  - Privacy mode failing to suppress persistence — transcript, audit, or
    telemetry written despite privacy mode being on.
  - Credential/secret exfiltration to a destination other than the configured
    model endpoint.

- **High**
  - Permission-gate bypass that requires an unusual but attacker-reachable
    configuration (e.g. a crafted allow/deny rule, a path that normalises past
    a deny rule).
  - A trust-gate bypass for MCP servers or agent plugins: one marked
    untrusted executing code or being reached without the user's trust
    decision.
  - Undo/redo/checkpoint corruption that silently destroys or misrepresents
    user file state.
  - Path traversal that writes outside the workspace **when the sandbox is
    unavailable and the unsandboxed warning was suppressed**.

- **Medium**
  - Denial of service on kritya itself (crash, hang, unbounded resource use)
    from untrusted repository contents.
  - Information disclosure limited to data already readable by the user's own
    account (e.g. a file in the workspace leaking into the transcript).
  - Prompt injection that only produces wrong output or a misleading summary
    with no state change and no permission bypass.

- **Low**
  - Noisy-but-harmless behaviour, hardening gaps that require an attacker to
    already have code execution at the user's privilege level, and anything
    gated behind an explicit, warned-about opt-out.

## Explicitly in scope

- The permission gate: writes, edits, shell commands, allow/deny rule
  evaluation, and the sandbox backstop (`bwrap` / `sandbox-exec`) plus its
  unsandboxed fallback warning.
- The trust gate for MCP servers and agent plugins.
- Privacy mode enforcement across transcript, audit, and telemetry.
- Handling of untrusted file contents and command/tool output on the path
  from reading to acting (prompt-injection resistance).
- Credential handling: provider API keys never leaving the host except to the
  configured endpoint.
- Headless/CI mode: any behaviour that is less safe than the TTY path.
- The build and publish pipeline (`scripts/check-*.mjs`, `prepublishOnly`) as
  it affects the artifact users install.

## Out of scope

- The security of the model provider or the endpoint.
- Vulnerabilities that require an attacker who already has the user's own
  privileges on the host (they can just read the files).
- Third-party MCP servers or plugins themselves — we gate trust in them, we do
  not vouch for their internals.
- The Electron desktop shell's rendering surface, except where it weakens a
  gate above (e.g. auto-approving a prompt the CLI would ask about).
- Denial of service against the provider's API.
- Any issue that requires the user to pass a secret on the command line.

## Reporting and patches

We would like reports to state the _trust-level crossing_ explicitly: which
component is untrusted, what it reaches, and which gate (permission, sandbox,
trust, privacy) should have stopped it. A reproducer against the built CLI at
`dist/index.js` is ideal; a failing test in the style of `src/test/` is even
better. Where a patch is proposed, prefer the smallest change that restores
the invariant and include the test that would have caught it. The dependency
allowlist in `scripts/audit-allowlist.json` documents our reachability
arguments for accepted upstream CVEs, if a finding overlaps.
