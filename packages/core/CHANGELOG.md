# Changelog

Notable changes to `@tsfga/core`. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions
follow [Semantic Versioning](https://semver.org/) (pre-1.0: minor
releases may contain breaking changes).

## 0.6.0 — 2026-08

### Fixed

- **`addTuple` validates the condition, all five ways OpenFGA
  does.** Type restrictions are enforced twice upstream — on write
  and on read — and only the read half checked the condition, so a
  caller could create a row the model does not admit and get no
  error, then find every check ignoring it. The read gate made
  that safe; it did not make it discoverable.

  Refused, each with its own `cause` on
  `InvalidConditionalTupleError`: *condition is missing*,
  *invalid condition for type restriction*, *undefined condition*,
  *parameter type error*, *invalid context parameter*.

  Two ordering rules are upstream's and were probed rather than
  assumed: an **undefined** condition reports that even when the
  restriction would not have admitted the name either, and a
  context carrying both an ill-typed value and a stray key reports
  the type error.

  **Only the context keys actually present are validated.** A
  conditioned tuple with no context, or a partial one, is
  accepted — the rest can still arrive with the check request, and
  requiring it here would refuse writes OpenFGA takes.

  **Cost: a conditioned write goes from 2 round-trips to 3.**
  `addTuple` validates against the raw store — the request-scoped
  config cache is built inside `check`, so it is not on this path
  — and the third trip is the condition-definition lookup.
  Unconditioned writes are unchanged, since an unconditioned tuple
  needs no definition and no context read. Bulk-loading 10,000
  conditioned tuples goes from 20,000 trips to 30,000.

  A client-lifetime cache was rejected rather than overlooked. A
  validation gate that caches goes stale across processes: another
  instance narrows a restriction and this client keeps accepting
  tuples the model no longer admits, which is the fail-open class
  this whole round exists to close. A cache scoped to one
  `addTuple` would save nothing.

- **A context value is now read as its declared parameter type.**
  An ill-typed value raised nothing and resolved the condition
  `false`, which on the subtract side of an `excludedBy` means the
  exclusion does not fire — so `n: int` given `4.5` **granted**.
  The mirror was fail-closed: `n: int` given `"42"` threw, where
  OpenFGA accepts it.

  ```
  n=42    (declared int)  tsfga true    OpenFGA true
  n=4.5   (declared int)  tsfga false   OpenFGA parameter type error
  n="42"  (declared int)  tsfga throws  OpenFGA true
  ```

  `coerceContext` ports OpenFGA's
  `internal/condition/types/converters.go`, probed case by case
  against v1.18.2. A `typeof` check diverges on six of them: the
  numeric types accept numeric **strings**, because JSON has no
  integer type and upstream parses rather than asserts, while
  `duration` and `timestamp` accept **only** strings. It is
  exported, and shared with the write path so a tuple cannot be
  writable but unevaluable.

  Only the keys actually present are read. A context key the
  condition does not declare is accepted at check time — probed —
  and refused only on write.

- **A tuple-to-userset's tupleset row is now condition-checked.**
  `define parent: [folder with flag]` with
  `define viewer: viewer from parent` means the link exists only
  while `flag` holds. tsfga read the tupleset rows and dispatched
  on every one without evaluating their conditions, so access
  granted through a link the model had switched off. The rows are
  also now gated on the tupleset relation's own type restriction,
  which nothing narrowed before.

  **Two call sites shared the defect** — step 5's plain
  tuple-to-userset and `checkIntersection`'s `tupleToUserset`
  operand — and they now share one `resolveTupleset` helper. The
  second is the more dangerous: an intersection operand satisfied
  through a switched-off link, inside the subtrahend of an
  exclusion, grants rather than denies. A test covering only the
  first passes while it is still live, which is what
  `tests/conformance/tupleset-conditions.test.ts` pins.

- **A type restriction now carries its condition, and the
  condition is matched exactly.** `directlyAssignable` recorded
  `user` for the OpenFGA restriction `[user with weekday_only]`,
  dropping the condition. OpenFGA treats the condition as part of
  the restriction and matches it in both directions — probed
  against v1.18.2:

  | stored row | model admits | OpenFGA |
  |---|---|---|
  | `user:alice`, no condition | `[user with weekday_only]` | `false` |
  | `user:alice` with `weekday_only` | `[user]` | `false` |
  | `user:alice` with `weekday_only` | `[user with other_cond]` | `false` |
  | `team:eng#member` with `weekday_only` | `[team#member]` | `false` |

  The first row is the fail-open one: tsfga admitted it, found no
  `conditionName`, treated that as unconditional access and
  granted — **even where the check context would have satisfied
  the condition it lacked**. The wildcard cases mirror it exactly.

  `tests/conformance/condition-restrictions.test.ts` reproduces
  the whole table against the container. Against the previous
  commit 6 of its 11 cases fail, all of them in the granting
  direction; the other 5 hold before and after.

