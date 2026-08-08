# Changelog

Notable changes to `@tsfga/core`. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions
follow [Semantic Versioning](https://semver.org/) (pre-1.0: minor
releases may contain breaking changes).

## Unreleased

### Changed

- **Only dispatches to another object spend the depth budget.**
  Userset expansion and tuple-to-userset expansion cost one depth
  each, as before; rewrites of the same object — `impliedBy`,
  `computedUserset`, `excludedBy` and intersection operands — now
  cost none. Previously every one of them charged a depth, so
  tsfga exhausted `maxDepth` earlier than OpenFGA and threw
  `DepthExceededError` on models OpenFGA resolves — reachable at
  the default limit of 25. The guard also moved from
  `depth > maxDepth` to `depth >= maxDepth`, matching OpenFGA's
  `Depth == maxResolutionDepth`: a budget of `maxDepth` admits a
  root node plus `maxDepth - 1` dispatches. Behavior-visible, not
  an API change: checks that used to throw may now resolve, and a
  check one dispatch past the limit throws where it previously
  resolved. Long rewrite ladders are still bounded — by cycle
  detection, since one object has a finite set of relations.

## 0.3.1 — 2026-08

Maintenance release. No changes to the published code — the
package contents are identical to 0.3.0.

### Changed

- Release tooling: the publish job pins Node 24.19.0 and uses its
  bundled npm 11.17.0 for Trusted Publishing, and CI actions moved
  off the deprecated Node 20 runtime.
- CI now builds and runs the `examples/node-kysely` example
  against the workspace packages, so the documented consumer
  setup is verified on every run.

## 0.3.0 — 2026-08

### Breaking changes

- **Depth exhaustion and cycles now throw `DepthExceededError`**
  instead of returning `false`. In 0.2.x, exceeding `maxDepth`
  silently resolved a branch to `false`, which was fail-open under
  exclusion (`excludedBy`): a deep excluded sub-check could
  incorrectly grant access. Cyclic relation graphs throw the same
  error (mirroring OpenFGA's `resolution_too_complex`). A branch
  that short-circuits to `true` before the error still wins;
  otherwise the error propagates to the caller.
- **Contextual tuples are validated like `addTuple`.** Contextual
  tuples passed to `check` are now validated against relation
  configs (allowed subject types, userset rules). Callers relying
  on the previous lax behavior will now get validation errors.
- **ESM-only, Node.js >= 22.12.0.** The package declares
  `engines.node: ">=22.12.0"` and ships only an ESM build. Node.js
  20 (EOL April 2026) is no longer supported.

### Changed

- The CEL condition cache is keyed by expression content and scoped
  per instance instead of cached globally by condition name.
  Redefining a condition (same name, new expression) now takes
  effect immediately; 0.2.x could keep evaluating the stale
  compiled expression.
- Missing CEL condition parameters are detected structurally
  instead of by matching the evaluator's "Unknown variable" error
  message, so the missing-parameter → deny path no longer depends
  on error-message wording.
- `intersection` no longer shadows `excludedBy`: relations
  configured with both are evaluated correctly.
- `listObjects` propagates the request `context` to its internal
  checks, so condition-gated tuples are evaluated consistently.
- Updated to `@marcbachmann/cel-js` 8.

### Added

- `sideEffects: false` for bundler tree-shaking; the MIT `LICENSE`
  file now ships in the npm tarball.

## 0.2.0 — 2026-02-18

First published release, as part of the tsfga Turborepo monorepo.

- 5-step recursive check algorithm: direct tuples, userset
  expansion, relation inheritance (`impliedBy`), computed usersets,
  and tuple-to-userset (with multiple TTU paths per relation).
- Exclusion (`excludedBy`) and intersection operators.
- CEL condition evaluation with typed parameters, context merging
  (tuple context wins), and timestamp/duration coercion.
- Contextual tuples via `ContextualTupleStore`.
- Wildcard (public access) matching.
- Database-agnostic `TupleStore` interface and `createTsfga`
  public API.
