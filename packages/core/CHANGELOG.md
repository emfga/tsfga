# Changelog

Notable changes to `@tsfga/core`. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions
follow [Semantic Versioning](https://semver.org/) (pre-1.0: minor
releases may contain breaking changes).

## Unreleased

### Breaking changes

- **`TupleStore.findDirectTuple` and `TupleStore.findUsersetTuples`
  are replaced by `findCheckTuples`.** A check node wanted all
  three reads — the subject's direct tuple, the `type:*` wildcard
  tuple, the userset rows — and issued three calls for them. It
  now issues one, taking a `CheckTuplesQuery` and returning a
  `CheckTuples`; both types are exported. Custom `TupleStore`
  implementations must be updated: the two old methods are gone,
  with no fallback shim.

  The query carries which parts the caller wants, so the relation
  config gating below still applies. Those `include*` flags let a
  store narrow its query, but they are not a trust boundary: the
  check algorithm re-clamps every reply against the query it
  sent, so a store that ignores a flag or files a row under the
  wrong slot loses that row rather than granting access the model
  forbids. A node whose config rules out all three parts skips
  the store altogether.

  This is a latency change, not a work change: the number of rows
  read is the same, and the store-call count barely moves,
  because the type-restriction gating below had already cut most
  nodes to a single admitted read. What moves is round-trips and
  connection-pool pressure. A node used to issue up to three
  concurrent reads, so at the default `maxBreadth` of 10 a single
  wide node could demand up to 30 connections at once; it now
  demands 10. Measured against PostgreSQL on a 10-connection
  pool, relations that admit more than one part (`[user,
  group#member]`, the common nested-group shape) resolve
  1.8x–3.0x faster; relations that admit exactly one part emit
  identical SQL and are unchanged. On a single-connection handle
  every shape improves, 1.1x–2.3x.

  Porting a custom store is mechanical. The minimal version keeps
  whatever queries you already had and drops the flags:

  ```ts
  async findCheckTuples(query) {
    const onNode = [query.objectType, query.objectId, query.relation];
    return {
      direct: query.includeDirect
        ? await this.oldFindDirectTuple(
            ...onNode, query.subjectType, query.subjectId)
        : null,
      wildcard: query.includeWildcard
        ? await this.oldFindDirectTuple(
            ...onNode, query.subjectType, "*")
        : null,
      usersets: query.includeUsersets
        ? await this.oldFindUsersetTuples(...onNode)
        : [],
    };
  }
  ```

  That is correct but keeps three round-trips. The point of the
  change is to serve the parts in one query where the backend can
  — see `@tsfga/kysely` for a SQL implementation.

  `ContextualTupleStore`'s overlay is unchanged and still
  deliberately asymmetric: a contextual tuple *replaces* the
  stored direct or wildcard tuple (a probe returns one row, so an
  override has to win outright) but is *concatenated* with the
  stored userset rows.

- **A cycle in the resolution path no longer throws.** Revisiting
  a node used to raise `DepthExceededError`, the same error as
  depth exhaustion. It now resolves `false`, and `check()` returns
  `false` to the caller. OpenFGA errors only on depth exhaustion;
  a cycle is `Allowed:false` with an internal `CycleDetected`
  flag. Callers that catch `DepthExceededError` to detect a cyclic
  model will no longer see it — depth exhaustion still throws, and
  is now the only thing that does.

  Internally the flag is tracked rather than collapsed into a
  plain `false`, because the set operators read the two
  differently. Most sharply: on the subtract side of `but not` a
  cycle *denies*, so `base:true but not subtract:cycle` is
  `false`. Treating a cycle as an ordinary `false` there would
  grant — a fail-open. Like OpenFGA, the flag is not exposed on
  the public result.

  Known divergence, documented in the README: OpenFGA has
  dedicated resolvers for recursive relation shapes
  (`define member: [user, group#member]`, or a TTU recursing on
  its own relation), which resolve a data loop to a definitive
  `false` with no flag. tsfga reports indeterminacy there. The
  only case where that is observable is the subtract side of a
  `but not`, where OpenFGA grants and tsfga denies.

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

- **`listObjects` checks its candidates concurrently and shares
  one request scope across them.** Each candidate used to get its
  own relation-config cache and its own node memo, so N documents
  behind one folder re-read every config N times and re-resolved
  the shared subtree N times; they now span the whole call. The
  serial loop is also gone — candidates run with at most
  `maxBreadth` in flight, the same bound upstream uses for its
  ListObjects pool. On a 200-candidate benchmark where 195 share
  a three-node subtree this is 2361 store reads down to 852, and
  395 config reads down to 2.

  Two behaviors are now specified rather than incidental. The
  returned array is in candidate order, which concurrency would
  otherwise have scrambled. And when several candidates fail, the
  error raised is the first failing candidate in *candidate*
  order, not the first to fail in time — so a broken model
  reports the same error on every run. As before, any error fails
  the whole call rather than dropping the offending object.

- **A check no longer issues tuple reads the relation config
  rules out.** Each node used to probe for a direct tuple, a
  wildcard tuple and userset rows regardless of what the relation
  admits. Each read is now gated on the config — the same
  predicate `addTuple` applies, so a writable tuple is always a
  findable one — cutting a wide-union benchmark from 3005 store
  reads to 1004, a TTU fanout from 306 to 104, and the
  200-candidate `listObjects` shape from 852 to 436.

  **Behavior-visible.** A tuple the model does not admit — one
  written straight to the database bypassing `addTuple`, or left
  behind by a relation that has since narrowed its type list — is
  no longer found, where before it granted access. Relation
  configs are now load-bearing for the read path rather than
  advisory. OpenFGA behaves the same way and rejects such a tuple
  at write time; the change fails closed.

  A read is skipped only on a positive exclusion: no config, or
  `directlyAssignableTypes: null`, still reads everything. tsfga
  therefore skips less than OpenFGA, which issues no reads at all
  for a purely computed relation — tsfga encodes that as the same
  `null` that means "unrestricted" and cannot tell the two apart.
  Closing that gap would change what `null` means for writes too,
  so it is left for its own change.

  Ordering the config read before the tuple reads gives up the
  single overlapping read wave, also unreleased. The cost is one
  round-trip per relation per request, not per node, because
  configs are cached for the request.

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
