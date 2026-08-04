# Releasing

Step-by-step guide for publishing `@tsfga/core` or
`@tsfga/kysely` to npm.

The release workflow is the **only** publish path. There is
no local publish: the former root `release` and `version`
npm scripts (which called `changeset publish` /
`changeset version` outside the guarded workflow) have been
removed. Versions are bumped with `scripts/bump.sh`;
changesets exist only to document changes for release notes.

> Note: the release-workflow safeguards described below
> (test gate, packaging checks, idempotent re-run) ship as
> part of the 0.3.0 release-hardening changes.

## Prerequisites

- Push access to `emfga/tsfga`
- npm Trusted Publisher configured for both packages
  (repository: `emfga/tsfga`, workflow: `release.yml`)

## 1. Bump the version

```bash
# In the repo root:
scripts/bump.sh packages/core minor   # or patch / major
scripts/bump.sh packages/kysely minor
```

The script updates `package.json` (including the
`@tsfga/core` peer/dev range in `packages/kysely`) and
`bun.lock`. Commit the version bump, update the package's
`CHANGELOG.md`, open a PR, and merge. Optionally add a
changeset (`bun run changeset`) to document the change for
release notes.

## 2. Trigger the release workflow

1. Go to **Actions** → **Release** on `emfga/tsfga`
2. Select the package
3. Check **Publish to npm**
4. Click **Run workflow**

Without the publish checkbox, the workflow validates the
release (build, type check, tests, packaging checks)
without publishing. Run a validate-only pass first.

Release `@tsfga/core` before `@tsfga/kysely` when both
have changes, since kysely depends on core.

### What the workflow gates on

Before anything is published, the workflow must pass:

- **Full test suite** — unit, adapter, and conformance
  tests run against real PostgreSQL and OpenFGA services
  (Docker Compose), so nothing publishes from an untested
  commit.
- **Packaging checks** — `publint`,
  `@arethetypeswrong/cli` (attw), and
  `npm pack --dry-run` validate the tarball and its
  exports map. The attw `node10` profile is ignored by
  decision: the packages are ESM-only with no `main`
  fallback.

## 3. Verify

```bash
npm view @tsfga/core@<version>
npm view @tsfga/kysely@<version>
```

Check the GitHub release was created with the correct tag
(`@tsfga/core@<version>` or `@tsfga/kysely@<version>`).

## 4. Edit release notes (optional)

The workflow generates release notes from git history and
PR labels. Edit the GitHub release if custom notes are
needed.

### Using changesets for release notes

Changesets play **no role in versioning** — versions are
bumped by `scripts/bump.sh`, and nothing on the release
path runs `changeset version` or `changeset publish`.
Their only role is documentation: when preparing a
release, maintainers can create a changeset to describe
user-facing changes:

```bash
bun run changeset
```

The changeset body becomes part of release notes — write
it for end users. Changesets are not required — they are
a convenience for structuring release notes.

Bot PRs (Renovate, Dependabot) and external contributor
PRs do not need changesets. Maintainers add them when
the change warrants a release note entry.

## Recovering from a partial failure

The workflow is safe to re-run. If a run fails **after**
`npm publish` succeeded (e.g., a transient error while
tagging or creating the GitHub release), re-run it with
the same inputs: it detects that the version is already
on npm, skips the publish, and resumes the remaining
steps (tag, push, release notes, GitHub release) —
without republishing.

This also covers the two-package case: if the kysely
publish fails after core succeeded, fix the problem and
re-run — core is not republished.

## Example: releasing 0.3.0

1. On a branch: `scripts/bump.sh packages/core minor` and
   `scripts/bump.sh packages/kysely minor` (both →
   0.3.0). Update both `CHANGELOG.md` files. PR, merge.
2. Run the **Release** workflow for `@tsfga/core` with
   publish **unchecked** (validate-only). Repeat for
   `@tsfga/kysely`.
3. Run again for `@tsfga/core` with publish **checked**.
4. After core succeeds, run for `@tsfga/kysely` with
   publish checked.
5. Verify both versions with `npm view` and check the
   GitHub releases/tags.

## How it works

**Workflow restriction:** The release job has
`if: github.repository == 'emfga/tsfga'` — it will not
run on forks.

**No commits to main:** The workflow does not create any
commits. Version bumps happen in PRs. The workflow
publishes whatever version is already in `package.json`,
creates a git tag, and pushes the tag (not main).

**Workspace protocol resolution:** For `@tsfga/kysely`,
the workflow temporarily replaces `workspace:*` references
to `@tsfga/core` with the actual version before publishing,
then reverts the change.

**OIDC Trusted Publishing:** npm verifies the GitHub
Actions workflow identity via Sigstore — no long-lived
npm token needed. The `--provenance` flag adds attestation
linking each package to its source repo and build.

The `id-token: write` permission is declared on the job as
well as the workflow: the runner injects
`ACTIONS_ID_TOKEN_REQUEST_URL` and
`ACTIONS_ID_TOKEN_REQUEST_TOKEN` based on the job's own
permissions, and npm needs both. When they are absent npm
skips the token exchange without logging anything at the
default level and `npm publish` fails with `ENEEDAUTH`,
which reads like a missing token rather than a missing
permission. The "Verify Trusted Publishing preconditions"
step exists to catch that case with a useful message.

npm itself only learned Trusted Publishing in 11.5.1, and
Node 22 still bundles npm 10, so the workflow installs a
pinned npm into `$RUNNER_TEMP/npm-cli` and prepends it to
`PATH`. Self-updating the global npm is not reliable here:
it reports success while landing somewhere that is not the
`npm` later steps resolve, and npm 10 skips the OIDC
exchange with the same silent ENEEDAUTH. The preconditions
step also asserts the version for that reason.

**Tag convention:** `@tsfga/core@0.3.0`,
`@tsfga/kysely@0.3.0`.
