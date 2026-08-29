# Changelog

All notable changes to kritya are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.8.14-beta] — 2026-08-29

### Changed

- CI's `supply-chain` job now also runs `socket ci` (Socket's dependency
  security scan) alongside `npm audit`, catching malware, obfuscated
  packages, and risky install-script behavior that a CVE-only audit
  doesn't. Skipped on fork PRs, since GitHub withholds repo secrets there.
- `SECURITY.md` documents the reasoning behind every reviewed Socket
  dependency-scanning finding (the 2 allowlisted `image-size` CVEs, 6
  obfuscated-code false positives, `boolean`/`rimraf` deprecation, and
  `@xmldom/xmldom`'s deprecation notice — the last confirmed unfixable for
  now: `0.9.x` breaks `.docx` reading since `mammoth`'s latest release
  doesn't pass the now-required `mimeType` argument to
  `DOMParser.parseFromString`).
- Incidental: `@xmldom/xmldom` (via `mammoth`) moved 0.8.13 → 0.8.15, a
  patch-level resolution picked up while testing (and reverting) the
  above.

## [0.8.13-beta] — 2026-08-29

### Changed

- Bumped `@types/node`, `eslint`, `lint-staged`, `mammoth`, `openai`,
  `pdfjs-dist`, and `typescript-eslint` to their latest compatible
  versions. Routine dependency maintenance, not a CVE fix — the 2 known
  high-severity advisories (`image-size`, via `pptxgenjs`) remain
  unpatched upstream and stay allowlisted in `scripts/audit-allowlist.json`.

## [0.8.12-beta] — 2026-08-28

### Added

- MCP servers are now checked for tool-shape drift, not just config drift.
  Approving a server's config (command, url, env keys, ...) only promised
  you'd reviewed where it runs and what it can reach — a compromised or
  updated server could still change its actual tools (names, descriptions,
  input schemas) on any connection without touching its declared config.
  The first connection after approval records the tool shape; a later
  mismatch refuses the connection instead of silently loading the new
  tools, and points at `/mcp trust revoke <name>` to review and re-approve.

## [0.8.11-beta] — 2026-08-28

### Added

- Releases now publish through a tag-triggered GitHub Actions workflow
  (`.github/workflows/publish.yml`) instead of a local `npm publish`.
  Uses npm's OIDC trusted publishing for a verifiable build-to-source
  provenance attestation to the `beta` dist-tag, and creates the
  matching GitHub prerelease — fully secretless, no stored npm token.
  Pointing `latest` at a release stays a deliberate manual step
  (`npm dist-tag add kritya@<version> latest`) while still in beta.

### Fixed

- **Headless mode had no kill switch path** — `Ctrl+C`/`SIGTERM` during
  a `--prompt` run killed the process outright, skipping the audit log
  and orphaning background shells/MCP children. Both signals now engage
  the same kill switch the interactive session's `Ctrl+K` uses, so a
  headless/CI run stops cleanly and the stop is recorded.

## [0.8.10-beta] — 2026-08-28

### Added

- Added `moonshotai/kimi-k3` ("strong agentic tool use") to the curated
  model picker. The default model is unchanged.

## [0.8.9-beta] — 2026-08-26

### Removed

- Dropped Inkling, GLM 5.2, Qwen3.5 397B, Kimi K2.6, and DeepSeek V4 Pro
  from the curated model picker. Inkling and GLM 5.2 are also gone from
  switchyard's direct-fallback pool, which now falls back to just
  `meta/muse-glimmer-30b` if the sidecar itself is unreachable.

## [0.8.8-beta] — 2026-08-25

### Security

