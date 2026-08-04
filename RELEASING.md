# Releasing

Step-by-step guide for publishing `@tsfga/core` or
`@tsfga/kysely` to npm.

The release workflow is the **only** publish path. There is
no local publish: the former root `release` and `version`
npm scripts have been removed. Versions are bumped with
`scripts/bump.sh`, and user-facing changes are recorded by
hand in each package's `CHANGELOG.md`.

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

The script updates the `version` field in `package.json` and
`bun.lock`. It does not touch the `@tsfga/core` peer/dev
range in `packages/kysely` — that stays `workspace:*` in the
repo and is substituted at release time by the workflow's
"Resolve workspace protocol" step. Commit the version bump,
update the package's `CHANGELOG.md`, open a PR, and merge.

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

### Where release notes come from

`scripts/release-notes.sh` builds the notes from git
history alone: it walks the commits since the previous
tag, looks up each one's PR via the GitHub API, and
groups them under headings by PR label (`breaking`,
`feature`, `bug`, `documentation`, `tooling`; anything
unlabeled lands under "Other"). Labeling the PR is
therefore the only thing that steers the generated
notes.

The narrative account of a release lives in each
package's `CHANGELOG.md`, written by hand as part of the
version-bump PR. That file is the source consumers read;
the generated notes are a commit-level index pointing
back at the PRs.

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
to `@tsfga/core` with the actual version, then reverts the
change. This happens before the packaging checks and on
every dispatch, including validate-only ones, so publint,
attw and `npm pack` inspect the manifest that actually
ships rather than one still carrying `workspace:*`.

**OIDC Trusted Publishing:** npm verifies the GitHub
Actions workflow identity via Sigstore — no long-lived
npm token needed. The `--provenance` flag adds attestation
linking each package to its source repo and build.

`id-token: write` is declared on the release job. The
workflow level keeps a `contents: read` default so a job
added later does not inherit the elevated scopes; because a
job-level `permissions` block replaces the workflow-level
one rather than merging with it, the job restates
`contents: write` too. npm needs the id-token permission to
exchange an OIDC token for a publish token. Without it npm
skips the exchange without logging anything at the default
level and `npm publish` fails with `ENEEDAUTH`, which reads
like a missing token rather than a missing permission. The
"Verify Trusted Publishing preconditions" step exists to
catch that case with a useful message.

Trusted Publishing needs npm >= 11.5.1. No Node 22 release
ships one — 22.23.2 still bundles npm 10.9.8, which has no
OIDC support at all — so the job pins Node 24.19.0 and uses
its bundled npm 11.17.0 directly. There is no separate npm
install: `actions/setup-node` ships no npm of its own, so
pinning Node exactly also pins npm, and the toolchain cannot
change between a validate run and a publish run. The
"Verify npm supports Trusted Publishing" step asserts the
version immediately after `setup-node`, so a Node downgrade
fails in seconds and by name rather than as an `ENEEDAUTH`
after the full test suite.

**Tag convention:** `@tsfga/core@0.3.0`,
`@tsfga/kysely@0.3.0`.