### Changed

- **BREAKING: `RelationConfig.directlyAssignable` is now
  `TypeRestriction[]`, not `string[]`.** Each entry mirrors
  OpenFGA's `RelationReference` field for field:

  ```ts
  { type: "user" }                                  // user
  { type: "user", wildcard: true }                  // user:*
  { type: "team", relation: "member" }              // team#member
  { type: "user", condition: "weekday_only" }       // user with weekday_only
  ```

  Structured rather than a `"user with weekday_only"` string
  because every consumer needs a different projection: the read
  gate is condition-blind, the clamp is exact, and the Kysely
  adapter wants `type` and `relation` as separate columns. A
  joined string would be re-parsed at each, and
  `CachingTupleStore` already refuses one on that ground.

  Migration `005` is unchanged as DDL — the column was and stays
  `jsonb NOT NULL` — but the payload shape changes, so relation
  configs must be rewritten. Tuples are untouched.

- **BREAKING: `CheckTuplesQuery`'s `includeDirect` and
  `includeWildcard` booleans are now `directRefs` and
  `wildcardRefs`**, joining `usersetRefs` as
  `readonly TypeRestriction[] | null`. For all three, `null`
  declines to narrow and `[]` excludes the part — they are
  opposites, and a wrapper that forwards `null` where it meant
  "already answered" opens the gate rather than closing it.

- **BREAKING: `listSubjects` is now condition-exact.** A row
  carrying a condition the relation does not admit is no longer
  reported, exactly as a row of an unadmitted type is not.

- **`InvalidSubjectTypeError` is condition-blind and raised
  first**; the condition dimension raises the new
  `InvalidConditionalTupleError`, which carries a `cause`
  discriminator. OpenFGA raises one error for all condition
  causes and discriminates by cause string, so tsfga does the
  same. Folding the two together would have produced
  `Subject type 'user with weekday_only' is not allowed`, naming
  a type nobody wrote.

- `TypeRestriction`, `SubjectShape`, `subjectShape`,
  `admitsSubjectShape` and `formatRestriction` are exported.
  `admitsSubjectShape` is the read gate; `admitsSubjectRef`
  remains the exact match used by the clamp and the write path.
  A consumer narrowing a `WHERE` clause wants the first to decide
  what to fetch and the second to filter what it holds.

### Fixed

- **Userset type restrictions are now recorded and enforced.**
  `RelationConfig` kept a type array plus a bare boolean —
  *whether* userset subjects were allowed, never *which*. A
  relation admitting only `team#member` accepted
  `document:budget#viewer@team:eng#owner` through `addTuple`, the
  documented validating write path, and then granted on it.

  Probed against OpenFGA v1.18.2: it refuses that write outright,
  and on a store where the row already exists it answers `false`
  where tsfga answered `true`. A fail-open divergence reachable
  through the ordinary public API, with no raw SQL.

  Both halves are now enforced, on the write path and in the check
  read gate, and both are covered by
  `tests/conformance/userset-restrictions.test.ts`.

- **`listSubjects` applies the relation's type restrictions.** It
  was a bare pass-through to the store, so it reported subjects
  the model does not admit and `check` denies. Narrowing a
  relation does not revalidate the tuples already written, so that
  state is reached by ordinary model evolution.

  The gate is in core, not the adapter, so every `TupleStore` —
  the wrappers, third-party stores — is covered, and adapter
  authors stay outside the security boundary.

  **Consequence:** no library path now *finds* an inadmissible row
  in order to delete it. Upstream keeps `Read` unfiltered for that
  reason; a maintenance read is owed.

  `listObjects` is deliberately unchanged: it re-checks every
  candidate through the gated path, so over-returning candidates
  costs work and cannot grant.

### Changed

- **BREAKING: `RelationConfig.directlyAssignableTypes` and
  `.allowsUsersetSubjects` are replaced by one required
  `directlyAssignable: string[]`**, matching OpenFGA's
  `directly_related_user_types` one for one: `"user"`, `"user:*"`,
  `"team#member"`.

  This also retires an overloaded `null`, which meant both
  *unrestricted* and *purely computed*. `[]` now says "admits no
  direct assignment" precisely, so a purely computed relation
  issues no tuple read at all — which upstream does and tsfga
  previously could not express.

  Migrating: enumerate what each relation admits, from your
  authorization model. There is no automatic conversion, and a
  guessed one would err in the granting direction.

- **BREAKING: `CheckTuplesQuery.includeUsersets` is replaced by
  `usersetRefs: readonly string[] | null`** — the `type#relation`
  refs the relation admits, so a store can narrow its scan.
  `null` declines to narrow, `[]` excludes the userset part.
  Still a hint: `clampToQuery` re-clamps the reply against the
  same list, so a store that over-returns loses rows rather than
  smuggling them past the model.

