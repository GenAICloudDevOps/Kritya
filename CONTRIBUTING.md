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

Requires Node >=22. CI runs both 22.x and 24.x on Ubuntu.

You'll need a provider API key (see the README). For most work, the tier
at [build.nvidia.com](https://build.nvidia.com) is enough.

## Development workflow

- **Write tests.** New behavior in `src/tools`, `src/permissions`, `src/agent`,
  `src/undo`, and helpers should come with a `node:test` case under `src/test`.
- **Keep the build green:** `npm run build` (strict TypeScript) and `npm test`
  must pass. `npm run lint` and `npm run format:check` should be clean.
- **Match the surrounding style.** Small, focused modules; comments explain
  _why_, not _what_.
- **Avoid new dependencies** unless there's a clear, load-bearing reason. Part
  of kritya's value is a small install footprint.
- **macOS sandbox changes need manual testing.** CI only runs on Ubuntu, so
  `src/shell/sandbox.ts`'s `sandbox-exec` (macOS) path has no automated
  coverage — test changes there by hand on macOS, or re-enable the macOS CI
  leg for that PR.

## Project layout

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for a tour of the codebase.

## Commit and PR guidelines

- Use clear, conventional-style commit messages (`feat:`, `fix:`, `docs:`, …).
- Describe user-facing changes in the PR and add a `CHANGELOG.md` entry under
  "Unreleased".
- One logical change per PR where practical.

## Reporting bugs and requesting features

Use the GitHub issue templates. For security issues, please **do not** open a
public issue — see [SECURITY.md](SECURITY.md).

## Code of conduct

By participating you agree to abide by our
[Code of Conduct](CODE_OF_CONDUCT.md).
