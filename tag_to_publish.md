# Tag & publish workflow

How a version bump goes from a local commit to a live npm release, and
what stays a manual step by design.

## 1. Commit the version bump

```bash
git add package.json package-lock.json CHANGELOG.md
git commit -m "build: bump to v<version>"
```

Bump `package.json` + `package-lock.json` version fields and add a
`## [<version>] — <date>` section to `CHANGELOG.md` before committing.

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

**Example (0.8.13-beta):**

```bash
git tag v0.8.13-beta
git push origin v0.8.13-beta
```

## What the tag push triggers (`.github/workflows/publish.yml`)

1. Checks out, builds, and runs the full test suite (`npm run build && npm test`).
2. Publishes to npm as **`npm publish --provenance --tag beta`** —
   always the `beta` dist-tag, never `latest`, and always with signed
   provenance attestation.
3. Publishing uses OIDC trusted publishing (`id-token: write`) — no
   `NPM_TOKEN` secret anywhere in the workflow. npm exchanges the job's
   OIDC identity for a short-lived publish credential itself.
4. Extracts that version's section out of `CHANGELOG.md` and creates a
   **GitHub prerelease** (`gh release create ... --prerelease`) using it
   as the release notes.

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

**Example (0.8.13-beta):**

```bash
npm dist-tag add kritya@0.8.13-beta latest
```

Verify both tags landed:

```bash
npm view kritya dist-tags
```