- **Unbounded decompression in `.xlsx` reading (CVE-2026-78206)** —
  `exceljs`'s xlsx loader decompresses every zip entry with no size limit
  (no upstream fix available), and `read_document`/`edit_spreadsheet` feed
  it any `.xlsx` file the model points to inside the workspace. A crafted
  file could exhaust memory. Anything whose declared uncompressed size
  (read cheaply from the zip's central directory, no inflation) exceeds
  200MB is now rejected before `exceljs` ever sees it.

### Changed

- Left guardrail comments at the `exceljs` code paths kritya doesn't use
  yet (`cell.note` prototype pollution, `addImage` path traversal, CSV
  formula injection) so they aren't reintroduced blindly if those
  features are added later.

## [0.8.7-beta] — 2026-08-25

### Changed

- Added `repository`, `homepage`, `bugs`, and `author` to `package.json` —
  standard maintainer/provenance metadata that was previously missing.
- Bumped `mammoth` (1.12.0 → 1.12.1), `fast-glob` (3.3.2 → 3.3.3), and
  `openai` (7.4.0 → 7.5.0) to their latest published versions.

## [0.8.6-beta] — 2026-08-25

### Changed

- `sandboxExec: "auto"`/`"always"` no longer silently fall back to an
  unsandboxed run when no sandbox binary is installed. In an interactive
  session, the first such command now forces a red warning prompt that
  must be explicitly approved; approving it once is remembered for the
  rest of the session. Headless runs and unattended write-subagents are
  unaffected — they still run with the existing after-the-fact note,
  since there's no one present to answer the prompt.

## [0.8.5-beta] — 2026-08-25

### Added

- Nemotron 3 Nano Omni 30B Reasoning added to the curated NVIDIA models list.

### Changed

- `no-explicit-any` is now enforced for app code (scoped off for tests).

## [0.8.4-beta] — 2026-08-25

### Security

- **Reflected XSS in the MCP OAuth callback page** — `error_description`
  and other query-string values were interpolated into the local callback
  server's HTML response without escaping. Both fields are now HTML-escaped.
- **Double-unescaping in `fetch_url`'s HTML-to-text conversion** — decoding
  `&amp;` before `&lt;`/`&gt;` let a doubly-encoded string collapse into a
  live tag. `&amp;` is now decoded last, and the `<script>`/`<style>`/
  `<noscript>` stripping regexes tolerate unclosed or malformed closing tags.
- **Custom permission rules now match resolved paths** — a `deny`/`allow`
  rule like `write_file(.env*)` only matched the exact literal path string
  the model passed, so `./.env` or `sub/../.env` could slip past it. Rules
  now match against the path resolved relative to the workspace, same as
  the built-in sensitive-path check.
- Hardened `.github/workflows/build.yml` with explicit
  `permissions: contents: read` (OpenSSF Scorecard Token-Permissions).

### Added

- Secret scanning now detects npm access tokens, PyPI upload tokens, Azure
  Storage Account keys, and GCP service account keys, in addition to the
  existing AWS/GitHub/GitLab/Slack/Stripe/Anthropic/OpenAI/Google patterns.

### Changed

- Bumped Electron from 43.3.0 to 43.4.1.

## [0.8.3-beta] — 2026-08-23

### Fixed

- **`.env` values redacted in the trust prompt** — reviewing a workspace's
  trust settings previously printed secret values (API keys, tokens) in
  plaintext. Only variable names are now shown; values are redacted so
  credentials aren't exposed in the terminal, scrollback, or recordings.
- **LSP client no longer crashes on a stdin write racing shutdown** — a
  write in flight when the client is disposed could throw an unhandled
  EPIPE error; it's now swallowed, most noticeable on Windows where the
  kill/pipe-teardown timing made this common.

### Changed

- CI hardening: workflow timeouts, `harden-runner` audit mode, OpenSSF
  Scorecard, and CodeQL re-enabled alongside the macOS test leg.
- README now shows CI, npm version, and license badges.

## [0.8.2-beta] — 2026-08-22

### Changed

- **npm package trimmed** — `dist/test/**` and `dist/electron/**` are now
  excluded from the published tarball, cutting package size roughly in
  half; local build, tests, and Electron scripts are unaffected.

## [0.8.1-beta] — 2026-08-22

### Changed

- **DeepSeek V4 Flash model ID updated** to `deepseek-ai/deepseek-v4-flash-0731`.

## [0.8.0-beta] — 2026-08-21

### Added

- **EU AI Act disclosure** — one-time, per-workspace notice on first
  interactive launch (Art. 50(1)/(2)), recorded with a timestamp in
  `~/.kritya/ai-disclosure.json`. `/commit` appends a
  `Generated-By: kritya (<provider>/<model>)` trailer by default; set
  `commitAttribution` to `false` to opt out. Headless/`--prompt` mode shows
  no notice, consistent with the existing `--trust` scope decision.
- **Project workflow: fix phase, `ask_user`, stale-artifact warnings** —
  workflow commands renamed to `/flow-brainstorm`, `/flow-spec`,
  `/flow-plan`, `/flow-build`, `/flow-review`, plus a new `/flow-fix` phase
  that addresses review findings and re-verifies each one. Brainstorm and
  spec gain an `ask_user` multiple-choice tool; spec tags criteria
  MUST/LATER, plan tags milestones RISKY/ROUTINE, and each phase warns when
  an earlier artifact was edited after later phases depended on it.
- **Non-functional requirements in the workflow** — spec now asks about
  security/reliability/performance/observability requirements up front
  (tagged SEC#/REL#) instead of catching them only at review time; build
  enforces test-first ordering and a failure-path test for tagged
  milestones; review adds a third RELIABILITY subagent.

### Fixed

- `kritya` vs `kritya --provider <name>` now consistently pick the right
  provider/model.
- An empty-bodied 404 from the provider is retried instead of losing the
  turn.
- `sandboxExec` now defaults to `"strict"` on Windows, since there's no
  sandbox binary there to back `"auto"`/`"always"` — a flagged command
  previously ran unprotected.

### Changed

- CI now tests Node 22.x and 24.x on Ubuntu; the macOS leg was dropped
  (10x the cost of Linux) — `src/shell/sandbox.ts`'s `sandbox-exec` path
  has no CI coverage as a result and needs manual/macOS testing for changes.

## [0.7.0-beta] — 2026-08-12

### Added

- **NeMo Switchyard provider** — `--provider switchyard` (or `/provider
switchyard` mid-session) routes each turn across multiple NVIDIA models
  instead of one fixed model, using
  [NeMo Switchyard](https://github.com/NVIDIA-NeMo/Switchyard). kritya
  manages the `switchyard-server` sidecar itself — generating its config,
  launching it on a free port, and waiting for it to be ready — so there's
  nothing to run separately. Routing classifies each request and picks
  between Nemotron 3.5 Lightning and Nemotron 3 Ultra per turn; if the
  sidecar's own retries are exhausted, kritya falls back to three more
  curated models called directly (Switchyard has no built-in cross-model
  fallback). The status line shows which model actually served each turn.
  See `docs/CONFIGURATION.md#nemo-switchyard`.
- **Two models in the curated registry** — `nvidia/nemotron-3.5-lightning-30b-a3b`
  (now the default) and `meta/muse-glimmer-30b`, both with a 128k context
  window. As always, newer IDs can be added via `customModels` in
  `~/.kritya/config.json` rather than waiting on a release.
- **Mermaid flowcharts render as ASCII trees** — a ```mermaid block in an
  answer is drawn in the terminal instead of being printed as raw source, and
  the system prompt now steers diagram requests into the chat rather than
  into a written file.

### Changed

- **`npm audit` in CI runs behind a reviewed, expiring allowlist** — npm can
  only suppress findings by severity, so a single unfixable advisory would
  otherwise force the choice between a permanently red build and lowering the
  gate for every future high-severity finding. `scripts/check-audit.mjs`
  suppresses individual advisories by GHSA id and still fails on everything
  else at high or above; each entry in `scripts/audit-allowlist.json` records
  why the vulnerable code path is unreachable and carries an expiry date that
  fails the build once passed. The gate fails closed — npm reporting its own
  failure (a missing lockfile, an unreachable registry) as well-formed JSON
  is treated as an error, not as "no vulnerabilities".
- **The `deepwiki` and `context7` MCP servers are no longer configured by
  default** — every exposed tool's schema is sent on every request, so two
  servers nobody explicitly asked for cost tokens on each turn.

### Security

- **Sandbox, permission rules, secrets, and workspace trust hardened** — adds
  a `"strict"` sandbox mode that refuses to run rather than falling back
  unsandboxed; stops redirection and background operators from bypassing
  shell allowlist rules; blocks writes anywhere under `.git` (not just
  `.git/config`), closing a hook-based code-execution path; strips auth
  tokens, secrets, passwords, and AWS credentials from the environment shell
  commands inherit; rejects numeric and encoded IP forms in `fetch_url` and
  covers more private ranges; gates `KRITYA.md` and workspace skills behind
  workspace trust so an untrusted checkout can't inject prompt content; adds
  danger patterns for data exfiltration and `eval`/base64-based evasion;
  randomizes and locks down the macOS sandbox profile temp file; and blocks
  more sensitive file patterns (kube config, docker config, `.ppk`, `.jks`,
  `.gitconfig`).
- **`shell` refuses commands that name a sensitive file** — output redaction
  only caught known secret _patterns_ after a command ran, so `cat .env` could
  still leak a value in a shape the matcher didn't recognize (a
  `DATABASE_URL`, say). The filename check that already gates
  `read_file`/`write_file` now runs against the command up front.

## [0.6.0-beta] — 2026-07-29

### Added

- **Agent Skills** — kritya now supports the open Agent Skills format. Drop a
  `SKILL.md` file (with `name` and `description` frontmatter fields) in
  `.kritya/skills/<name>/` and the agent picks it up automatically: a
  lightweight name-and-description listing goes into the system prompt so
  the model knows the skill exists, and it loads the skill's full
  instructions on demand through a new `load_skill` tool — along with the
  contents of any bundled `scripts/`, `references/`, or `assets/`
  directories the skill ships alongside its `SKILL.md`. Skills are also
  scanned from `~/.kritya/skills` as a user-global root (project skills win
  on a name collision), can opt out of discovery with `disabled: true`, and
  the frontmatter parser now accepts quoted values (so a description
  containing a colon, like "Use when: doing X", no longer breaks the
  `key: value` split) and YAML's folded (`>`) and literal (`|`) block
  scalars for a longer multi-line description. A new `kritya skills [dir]
[--json] [--validate]` subcommand lists project vs. user-global skills,
  shows why any skill was skipped, and lets CI fail fast on a malformed one.
- **Electron desktop app** — `electron/` wraps the same agent core in a
  cross-platform GUI (`npm run electron:dev` / `electron:build`). The
  renderer has UI parity with the terminal client: live usage/retry status,
  a Stop/Resume control backed by the same kill switch, the running task
  checklist, real Markdown rendering, and plan/dry-run/accept-edits mode
  toggles.
- **OTLP telemetry export** — the local-only tracer/meter can now also
  export to a real OpenTelemetry Collector: set `KRITYA_OTEL_ENDPOINT`
  (optionally with `KRITYA_OTEL_HEADERS`) and spans and a new set of metrics
  (`kritya.tool.duration_ms`, `kritya.tool.calls`, `kritya.turn.duration_ms`
  — counters and histograms via a new `Meter`, mirroring the existing
  `Tracer`) are shipped as OTLP/HTTP JSON. `docs/observability.md` documents
  a Docker-free local pipeline (`observability/`) — Collector → Phoenix
  (traces) + Prometheus/Grafana (metrics) — installable as plain binaries.
  This is opt-in and off unless `KRITYA_OTEL_ENDPOINT` is set; see the
  Privacy note below.
- **MCP spec 2026-07-28 alignment** — protocol version bumped, plus three
  new server-initiated capabilities: `sampling/createMessage` (a server can
  ask kritya to run a completion against your configured model, gated by
  the same permission prompt as a tool call, with a "yes, always this
  session" option), `elicitation/create` (a server can ask the user a short
  structured question — boolean, string, or enum fields — surfaced as a new
  prompt phase/component), and per-server `"consent": "always-confirm"` to
  require approval for every call from a server regardless of its
  `readOnlyHint`. Both sampling and elicitation are declined automatically
  in headless/non-interactive mode.
- **MCP Tasks extension** — a server whose long-running tools (a CI
  pipeline, a batch job, a human approval step) support the [Tasks
  extension](https://modelcontextprotocol.io/extensions/tasks/overview) can
  opt in with `"tasks": true`; kritya then polls a returned task handle in
  the background instead of blocking, with the spinner growing a live
  status suffix. A task's own `input_required` step is answered the same
  way a direct `elicitation/create` request would be; anything else is
  cancelled with an error naming what it needed. The poll loop is
  abort-aware (an Esc/kill interrupts the sleep immediately rather than
  waiting out the interval), sends `tasks/cancel` on abort instead of
  orphaning the task server-side, clamps `pollIntervalMs` to `[250ms, 60s]`
  to prevent a busy-poll on a bad value, and errors by name on an
  unrecognized task status instead of looping forever. Off by default, same
  reasoning as `consent`: a server has no grounds to return a task the
  client never said it could handle.
- **`onToolProgress`** — `ToolDef.execute` can now report incremental
  progress text through `ToolExecutor`, which is what the Tasks extension's
  live spinner status is built on.

### Changed

- **A tool call reports its result instead of dumping the top of it** — every
  call cost four or five lines: three lines of raw output plus a truncation
  note, whether or not those lines told you anything. The first three
  filenames of a listing don't; the count does. Read-only tools now describe
  what they produced — `✓ List src/ui — 14 entries`,
  `✓ Grep /stringWidth/ in src — 15 matches in 4 files` — and Ctrl+O still
  expands the real output. `shell` keeps its preview, since there the output
  is the answer, and a failed call now shows eight lines rather than three:
  a failure is when the detail is worth the rows. `write` says nothing under
  its own line any more (`✓ Write scratch.txt (20 bytes)` followed by "Wrote
  scratch.txt" was the same sentence twice); `edit` reports its replacement
  count inline.
- **Model-facing scaffolding stays out of the preview** — the
  `<<<external_untrusted_content>>>` fence around web and MCP results is an
  instruction about how the _model_ should treat what follows, and it was
  taking the first line of every search preview. Provider citation markers
  like `【1†L1-L4】` now render as `[1]`.
- **The task checklist is the width of its tasks**, not of the terminal.
- **A silent command says so on its own line** — `✓ Run: … — no output` rather
  than a preview line reading `(no output)`.
- **Node 22 is now the minimum** (`engines: >=22`). Node 20 reached end of life
  in April 2026, so CI no longer tests it and the package no longer claims to
  support it. The matrix is Ubuntu on 22 and 24, with Windows and macOS pinned
  to 22 — the per-OS code paths only ever run on their own runner, so that job
  is the one place they meet the oldest Node we support.
- **Dependency upgrades**: `openai` 4.104.0 → 6.49.0 (no code changes needed),
  `pdfjs-dist` 4.10.38 → 6.1.200 (`PDFDocumentProxy.destroy()` moved to
  `PDFDocumentLoadingTask`, `readPdf()` updated accordingly), `string-width`
  7.2.0 → 8.2.2, and `react`/`@types/react`/`ink` bumped together to v19/v7
  (Ink 6+ requires React ≥19). TypeScript held at 6.0.3 since
  `typescript-eslint` doesn't yet support TS 7.
- **Internal: `loop.ts`, `App.tsx`, `useAgent.ts`, and `client.ts` split into
  focused modules** — each had grown to cover several unrelated concerns.
  Tool-call permission gating/execution moved out of `loop.ts` into
  `toolExecutor.ts`; stdio/HTTP transport and JSON-RPC plumbing moved out of
  `client.ts` into `transport.ts`; `useAgent.ts`'s kill-switch, usage/budget,
  and session-resume state each became their own hook; `App.tsx`'s
  tool-output preview, transcript-item renderer, and status bar moved into
  their own files. No behavior change — verified against the full test suite
  after each extraction.

### Fixed

- **A long answer no longer prints twice** — Ink erases its live region by
  rewinding a line count, which can only reach what is still on screen. Once a
  streaming answer grew taller than the terminal, the erase silently came up
  short and stranded a partial copy in the scrollback; the finished message
  then printed below it, so the reply appeared twice, spliced mid-sentence at
  the seam. The live view now shows the tail that fits the viewport (reopening
  a code fence it was cut inside of), and the whole answer prints once when the
  turn ends. The height of that tail is measured with the same word-wrapping
  the renderer uses: dividing character count by column count assumes words can
  break mid-word, which under-counts every wrapped paragraph by a row and left
  exactly one stranded line behind — the same bug, shrunk from pages to a
  sentence fragment.
- **A failed command shows a red ✗** — `shell` resolves on a nonzero exit
  instead of throwing, since the model needs the output either way, but that
  also meant `cat missing-file` was reported to the user with a green check.
  Tools can now declare that output they returned normally still represents a
  failure.

- **Tool output previews are readable again** — `read` numbers its lines with a
  tab, which the terminal took to the next 8-column stop, so every preview of a
  file opened with a ragged gap eating a quarter of the width. Tabs are now
  expanded, indentation every line shares is dropped, and lines are clipped
  with `…` rather than wrapped, so a three-line preview occupies three lines.
- **A repeated tool call no longer repeats its output** — a model that reads
  the same file six times still gets six lines (hiding calls would misreport
  what it did), but the identical preview is printed once.
- **Code blocks are the width of their code** — the frame stretched to the
  terminal's full width, so a two-line snippet drew a box across the screen.

- **HTML entities are decoded** — a model that wants to show a `|` inside a
  table cell has to write `&#124;`, and the terminal printed that literally.
  Numeric and common named entities are now decoded after the markup is parsed
  (so `&#42;` can't turn itself into emphasis) and never inside a code span.
  Anything unrecognised, `R&D` included, is left exactly as written.
- **Long URLs break after a separator** — a URL too long for the terminal was
  cut at whatever character landed on the boundary, mid-segment. It now prefers
  the last `/`, `-`, or `?` on the line when one is close enough to the edge.
- **Narrow terminals stop stacking tables that would have fit** — the grid was
  abandoned below a fixed 60 columns, which threw away perfectly readable
  two-column tables of short cells. The decision now weighs what the table
  actually needs against the width available.

- **Tables render as tables** — the markdown renderer knew about code fences,
  headers, bullets, and inline code, and passed everything else through as
  plain text. A table was just a long string, so Ink wrapped it at the
  terminal's width and the columns dissolved into pipe soup. Tables are now
  parsed (a delimiter row is required, so prose containing a pipe is left
  alone) and laid out to fit the terminal: cells wrap _inside_ their column,
  which is what keeps the row from wrapping. Column alignment comes from the
  delimiter row, `<br>` inside a cell becomes a line break, widths are measured
  in display columns so emoji and CJK line up, and under 60 columns — or past
  five columns — each row degrades to a labelled block instead of an
  unreadable grid. While streaming, a table whose delimiter row hasn't arrived
  yet is held back rather than shown as raw pipes for a moment.
- **Emphasis is no longer printed as asterisks** — `**bold**`, `*italic*`, and
  `[text](url)` are parsed everywhere (headers, bullets, quotes, table cells)
  by one shared inline pass, which is also what measures table columns against
  what is displayed rather than the source. `2 * 3`, `a*b`, and glob patterns
  like `**/*.ts` stay literal.
- **Quotes, rules, and wrapped lists** — `>` quotes render dimmed with a gutter
  that survives wrapping, `---` draws a rule across the terminal, and a list
  item that wraps now indents its continuation under the text instead of
  falling back to column zero. Numbered lists get the same treatment as
  bullets, which they previously had none of.
- **No more stray space at the start of a wrapped line** — every block now
  wraps through kritya's own pass rather than Ink's, which carried the space it
  broke on to the front of the next line. It showed up on any paragraph long
  enough to wrap.
- **PDF tools work on Windows again** — the standard-font path passed to
  `pdfjs-dist` came from `fileURLToPath`, which returns backslash-separated
  paths on Windows; `pdfjs-dist`'s own reader does a literal `endsWith("/")`
  check that backslashes fail. Paths are now normalized to forward slashes.
- **Electron: Stop button no longer hangs** — pending `requestPermission`
  promises sat in a global map with nothing to settle them on kill or window
  teardown, so a tool call awaiting a permission decision hung forever if the
  user hit Stop or closed the window mid-prompt. They're now rejected as "no"
  on both paths. Closing a window also now engages the agent's kill switch
  before teardown (it previously only rejected pending prompts, leaving an
  in-flight call with no pending prompt free to keep running against a
  disposed session), and the process-wide background-process/LSP-server
  managers are only torn down once no window has an active session left, so
  closing or switching the provider of one window no longer kills background
  shells/LSP servers belonging to other open windows.
- **OTLP trace/span ids are hex, not base64** — verified against a real OTel
  Collector + Phoenix: base64-encoded ids were accepted (`200
partialSuccess`) but silently dropped before reaching Phoenix. OTLP JSON's
  `TraceId`/`SpanId` fields are the one carve-out from the general
  protobuf-JSON bytes-as-base64 rule.
- **`otlpSink` no longer throws out of `Span.end()`** — it was the only
  tracer sink without its own try/catch, so an encoding failure would
  propagate synchronously into the agent loop instead of degrading silently
  like the other sinks.

### Security

- **SSRF: redirect hops in `fetch_url` are re-validated** — a public URL
  could 302 to a private/metadata address and bypass the guard, since only
  the initial target was checked. The response body is also now truncated
  while streaming rather than fully buffered first, closing a memory-exhaustion
  path via a large or slow-lying response.
- **SSRF: DNS rebinding closed** — `fetch_url` and the MCP client's URL guard
  now re-validate the _resolved_ address (not just the literal hostname)
  before the initial request and after every redirect hop; the MCP guard
  also now rejects `https` URLs pointing at private/internal/metadata
  addresses, not just plain-`http` ones.
- **SSRF: IPv4-mapped/compatible IPv6 bypass fixed** — the private/loopback
  classifier matched IPv6 addresses by crude string-prefix checks, missing
  IPv4-mapped (`::ffff:169.254.169.254`), deprecated IPv4-compatible
  (`::10.0.0.1`), and non-canonical long-form (`0:0:0:0:0:0:0:1`) addresses —
  any of which could reach a private/loopback/metadata address through the
  `fetch_url` and MCP SSRF guards. Replaced with a real IPv6 parser that
  expands `::` compression and embedded IPv4 tails before classifying.
  Found by automated security review.
- **Electron IPC hardened**: `kritya:load-session`'s `filePath` is now
  validated against the session's own workspace directory (was an
  arbitrary-file-read via path traversal); `kritya:start`,
  `kritya:switch-model`, `kritya:switch-provider`, `kritya:prompt`, and
  `kritya:permission-response` now validate argument type/shape.
- **Secret-path scanner catches the prefixed form** — the shell-output
  secret scanner required a word boundary before phrases like
  `api_key`/`secret`/`password`, which skipped the common prefixed form
  (`OPENAI_API_KEY=`, `DB_PASSWORD=`) that `.env` files and `cat .env`
  actually produce.

## [0.5.0] — 2026-07-22

### Added

- **Per-tool time limits** — `ToolDef.execute` has always taken an abort
  signal, but only three of kritya's tools honored it, and the loop awaited the
  call without racing it. A tool that hung hung the whole turn, and neither Esc
  nor the kill switch could free it, since both work by aborting a signal
  nothing was listening to. Any tool call now has 120 seconds
  (`toolTimeoutSeconds` in config.json; 0 disables) before it's abandoned and
  reported to the model as a failure it shouldn't blindly retry. Tools that
  enforce their own deadline — `shell`, subagents, MCP calls — opt out via
  `ToolDef.timeoutMs = 0` and keep theirs. This rescues asynchronous hangs
  only: a tool spinning the CPU synchronously blocks the event loop, so the
  timer cannot fire, and abandoning is not cancelling — a tool that ignores its
  signal keeps running in the background.
- **A crash no longer takes the terminal and the session with it** — an
  unhandled rejection anywhere terminated the process without firing `"exit"`,
  which is where every cleanup path hangs off: background dev servers, MCP
  stdio children, and LSP servers all outlived the session, and Ink left the
  terminal in raw mode with the cursor hidden, so the shell underneath was
  unusable until the user blind-typed `reset`. kritya now catches
  `uncaughtException` and `unhandledRejection` in both interactive and headless
  mode, shuts those children down, restores the terminal, and prints the
  transcript path with the `-c` command to resume.
- **Stream idle timeout** — a provider that accepted the connection and then
  went quiet left the turn hanging indefinitely with a live spinner: the
  request had succeeded, nothing threw, and the retry loop was never reached.
  Requests now carry a whole-call ceiling, and the gap between streamed chunks
  is bounded separately at 60 seconds — the two catch different failures, since
  an overall timer tight enough to notice a stall would cut off legitimate long
  answers. A stall aborts the dead stream and retries.

- **MCP prompts and resources** — kritya implemented one of the protocol's
  three server primitives. A server's prompts now appear as slash commands
  named `/<server>-<prompt>`, with argument hints and autocomplete, so a Linear
  server can contribute `/linear-triage` without the user writing a command
  file; they are matched after built-ins and user command files, so a server
  cannot redefine `/plan`. A server's resources appear as `@mcp:<server>/<name>`
  attachments alongside file mentions. Both are labelled as external content
  when handed to the model, since a server authored them. Neither is requested
  from a server that doesn't advertise the capability.
- **`roots/list`** — kritya advertised no client capabilities and dropped every
  server-to-client request on the floor, so a filesystem-style server had no way
  to learn where the workspace was and fell back to whatever its own config
  guessed. kritya now declares the `roots` capability and answers with the
  workspace. Other server requests get a proper "method not found" error rather
  than silence, so a server can tell an unsupported client from a hung one.
- **Per-server tool allow/deny** — a server's entire tool list was exposed
  unconditionally, and every exposed tool's schema is sent on every request, so
  a 100-tool server cost tokens each turn and buried the handful of tools that
  mattered. `"tools": { "allow": [...], "deny": [...] }` on a server entry now
  limits what's exposed, matched against the server's own tool names with `*`
  wildcards; `deny` wins over `allow`, and an absent `allow` means everything.
  `/mcp` reports how many tools a server's config held back. The filter is part
  of the trust fingerprint, so relaxing `allow` from `["search"]` to `["*"]`
  re-asks rather than inheriting the earlier approval.
- **`/mcp trust` and `/mcp trust revoke <name>`** — the per-server allowlist
  could only ever be appended to. Since approval is matched by config
  fingerprint across every workspace, an entry for a server you'd stopped using
  silently re-approved it the next time any repo declared the same config, and
  the only way out was hand-editing the store. Approvals can now be listed and
  withdrawn. `/mcp remove` also withdraws the approval of the server it
  removes, and its message for a project-declared server now points at
  `/mcp trust revoke`, which is the only way to stop one loading without
  editing the repo.
- **MCP tool annotations are honored** — every MCP tool was hardcoded as
  requiring approval, which prompted on pure lookups (a docs fetch, an issue
  search); approval fatigue is what trains people to accept without reading, so
  the blanket prompt made the prompts that matter less effective. It also had a
  consequence nothing surfaced: subagents are only handed tools that don't
  prompt, so no MCP tool was ever available to any subagent. Tools a server
  marks `readOnlyHint` (and not `destructiveHint`) now run without a prompt and
  reach subagents. Their output is still wrapped as untrusted content.
- **`cwd` for stdio MCP servers** — a server was launched in whichever
  directory kritya was started from, so a filesystem-style server configured
  with a relative root (`server-filesystem .`) scoped itself to the home
  directory under `cd ~ && kritya ~/projects/app` instead of the project.
  Servers now default to the workspace root, and `cwd` overrides that (resolved
  against the workspace, so a checked-in `.mcp.json` stays portable). `cwd` is
  part of the per-server trust fingerprint: widening a server's directory
  re-asks for approval instead of inheriting the old one.

- **OAuth 2.1 for remote MCP servers** — HTTP servers previously got only the
  static `headers` from config, which meant every hosted MCP server (Linear,
  Notion, Sentry, GitHub, Atlassian) was unreachable, since they all require
  OAuth with dynamic client registration and PKCE. kritya now implements the
  full flow: a `401` is parsed for its `WWW-Authenticate` challenge, the
  protected-resource (RFC 9728) and authorization-server (RFC 8414) metadata are
  discovered, the client registers itself dynamically (RFC 7591) as a public
  client, and the user approves in a browser via authorization-code + PKCE
  (RFC 7636) with the redirect captured by a one-shot loopback listener on
  `127.0.0.1` (RFC 8252). Tokens are bound to the server with `resource`
  (RFC 8707) and stored in `~/.kritya/mcp-auth.json` at `0600` with the same
  Windows-ACL hardening as the rest of `~/.kritya`; expired access tokens
  refresh on `401` and the request is retried, with concurrent refreshes
  serialized so a burst of parallel connects can't invalidate each other's
  grant. A server needing a login is reported as `needsAuth` rather than as a
  failure, and no browser ever opens during startup.

- **`/mcp` subcommands** — `/mcp add <name> <url>` (or `-- <command…>` for
  stdio), `/mcp remove <name>`, `/mcp login <name>`, `/mcp logout <name>`, and
  `/mcp code <name> <code>` for headless/SSH sessions where the loopback
  redirect can't be reached. Adding, removing, or logging in attaches and
  withdraws that server's tools in the running session — no restart. `/mcp add`
  refuses plain-HTTP URLs (localhost excepted). `/mcp logout` reports revocation
  and local deletion separately, so a server without a revocation endpoint is
  never described as fully signed out. Bare `/mcp` remains available while the
  kill switch is engaged; its mutating subcommands do not.

- **Project-declared servers confirm before an account login** — a server from
  the workspace's `.mcp.json` was written by whoever wrote the repo, so
  `/mcp login` on one requires an explicit `--yes` before it can open a consent
  screen against the user's real account. Servers in the user's own
  `~/.kritya/config.json` sign in without the extra step. This is narrower than,
  and additional to, the existing per-server trust gate.

- **Kill switch** — `Ctrl+K` (or `/kill [reason]`) is a session-wide emergency
  stop. It aborts the in-flight model stream, any running tool, and every
  subagent, then refuses all further work — new turns, tool calls, compaction,
  and agent-driving slash commands — until `/kill off` releases it. Enforcement
  lives in the agent loop rather than the UI, gated ahead of plan mode, deny
  rules, allow rules, and accept-edits, so no mode or rule can let a tool
  through while it's engaged; a single shared switch covers subagents, which
  run as separate agents. Engaging and releasing it are recorded in the audit
  log, and blocked tool calls appear there with the new `kill-switch`
  permission source. Session-only: a restart comes up in the normal state.

- **Audit log + OpenTelemetry tracing (local-only)** — every permission
  decision and tool execution is now recorded to an append-only, tamper-evident
  audit trail under `~/.kritya/audit/<session>.audit.jsonl`, separate from the
  session transcript: each entry captures the tool, a one-line summary, the
  verdict (allowed/denied), its source (deny-rule, allow-rule, always-allow,
  accept-edits, interactive, plan-mode, or read-only), and the execution
  outcome and duration. Entries are hash-chained, so editing or deleting any
  line is detectable (`AuditLog.verify`). Auditing is on by default; set
  `KRITYA_AUDIT=off` to disable it. Additionally, the tool loop can emit
  OpenTelemetry-shaped spans (one per turn, one per tool call, nested) for local
  inspection — set `KRITYA_OTEL=file` (default path
  `~/.kritya/telemetry/<session>.otel.jsonl`), `console`, or `both`; override
  the path with `KRITYA_OTEL_FILE`. Both are fully local — no external service,
  collector, or network is involved. Spans use OTel field names so a real OTLP
  exporter can be added later without changing the loop.
- **Staged new-project workflow** — creating a new project now runs through
  four phases, each producing a durable artifact under `docs/<name>/` and
  hard-stopping for your approval before the next: **brainstorm**
  (`docs/<name>/brainstorm.md`), **plan** (`docs/<name>/plan.md`), **spec**
  (`docs/<name>/spec.md`), then **build** (the code). The agent drives this
  automatically when you ask it to build something new — it tracks the current
  phase in `.kritya/project.json` and resumes there across sessions — but you
  can also step through it by hand with the new `/brainstorm <idea>`, `/spec`,
  and `/build` commands. The plan phase reuses plan mode: `/plan` on an active
  project designs the architecture read-only, with a narrow exception that lets
  it write Markdown planning docs under `docs/` while application code and shell
  stay blocked.
- **Checkpoint / rewind** — `/checkpoint <name>` saves a named point in the
  session (run `/checkpoint` with no name to list saved ones), and
  `/rewind <name>` rolls both the conversation and the files back to that
  point together. Where `/undo` steps back file changes one turn at a time,
  `/rewind` restores the transcript and the working tree to a chosen moment in
  one step. Checkpoints are in-memory for the current session; rewinding files
  reuses the existing undo stack, so each reverted turn stays individually
  redoable.

### Fixed

- **`/undo` no longer deletes a file instead of restoring it** — the undo
  stack learned what kritya had written only from a file-watcher event, which
  assumed every write produces one. macOS coalesces FSEvents and can drop the
  event for a write landing just after the watch is registered; when the event
  for kritya's own write went missing, the baseline stayed at "this file did
  not exist", so a later hand-edit was checkpointed against that null and
  undoing it removed the user's file. kritya now re-reads the file itself once
  its own write settles rather than waiting to be told. Caught by the macOS CI
  runner.
- **Writes can no longer leave a file cut in half** — `fs.writeFile` truncates
  the target before filling it back in, so a crash, the kill switch, a full
  disk, or a power cut in that window destroyed the file, with the original
  surviving only in the memory of the process that just died. Every write now
  goes to a sibling temp file that is renamed over the target, which is a
  single filesystem operation: readers see the whole old file or the whole new
  one. Symlinks are still followed rather than replaced, the original's
  permissions are preserved (a renamed-in file would otherwise silently lose a
  script's executable bit), and on Windows a rename blocked by another process
  holding the file open falls back to writing in place rather than failing.
  Applied to `write_file`, `edit_file`, notebooks, documents, LSP renames, and
  `/undo`'s own restore; the session store's private copy of this logic was
  replaced by the shared one. There is deliberately no `fsync`: the hazard
  closed here is truncation, not power loss.
- **Compaction failure no longer destroys the turn** — summarizing older
  history is reached almost exclusively when things are already going badly, so
  the summarization call failing aborted the turn at exactly the point the user
  most needed it to survive. A failure now degrades to a mechanical record of
  the dropped span — which files were touched, which commands ran — labelled as
  not being a summary so the model doesn't trust it as one. Cancellation still
  propagates.
- **A prompt too large for the context window is recovered, not fatal** —
  auto-compaction fired on the prompt size a provider _reported_, always one
  request behind, so a single large tool result could push the next request
  past the window; the resulting error is a hard 400 that no retry fixes.
  kritya now estimates the request before sending and compacts pre-emptively,
  and a context-overflow rejection is caught, compacted, and re-sent once. The
  token estimate that drives the context meter on providers that don't report
  usage was also replaced: it now accounts for tool-call payloads and charges
  an attached image a flat cost instead of counting its base64 data URL, which
  made one small image look like 150,000 tokens.
- **More network failures are retried, and `Retry-After` is honored** — the
  retry classifier recognized four errno codes, missing undici's `UND_ERR_*`
  family (what Node's own fetch reports on flaky connections),
  `ERR_STREAM_PREMATURE_CLOSE`, `ECONNREFUSED`, `EPIPE`, causes nested one
  level down, the SDK's own connection-error classes, and HTTP 408. Backoff
  also ignored the provider's `Retry-After`, so kritya could wait less than a
  rate limiter asked and spend the next attempt against the same closed window
  — which is how a four-attempt budget evaporates in two seconds on a free
  tier.
- **`web_search` had no timeout** — the Tavily call was a bare `fetch` with no
  signal, so a socket that never answered hung the tool indefinitely. It is now
  bounded at 30 seconds, which is needed independently of the per-tool limit
  above because `/web-search` calls it outside the agent loop.
- **Non-text tool results are no longer discarded** — every content block that
  wasn't plain text became the literal string `[image content]`, throwing away
  three things that carry real payload today. `structuredContent` (the
  machine-readable result, spec 2025-06-18) is now used when a tool returns no
  text blocks; resources the server embedded in the response are inlined
  instead of dropped; `resource_link` blocks name their target; and images and
  audio become placeholders that state their media type and size rather than a
  bare `[image content]`. A text block still wins over `structuredContent`,
  since servers that provide both send the same data twice.
- **The new-MCP-server prompt is per server** — it approved every pending
  server declared by a workspace as one batch, so a branch adding a good server
  and a hostile one offered only "both" or "neither" — and someone who wanted
  the good one took both. Each server is now presented and decided on its own,
  with a marker on remote endpoints, since those send requests and any token
  you hold off the machine.

- **MCP redirects no longer carry credentials off-origin** — HTTP requests used
  `fetch`'s default redirect handling, which re-sends every header, including
  `Authorization`, to whatever `Location` names. A compromised server, or anyone
  able to rewrite a plaintext hop, could point that at their own origin and
  collect the token. Redirects are now handled explicitly and refused when they
  leave the origin.
- **The `https://` requirement covers all three config sources** — `/mcp add`
  refused plaintext remote servers, but a server hand-written into
  `~/.kritya/config.json` or a repo's `.mcp.json` bypassed that check entirely
  and would POST a bearer token in the clear. The check now runs where every
  source converges, at connect time. Loopback stays exempt.
- **MCP tool names can no longer collide or overflow** — name sanitizing is
  lossy, so `my.tool` and `my-tool` both became `mcp_<server>_my_tool` and one
  silently shadowed the other. Separately, OpenAI-compatible endpoints cap
  function names at 64 characters and reject the _entire_ request when any name
  exceeds it, which presented as an inexplicable model failure rather than an
  MCP one. Colliding and over-long names now get a deterministic hash suffix.

- **Cross-platform CI verification**: CI now runs the full test suite on
  Windows and macOS runners (in addition to Ubuntu 18.x/20.x/22.x), not just
  Linux, so the "works on Windows and macOS" claim is actually checked rather
  than assumed. This surfaced two real bugs the expanded matrix caught:
  - `npm test` passed a glob (`dist/test/*.test.js`) to `node --test`. Node's
    own CLI glob matching only exists on Node 22+, so on Node 18/20 (used by
    macOS/Windows in CI and still within `engines.node`) it was treated as a
    literal, nonexistent path and failed outright. Fixed with
    `scripts/run-tests.mjs`, which enumerates compiled test files with
    `fs.readdirSync` and passes them to `node --test` as explicit paths —
    verified against Node 18, 20, and 22.
  - `prettier --check .` flagged nearly every file on Windows, because
    GitHub's Windows runners check out git text files as CRLF by default,
    which Prettier (LF) then sees as unformatted. Fixed by adding
    `.gitattributes` (`* text=auto eol=lf`) so checkout normalizes to LF on
    every OS.
  - Background processes (`shell` tool with `background: true`) failed to
    start on Windows: `background.ts` manually built a `cmd /c` argument
    array, and Node's array-based quoting for `cmd.exe` mis-parses commands
    that themselves contain quotes (e.g. `node -e "..."`). Fixed by spawning
    with `shell: true` and the full command as one string — the same
    pattern the regular `shell` tool already uses via `exec()` — so Node
    picks correct per-OS shell quoting instead of us reimplementing it.

### Added

- **Repo map** (`repo_map` tool): a cheap, whole-repository structural
  skeleton — source files ranked by importance, each with its class/function/
  type signatures but no bodies — so the agent can orient itself in an
  unfamiliar or large codebase without reading files just to discover where
  things live. Symbol extraction is regex/heuristic-based (no language server
  to spawn, no native parser dependency, runs in one pass), covering the
  mainstream languages (TS/JS, Python, Go, Rust, Java, Kotlin, C#, C/C++, Ruby,
  PHP, Swift, Scala); files in unsupported languages are simply omitted rather
  than producing noise. Output is bounded (files scanned, symbols per file, and
  total length are all capped) so it never blows up on a huge monorepo, and it
  honors `.krityaignore`. Read-only, so subagents get it too. This is the
  low-cost half of semantic codebase navigation — no embeddings, no index to
  keep in sync, no code leaving the machine.

- **Mid-session provider failover**: a new `/provider` command lists every
  configured provider and lets you switch (`/provider openai`) without losing
  the conversation — only the underlying HTTP client is swapped, history and
  undo state are untouched. When a request exhausts its retries (429/5xx with
  exponential backoff, already automatic), kritya now surfaces this as a
  distinct error and suggests a configured fallback provider; headless mode
  does the same via `--provider`.

- **Session crash-safety**: the task-checklist sidecar and a resumed
  session's seed file are now written atomically (tmp-file + rename), so a
  crash mid-write can't corrupt them. Append-per-turn session files already
  degrade gracefully (a truncated last line is skipped, not the whole
  session) — now documented and covered by tests.

- **Prompt-caching awareness**: the system prompt is reordered for cache
  stability — stable content first (identity, tool rules, style), then
  project memory (KRITYA.md), with volatile sections (environment, workspace
  listing, git status, plan mode) last, so a changed git status no longer
  invalidates the provider's cached prefix for the whole prompt. The provider
  client now reads `prompt_tokens_details.cached_tokens`; `/cost` reports
  cached tokens and hit rate per model, the statusline shows the session
  cache-hit percentage, and headless `--output json` includes
  `usage.cachedPromptTokens`. An optional `pricing.<model>.cachedInput` rate
  (USD/1M) prices cache hits at the discounted rate and reports the savings.

- **LSP integration**: three new read-only tools — `lsp_definition`,
  `lsp_references`, and `lsp_diagnostics` — give the agent semantic code
  navigation and type-error feedback from real language servers
  (TypeScript/JavaScript via `typescript-language-server`, Python via
  `pyright`, Go via `gopls`, Rust via `rust-analyzer`, C/C++ via `clangd`).
  The client is a dependency-free JSON-RPC-over-stdio implementation; servers
  are detected per file type, spawned on first use, kept warm across turns,
  respawned if they crash, and reported with an install hint when missing.
  Queries wait for the server's initial project indexing (via
  `workDoneProgress`) so cross-file results are never silently incomplete.

## [0.4.0] — 2026-07-17

### Security

- **Workspace trust gate**: a cloned repo's `.kritya/settings.json` could
  otherwise self-grant allow rules or run hooks the moment `kritya .`
  launches there. Workspace-level allow rules and hooks now require explicit
  trust (prompted on first launch, hash-pinned in `~/.kritya/trusted.json`)
  before taking effect; deny rules and the global `~/.kritya/settings.json`
  are unaffected.
- **Sandbox escape via symlinks fixed**: `resolveSafe` now resolves symlinks
  (and the nearest existing ancestor, for not-yet-created files) before
  checking containment, closing a path where a symlink inside the workspace
  pointing outside it let `edit_file`/`write_file`/`read_file` escape the
  sandbox.
- **Secret-path denylist**: reads and writes of likely-secret paths
  (`.env*`, `.git/config`, `*credentials*`, `*secret*`, private keys) are now
  blocked inside `resolveSafe`, regardless of allowlist rules, closing a gap
  where a prompt-injected agent could read `.env` and exfiltrate it via shell
  or web search.
- **Destructive-command detection hardened**: `classifyDanger` now also
  catches long-form flags (`rm --recursive --force`, `git clean --force`,
  `chmod --recursive 777`, `chown --recursive`), not just short-form
  clusters like `-rf`. Documented in `SECURITY.md` that this remains a
  regex-based backstop, not a hard guarantee — `$(...)`/`eval`/base64
  obfuscation can still evade it.

### Added

- **`.krityaignore`**: gitignore-style patterns in the workspace root are now
  honored by `glob`, `grep`, and the `@`-file-mention list, in addition to the
  hardcoded `node_modules`/`.git` exclusion.
- **Diff-aware shell permission prompts**: the `shell` tool now previews a
  `git diff --stat` (plus the capped diff) before permission is granted for
  commands that mutate git state (`checkout`, `reset`, `commit`, `merge`,
  `rebase`, `stash`, `clean`, `rm`, `mv`, `restore`, `add`, etc.), matching
  the diff preview already shown for file edits.
- **GitHub Actions CI**: build, lint, format:check, and test now run on
  Node 18.x/20.x for every pull request targeting `main`.

### Changed

- Auto-compaction no longer stalls at 0% context usage when a provider omits
  usage stats on streamed responses; falls back to a size-based token
  estimate. Reasoning deltas are now read from both `reasoning_content`
  (NVIDIA/DeepSeek) and `reasoning` (OpenRouter and others). Sampling params
  (`temperature`, `top_p`, `max_tokens`) are now overridable — or omittable
  via `null` — per provider in config, instead of hardcoded.
- The version string is now read from `package.json` at runtime instead of
  being hardcoded separately in the CLI banner and the MCP client handshake.
- `listSessions` no longer JSON-parses every message in a transcript just to
  build a resume preview; it stops at the first real user message and counts
  lines cheaply instead.
- Fixed `web_search`'s `max_results: 0` being silently treated as "omitted"
  and defaulting to 5.
- Internal: slash-command dispatch extracted from `App.tsx` into a typed
  command registry (`src/commands/registry.ts`), and agent-turn state
  (transcript, streaming, permissions, cost, resume) extracted into a
  `useAgent` hook, so both are unit-testable independent of the UI.
- Internal: added test coverage for `ProviderClient.chatOnce`'s streaming
  tool-call assembly (multi-chunk arguments, out-of-order chunk indices,
  usage presence), fixed pre-existing prettier violations, made the test
  runner's file glob shell-expanded for Node 18.x CI compatibility, and
  added a `test:watch` script (via `tsx`, no compile step) for faster local
  iteration.

### Removed

- Dropped legacy compatibility shims kept during the code-cli → kritya
  rename: the `NvidiaClient` export alias, the `CODECLI.md` project-memory
  fallback (use `KRITYA.md`), and the `~/.code-cli/config.json` legacy config
  path (use `~/.kritya/config.json`).
- Removed dead code (`resolveApiKey`, `loadAllowRules`) superseded by
  `resolveProvider` and `loadRules`.

## [0.3.0] — 2026-07-17

### Added

- **Multi-provider support.** Any OpenAI-compatible endpoint works: NVIDIA
  (default), OpenAI, OpenRouter, Groq, DeepSeek, Mistral, Together, and Ollama
  are built in. Select with `--provider` or `provider` in config; add your own
  under `providers`.
- **Plan mode** (`/plan`): a read-only mode where the agent investigates and
  proposes a plan; writes, edits, and shell are blocked until you turn it off.
- **Subagents** (`spawn_agent` tool): dispatch a focused, read-only
  investigation to a fresh context that returns only its findings, keeping the
  main conversation lean.
- **Hooks**: user-defined shell commands that run on `preToolUse` (can block),
  `postToolUse`, and `stop` events, configured in `settings.json`.
- **MCP client**: launch Model Context Protocol servers over stdio and expose
  their tools to the agent (`mcpServers` in config).
- **Custom slash commands**: drop a markdown file in `.kritya/commands/` and it
  becomes a `/command`.
- **Redo** (`/redo`) to reapply an undone change; undo is now multi-level.
- **Image attachments**: `@screenshot.png` sends an image to vision-capable
  models.
- **`/diff`** shows the cumulative git diff of the session's changes.
- **Deny rules** and path-glob rules in `settings.json` (e.g.
  `deny: ["write_file(.env*)"]`); deny always wins over allow.
- **Destructive-command guard**: commands like `rm -rf`, `git push --force`,
  and `curl | sh` always prompt with a warning, even when allowlisted.
- **Input history** (↑/↓), a **verbose output toggle** (Ctrl+O), an
  **elapsed-time** and **plan-mode** indicator in the status line, and a
  **terminal bell** when input is needed or a turn finishes.
- **Word-level diff highlighting** in the permission preview.

### Changed

- Retries on transient provider errors (429/5xx) now use exponential backoff
  with a visible status note.
- `edit_file` falls back to whitespace-tolerant line matching when an exact
  match isn't found, reducing failed edits from weaker models.
- Auto-compaction uses the model's real context window from a registry.
- The per-request step limit is configurable (`maxSteps`) and stops gracefully.
- The provider client is now provider-agnostic (`ProviderClient`).

## [0.2.0]

- Initial public feature set: streaming tool-call loop, permissions with
  allowlists, sessions and resume, auto-compaction, `/undo`, background
  processes, git awareness, `@`-mentions, project memory, web search.