- **BREAKING: `TupleStore.listDirectSubjects` is removed.** It was
  already a strict subset of `findTuplesByRelation` — the same
  columns off the same predicate, minus the condition fields.
  `listSubjects` reads through `findTuplesByRelation` and
  projects.

- **BREAKING: `UsersetNotAllowedError` is removed.** A userset on
  a relation that admits none is now an `InvalidSubjectTypeError`
  naming the offending ref, which is the single error upstream
  raises for every type-restriction violation.

### Added

- **`admitsSubjectRef` and `directSubjectRef` are exported.** A
  consumer narrowing their own query can apply the gate tsfga
  applies instead of reimplementing it and drifting out of step.

  `null` config stays permissive, because that is what `check`
  does and agreement is the point. Two hazards are documented
  rather than designed away: a `null` config in a consumer's
  `WHERE` clause usually means a misspelled relation name, where
  it silently admits everything; and the predicate filters tuple
  *shapes* only, knowing nothing of `excludedBy` or
  `intersection`, so a row it admits is one `check` will consider,
  not one `check` will allow.

## 0.5.0 — 2026-08

### Added

- **`checkMany(requests)`**, on the client and as a standalone
  export, runs a batch of checks in one resolution scope. The
  relation-config cache and the node memo span the batch, so the
  part of the graph the requests have in common is resolved once
  instead of once per call. A consumer measured a page render
  making four checks about one object at 862 store statements;
  the same work in one scope is 21-31.

  Shape follows OpenFGA's BatchCheck: outcomes are
  `{ allowed, error? }`, a failing check reports its error in its
  own outcome rather than failing the batch, and only invalid
  options throw. Answers come back in request order — upstream
  keys an unordered map on a caller-supplied correlation id, and
  the array position serves the same purpose without asking for
  one. Identical requests in a batch coalesce and cost one
  resolution, which is what upstream gets by de-duplicating on a
  cache key before dispatch.

  The scope is bounded by the call, so it is safe to use inside a
  transaction — a tuple written earlier in that transaction is
  visible to it. That is why this is a shared scope and not a
  tuple cache.

- **`CheckOptions.maxConcurrentChecks`** (default 50, matching
  `OPENFGA_MAX_CONCURRENT_CHECKS_PER_BATCH_CHECK`) bounds how many
  checks of one `checkMany` batch resolve concurrently. It is a
  separate knob from `maxBreadth`, which bounds the branches
  within a single check — the same split upstream makes. `check`
  and `listObjects` ignore it.

### Changed

- **Concurrent routes into the same node now resolve it once.**
  The node memo published only settled results, so at any
  `maxBreadth` above 1 the routes overlapped and every one of them
  re-resolved the shared subtree and re-issued its reads: the
  resolution DAG walked as a tree, with breadth as the duplication
  multiplier. A consumer profiling a page render measured one
  immutable parent edge read 215 times in a single request. A
  route that arrives while another is still resolving now waits
  for it.

  Results are unchanged, including for cyclic models. A subtree
  truncated by a cycle and a subtree that threw are still never
  shared — both are properties of the route rather than of the
  node, which is the same line upstream's cached resolver draws
  for a cycle-detected response.

- **Branches abandoned after a node settles stop querying the
  store.** A union that found its grant already refused to launch
  queued branches; the branches already in flight now stop at
  their next checkpoint instead of walking their subtree. One read
  per abandoned branch — the one already handed to the store —
  still lands, because cancellation is not part of the
  `TupleStore` contract. If you instrument your store, drain its
  counters before reading them.

### Documentation

- **The README no longer claims that `maxBreadth` never changes the
  boolean result.** It can, on a model where a cycle reaches an
  intersection operand: the first failing operand decides and
  carries its own indeterminacy out, and an enclosing `but not`
  reads a cycle-flagged denial differently from a plain one. This
  is upstream's behaviour — OpenFGA's intersection short-circuits
  the same way and its answer likewise tracks which operand is
  cheaper — so it is documented rather than "fixed"; making it
  deterministic would mean granting where OpenFGA denies. The claim
  was already wrong in 0.4.0. New conformance fixture
  `intersection-cycle-precedence` pins both directions against a
  live OpenFGA.

### Notes

- `maxBreadth` keeps its default of 10.
  `OPENFGA_RESOLVE_NODE_BREADTH_LIMIT` is 10 upstream, and with
  the change above breadth is no longer a duplication multiplier.
  What remains true is that breadth buys parallelism only if the
  store can execute reads concurrently: on a single pooled
  PostgreSQL connection it buys queueing, and `maxBreadth: 1` is a
  reasonable setting there.

## 0.4.0 — 2026-08

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

