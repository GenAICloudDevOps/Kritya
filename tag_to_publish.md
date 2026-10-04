# Tag & publish workflow

How a version bump goes from a local commit to a live npm release, and
what stays a manual step by design.

## 1. Commit the version bump

Exactly three files change, and only these three:

- `package.json` — the `version` field.
- `package-lock.json` — the `version` field at the top level _and_ the one
  under `packages[""]`. Both, or the lock drifts: `npm ci` does not check
  the root version field, so nothing in CI will catch a miss.
- `CHANGELOG.md` — a new `## [<version>] — <date>` section at the top, above
  the previous release. This section becomes the GitHub release notes, so it
  must be non-empty, and the heading must match the tag exactly (minus the
  leading `v`) or the release is created with empty notes.

```bash
git add package.json package-lock.json CHANGELOG.md
git commit -m "chore(release): bump version to <version>, update changelog"
```

Before tagging, run the same pre-flight the publish job runs first. It checks
all three files at once — the tag against `package.json`, both lock version
fields, and that the CHANGELOG section exists and is non-empty:

```bash
node scripts/check-release.mjs v<version>
```

That script is the whole reason those checks can't silently drift: `publish.yml`
publishes whatever `package.json` says, under whatever tag you pushed, and
would otherwise never compare the two.

## 2. Push the commit to main

```bash
git push origin main
```

This alone does **not** publish anything — `publish.yml` only triggers
on a tag push, never on a plain commit (see workflow comment at the top
of `.github/workflows/publish.yml`).

## 3. Tag and push the tag

```bash
git tag v<version>
git push origin v<version>
```

Pushing a tag matching `v*` is what fires the `Publish` workflow. This
is the deliberate "release this" action — everything past this point is
automatic.

**Example (0.8.27-beta):**

```bash
git tag v0.8.27-beta
git push origin v0.8.27-beta
```

## What the tag push triggers (`.github/workflows/publish.yml`)

1. `npm run check:release` — before anything expensive. A tag that disagrees
   with `package.json`, a stale lock, or a missing/empty CHANGELOG section
   each produce a _green_ workflow with a wrong or blank result, so they are
   caught in the first seconds rather than after the build and test run.
2. Checks out, builds, and runs the full test suite (`npm run build && npm test`).
3. Upgrades npm to `^11.5.1` (OIDC trusted publishing needs it).
4. Publishes to npm as **`npm publish --provenance --tag beta`** —
   always the `beta` dist-tag, never `latest`, and always with signed
   provenance attestation. This step also runs `prepublishOnly`, which chains
   `check:package` and `check:smoke` — the tarball is packed, inspected, and
   installed into a temp directory before it goes out. They live in
   `prepublishOnly` rather than as their own steps here so that a `npm publish`
   run by hand from a laptop is gated the same way.
5. Verifies the version is actually readable back from the registry
   (`https://registry.npmjs.org/kritya/<version>`, polled for up to 60s).
   `npm publish` exiting 0 only means the upload was accepted — propagation is
   not instant, and a delay looks identical to a failed release from the
   outside. This step is what turns that ambiguity into a red or green run.
6. Extracts that version's section out of `CHANGELOG.md` and creates a
   **GitHub prerelease** (`gh release create ... --prerelease`) using it
   as the release notes.

Publishing uses OIDC trusted publishing (`id-token: write`) — no
`NPM_TOKEN` secret anywhere in the workflow. npm exchanges the job's
OIDC identity for a short-lived publish credential itself.

Note that `ci.yml` does **not** run on tags — it triggers on pushes to `main`
and on pull requests only. So the tag's only gates are the steps above; lint,
format, `npm audit`, the `package` job, and the coverage threshold all ran
earlier on the `main` push and are not re-checked here.

There is also no stable-release path. `--tag beta` and `--prerelease` are
hardcoded in the workflow, so every tag published this way is a beta.

## Watch the run live

```bash
gh run watch
```

Prompts you to pick a run if more than one is in flight (e.g. `ci.yml`
firing on the same push). To target one directly:

```bash
gh run list --limit 5
gh run watch <run-id> --exit-status
```

## 4. Manually point `latest` at the new version

Not automated on purpose. OIDC trusted publishing only covers the
`npm publish` call itself — a follow-up `npm dist-tag add` would need a
long-lived `NPM_TOKEN`, and that credential risk isn't worth it while
still in beta. So `latest` only moves when you decide it should:

```bash
npm dist-tag add kritya@<version> latest
```

**Example (0.8.27-beta):**

```bash
npm dist-tag add kritya@0.8.27-beta latest
```

Verify both tags landed:

```bash
npm view kritya dist-tags
```
