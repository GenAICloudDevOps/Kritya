# Contributing to kritya

> ⚠️ **Beta project** — APIs, flags, and internals may still change between
> releases. Expect some churn, and check for open issues/discussion before
> starting larger changes.

Thanks for your interest in improving kritya! This is a lean terminal coding
agent, and contributions that keep it lean and dependency-light are especially
welcome.

## Getting started

```bash
git clone <your-fork>
cd kritya
npm install
npm run build
npm test
npm run dev        # run from source against a scratch project
```

Requires Node >=22.19.0 (undici 8 needs it). CI runs 22.x and 24.x on
Ubuntu, plus 22.x on Windows and macOS.

You'll need a provider API key (see the README) — get one at
[build.nvidia.com](https://build.nvidia.com).

## Development workflow

- **Write tests.** New behavior in `src/tools`, `src/permissions`, `src/agent`,
  `src/undo`, and helpers should come with a `node:test` case under `src/test`.
- **Keep the build green:** `npm run build` (strict TypeScript) and `npm test`
  must pass. `npm run lint` and `npm run format:check` should be clean.
- **Match the surrounding style.** Small, focused modules; comments explain
  _why_, not _what_.
- **Avoid new dependencies** unless there's a clear, load-bearing reason. Part
  of kritya's value is a small install footprint.

### Why are there two TypeScript packages?

`@typescript/native` is the real TypeScript 7 compiler that builds this
project, while the package named `typescript` is secretly TypeScript 6
(`npm:@typescript/typescript6`) — kept because `typescript-eslint` still
needs the older compiler API, and Microsoft recommends this side-by-side
arrangement until TypeScript 7 has a stable programmatic API. It looks like
a mistake, but "cleaning it up" breaks the build or lint, so don't touch
these two entries: a plain `"typescript": "^7.x"` breaks eslint, and a plain
`"^6.x"` breaks the build. Dependabot is configured to skip major bumps of
both, but review any PR that touches them by hand rather than merging it
blind. `npm run check:typescript-setup` (also run in CI) fails loudly if the
aliases ever get mixed up.

## Project layout

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for a tour of the codebase.

## Commit and PR guidelines

- Use clear, conventional-style commit messages (`feat:`, `fix:`, `docs:`, …).
- Describe user-facing changes in the PR. Don't edit `CHANGELOG.md` yourself —
  entries are written in a single `chore(release): bump version …` commit at
  release time, so the file only ever lists shipped versions.
- One logical change per PR where practical.
- Before opening a PR, run the full check suite locally — this mirrors what
  CI runs:

  ```bash
  npm ci && npm run check:audit && npm run format:check && npm run lint && npm run check:install-scripts && npm run check:typescript-setup && npm run test:coverage && npm run build && npm run check:package && npm run check:smoke
  ```

  The last two inspect and then run the **packed tarball** rather than the repo
  tree — they are what catch a broken `files` field or a missing entry point
  before a user does. Both need a working `npm`, so they can't run over a WSL
  UNC mount; run them from inside WSL (or let CI run them) if that's how you
  have the repo open. They also run automatically via `prepublishOnly` on any
  `npm publish`, so a hand-cut release is gated the same way CI's is.

- **Something wrong locally?** `npm run build && node dist/index.js doctor`
  diagnoses the installation: Node version against `engines`, config file
  validity, the active provider and whether its key resolves _and_ the endpoint
  accepts it, workspace trust, MCP servers, sandbox availability, and
  persistence settings. Add `--json` to get the same thing machine-readable,
  or `--offline` to skip the network probes.

## Reporting bugs and requesting features

Use the GitHub issue templates. For security issues, please **do not** open a
public issue — see [SECURITY.md](SECURITY.md).

## Code of conduct

By participating you agree to abide by our
[Code of Conduct](CODE_OF_CONDUCT.md).