- **A condition evaluated with missing declared parameters is now
  an error, not an unmet condition.** A tuple whose condition
  declares a parameter that neither the tuple context nor the
  request context supplies used to resolve `false`; it now throws
  `ConditionEvaluationError` naming the absent keys, matching
  OpenFGA's check path. The difference is not cosmetic: a
  silently-unmet condition fails open through an exclusion
  branch, where "not excluded" grants. Callers that relied on a
  missing parameter reading as a denial must supply the
  parameter, or catch the error.

- **A definitive denial now outranks a sibling error in
  intersection and exclusion.** Unions already let a branch
  resolving `true` beat an errored sibling; the other two
  operators rejected as soon as any branch did. As in OpenFGA,
  an intersection operand resolving `false` now denies even
  though another operand errored, and an exclusion whose
  subtracted branch resolves `true` denies even though the base
  errored — only a base that *granted* alongside an errored
  exclusion branch still propagates. Checks that used to reject
  now resolve `false`; the theopenlane fixtures hit exactly this
  through `member and access`, where a conditioned tuple with
  missing parameters inside one operand poisoned a check OpenFGA
  resolves. The fail-closed invariant holds throughout: an error
  never becomes a grant, only definitive denials win past one.

  When several branches do fail, which error surfaces follows
  completion order, so it is not deterministic under concurrency
  — the same nondeterminism OpenFGA's union reducer has.

### Added

- **`CheckOptions.maxBreadth`** bounds how many branches of one
  resolution node are evaluated concurrently, mirroring
  OpenFGA's `OPENFGA_RESOLVE_NODE_BREADTH_LIMIT`. It **defaults
  to 10**, that option's upstream default; before this release
  fanout was unbounded, so a union over 1k userset tuples issued
  1k concurrent sub-checks and ran every one to completion even
  after a branch had granted. Pass `maxBreadth: Infinity` to
  restore the old behavior.

  Bounding changes scheduling, not answers: the boolean result
  and whether a check errors are unaffected, and the core,
  adapter, and conformance suites pass unchanged at the new
  default. On a 1k-branch union that grants, the bound cuts the
  benchmark from ~270 ms/3005 store calls to ~108 ms/1166; a
  100-branch TTU hit goes from ~41 ms/306 to ~17 ms/192. The one
  measured regression is all-miss wide unions under concurrent
  load (~20% slower batch wall time for four parallel 1k-branch
  misses), where unbounded fanout kept the pool queue full —
  `Infinity` restores it for miss-heavy workloads.

  Exclusion keeps a fixed breadth of 2, as upstream does. Values
  other than an integer >= 1 or `Infinity` throw `TsfgaError`;
  a fractional bound would admit one more branch than stated.

  `maxBreadth` also bounds how many `listObjects` candidates are
  checked at once, following upstream, whose ListObjects worker
  pool is sized from the same limit.

### Changed

- **`maxDepth` now defaults to 25 instead of 10**, matching
  OpenFGA's `OPENFGA_RESOLVE_NODE_LIMIT`. The old default threw
  `DepthExceededError` on models a stock OpenFGA server resolves,
  so deep models needed an explicit override to conform. Callers
  who passed `maxDepth: 25` for that reason can drop it.

- **Relation configs and condition definitions are read once per
  check request.** Both are static per authorization model, but
  every resolution node re-fetched them — on a 1000-branch
  userset fanout, ~1000 redundant round-trips, a quarter of all
  store calls. An internal request-scoped cache now memoizes
  both, including negative results, and coalesces concurrent
  branches asking the same key onto one in-flight query; a
  failed read is evicted rather than pinned, so a later branch
  retries. The cache lives for one `check` call, so a config
  written between two checks is always observed; a write racing
  a check in flight may not be. Measured against PostgreSQL, a
  1000-branch fanout dropped from 4004 to 3005 store calls and
  365 ms to 260 ms.

- **A node reached by two routes in one request resolves once.**
  The check graph is a DAG explored as a tree, so a shared
  subtree was re-resolved per route. A request-scoped memo now
  publishes settled node results only — never in-flight promises,
  which deadlock on a cross-branch cycle — and only results that
  are not cycle-truncated, since a truncated `false` is
  path-dependent. Reuse is gated on the depth an entry was proved
  at, so a memo hit can never answer where a fresh resolution
  would have thrown `DepthExceededError`. At the default breadth
  a whole level is in flight before any of it settles, so the
  memo mostly pays inside `listObjects`, where it spans every
  candidate.

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

### Fixed

- **An intersection with zero operands no longer grants.** A
  malformed config with an empty `intersection` array resolved
  vacuously `true`, granting the relation to every subject. It
  now throws `TsfgaError`; OpenFGA's typesystem rejects a set
  operation with too few children as an invalid model.
  Single-operand intersections stay valid — tsfga's decomposed
  configs use them legitimately.

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
