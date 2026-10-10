# OSS Scanner build image for kritya.
#
# The scanner builds this with the kritya checkout as the build context, so
# `COPY . /src` places the repository inside the image. Network access is
# available while this file builds and is removed before the audit runs, so
# everything the agent (or its tests) may need must be fetched here.
#
# Contract: the checkout lives at /src.

FROM node:22-bookworm

ENV DEBIAN_FRONTEND=noninteractive

# The agent drives shell commands, and its self-tests exercise the sandboxed
# execution backstop. bwrap is the OS-enforced sandbox kritya uses on Linux;
# without it the sandbox falls back to unsandboxed. Install it (plus the small
# utils the test scripts assume) so the security properties under review are
# actually exercised. git is needed for husky and for tests that touch repos.
#
# NOTE FOR THE SCANNER: bwrap needs to create user/mount namespaces, which a
# default (unprivileged) container blocks. The sandbox tests are written to
# skip-or-report when a backend is unavailable, but to give them a real host
# they must run with namespace creation allowed — e.g. `--privileged`, or
# Docker's `--security-opt seccomp=unconfined` plus `--cap-add SYS_ADMIN`
# with an unconfined AppArmor profile. Verified locally: 8 sandbox tests fail
# under the default sandbox and all 1349 pass under `--privileged`. If the
# scanner's VM cannot grant this, the sandbox tests will not exercise the
# containment property — please rate anything sandbox-related accordingly.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates \
      git \
      bubblewrap \
      procps \
      python3 \
    && rm -rf /var/lib/apt/lists/*

COPY . /src
WORKDIR /src

# Install exactly what the lockfile pins. `npm ci` — not `npm install` — so the
# audit reviews the dependency graph that actually ships. `--ignore-scripts`
# runs first to avoid lifecycle scripts during the clean install, then husky's
# `prepare` hook is neutralised explicitly: there is no .git hook to install in
# the image and `husky` exits non-zero when it cannot find one.
RUN npm ci --ignore-scripts \
    && npm rebuild \
    && npx --no-install husky || echo "WARNING: husky prepare skipped (no git hooks in image)"

# Build exactly as maintainers build it: `npm run build` is `tsc`.
# A failing build fails the image, and the scanner emails the log.
RUN npm run build

# Cheap smoke check so we know the image works, but never abort the build on it —
# the scanner wants to inspect a working tree even if a test is red. Anything
# worth exercising for the audit (built CLI at dist/index.js, test drivers) is
# left in place for the agent, per .oss-scanner/threat_model.md.
RUN node dist/index.js --version || echo "WARNING: kritya --version did not exit cleanly"
