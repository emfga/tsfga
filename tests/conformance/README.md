# @tsfga/conformance

Conformance tests that validate
[`@tsfga/core`](../../packages/core/README.md) against a
real OpenFGA service.

Part of the [tsfga](../../README.md) monorepo. This package
is private and not published to npm.

## How it works

Each test writes the same authorization model and tuples to
both tsfga (via `KyselyTupleStore`) and OpenFGA (via
`@openfga/sdk`), then asserts that `check()` returns
identical results for every test case using
`expectConformance()`.

## Prerequisites

- [Docker](https://www.docker.com/) — runs PostgreSQL and
  OpenFGA
- Run `bun run infra:setup` from the repo root to start
  services and apply migrations

## Running

```bash
bun run turbo:test:conformance
```

To type-check this workspace, run `bun run tsc` from the
repo root — it covers the fixtures and helpers here along
with the published packages.

## Test models

**Basic patterns:**
- `direct-access` — direct tuple assignment
- `user-groups` — group membership
- `roles-and-permissions` — RBAC with role hierarchy
- `parent-child` — parent-child object relationships

**Real-world models:**
- `slack` — Slack workspace/channel permissions
- `github` — GitHub org/repo/branch permissions
- `gdrive` — Google Drive document sharing
- `grafana` — Grafana dashboard access
- `expenses` — expense approval workflows
- `theopenlane.core` — TheOpenLane core model
- `theopenlane.compliance` — TheOpenLane compliance
- `theopenlane.programs` — TheOpenLane programs

**Advanced patterns:**
- `custom-roles` — dynamic custom role definitions
- `public-access` — wildcard/public access
- `blocklists` — exclusion-based access (but-not)
- `intersection-exclusion` — exclusion applied on top
  of an intersection result
- `entitlements` — feature entitlement checks
- `advanced-entitlements` — multi-condition
  entitlements

**Resolution limits and error semantics:**
- `wide-union` — a node fanning out wider than the
  default breadth limit of 10
- `deep-rewrite` — a rewrite ladder deeper than the
  default depth limit of 25; pins that rewrites of the
  same object cost no resolution depth
- `cycles` — loops in the tuple graph; pins that a cycle
  denies rather than erroring, and that it denies on the
  subtract side of a `but not`
- `condition-error-siblings` — how a condition error on
  one branch interacts with its siblings

**Conditions:**
- `organization-context` — org-scoped conditions
- `contextual-time-based` — time-window conditions
- `temporal-access` — expiring access with timestamps
- `multiple-restrictions` — intersection of multiple
  conditions
- `token-claims-contextual-tuples` — contextual tuples
  with token claim conditions

## Adding a new model

1. Create a directory under `tests/conformance/` with a
   `model.dsl` file (OpenFGA DSL) and a `tuples.yaml`
   file (relationship tuples)
2. Write a test file using `expectConformance()` — see
   existing tests for the pattern
3. Pick an unused UUID prefix for deterministic IDs (see
   existing test files for allocated ranges)
4. Run `bun run turbo:test:conformance` to verify both
   tsfga and OpenFGA agree on all checks
