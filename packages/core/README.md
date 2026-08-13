# @tsfga/core

OpenFGA-compatible relationship-based access control for
TypeScript.

Part of the [tsfga](../../README.md) monorepo.

## Installation

```bash
npm install @tsfga/core
```

## Quick start

```typescript
import { createTsfga, type TupleStore } from "@tsfga/core";

// Use any TupleStore implementation (e.g. @tsfga/kysely)
const store: TupleStore = /* your store */;
```

<!-- sample: core-quick-start -->
```typescript
const fga = createTsfga(store);

// Write a relation config
await fga.writeRelationConfig({
  objectType: "document",
  relation: "viewer",
  // What the relation admits, one entry per entry of OpenFGA's
  // `directly_related_user_types`: `{ type }` for a bare type,
  // `{ type, wildcard: true }` for `user:*`, `{ type, relation }`
  // for a userset, and `condition` on any of them. `[]` means the
  // relation admits no direct assignment at all.
  directlyAssignable: [{ type: "user" }],
  // The rewrite fields. A relation that is only directly
  // assignable names none of them, but all are required, so a
  // config cannot silently omit one it meant to set.
  impliedBy: null,
  computedUserset: null,
  tupleToUserset: null,
  excludedBy: null,
  intersection: null,
});

// Add a tuple
await fga.addTuple({
  objectType: "document",
  objectId: "550e8400-e29b-41d4-a716-446655440000",
  relation: "viewer",
  subjectType: "user",
  subjectId: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
});

// Check access
const allowed = await fga.check({
  objectType: "document",
  objectId: "550e8400-e29b-41d4-a716-446655440000",
  relation: "viewer",
  subjectType: "user",
  subjectId: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
});
```

## API

`createTsfga(store, options?)` returns a `TsfgaClient`:

| Method | Description |
|---|---|
| `check(request)` | Check if a subject has a relation on an object; the subject may be a userset via `subjectRelation` |
| `checkMany(requests)` | Check several requests in one shared resolution scope; outcomes in request order |
| `addTuple(request)` | Insert a relationship tuple; a tuple that already exists throws `DuplicateTupleError` |
| `removeTuple(request)` | Delete a relationship tuple; throws when it is not there |
| `listObjects(request)` | List object IDs the subject can access, in candidate order; the request takes `subjectRelation`, `context` and `contextualTuples` |
| `listSubjects(objectType, objectId, relation)` | List direct subjects for an object + relation (no expansion) |
| `writeRelationConfig(config)` | Insert or update a relation configuration |
| `deleteRelationConfig(objectType, relation)` | Delete a relation configuration |
| `writeConditionDefinition(condition)` | Insert or update a CEL condition definition |
| `deleteConditionDefinition(name)` | Delete a CEL condition definition |

## Depth limits and cycles

`check()` resolves relations recursively with a configurable
recursion budget (`maxDepth`, default 25, via the second
argument of `createTsfga`). The default matches OpenFGA's
`OPENFGA_RESOLVE_NODE_LIMIT` (25) in value, but **not in reach** —
see below.

### Known divergence: the depth boundary

At the same numeric limit, tsfga exhausts one dispatch earlier
than OpenFGA on most shapes. Upstream resolves the *terminal* hop
in place instead of dispatching for it: its weight-2 resolvers
require the target node to have weight 1 to the user type, which
is true only of the last hop. tsfga has no weighted relation
graph, so it dispatches for every hop.

At the default 25, an n-hop chain answers for `n <= 25` upstream
and `n <= 24` here; deeper, upstream answers where tsfga raises
`DepthExceededError`. The direction is conservative — tsfga
refuses where upstream answers — but it is a divergence.

**The offset is not uniform, which is why the budget is not simply
raised.** Give the leaf relation a second arm and it is no longer
weight 1, upstream declines its own resolver, dispatches for the
terminal hop as tsfga does, and the two agree exactly. A uniform
`+1` would make tsfga answer on that shape where upstream returns
`authorization_model_resolution_too_complex` — a *granting*
divergence introduced by a parity fix, which is worse than the
fail-closed one it would replace.

The correct fix is to implement upstream's weight computation, and
it is deferred to its own round. Both rows — the offset and its
absence on a weight-2 leaf — are pinned two-sided in
`tests/conformance/depth-boundary.test.ts`, so this goes red if
the gap widens or closes.

The same offset is visible through `listObjects`, where it costs
one *object* rather than one answer: on a 25-hop chain upstream
returns all 26 objects and tsfga returns 25, missing only the one
whose distance from the grant is the whole chain. A 24-hop chain
agrees exactly on both engines. See the section below for what
happens when the chain is much longer than the budget.

**Only hops to another object spend the budget.** Userset
expansion and tuple-to-userset expansion each cost one depth;
rewrites of the same object — `impliedBy`, `computedUserset`,
`excludedBy`, and intersection operands — cost none. This
matches OpenFGA, which increments resolution depth solely when
it dispatches to a child object. A rewrite ladder can therefore
be arbitrarily long without exhausting the budget; it is
bounded instead by cycle detection, since one object has a
finite set of relations. A budget of `maxDepth` admits a root
node plus `maxDepth - 1` dispatches.

- When the budget is exhausted, `check()` throws
  `DepthExceededError` — mirroring OpenFGA's "resolution too
  complex" error. Prior to 0.3.0 exhaustion silently resolved to
  `false`, which could fail open: a truncated `excludedBy`
  sub-check read as "not excluded" and granted access.
- **A cycle is not an error.** When the resolution path revisits
  a node it already contains, that subtree resolves `false`, and
  `check()` returns `false` to the caller. This matches OpenFGA,
  which errors only on depth exhaustion and returns
  `Allowed:false` with an internal `CycleDetected` flag for a
  cycle. tsfga tracks the same flag internally; like OpenFGA it
  is not exposed on the public result. See "Cycles and
  indeterminacy" below for why it is not simply a `false`.
- Union-style branches (direct, userset, implied_by, computed
  userset, tuple-to-userset) are resolved concurrently: a
  branch that resolves `true` wins even if a sibling branch
  threw `DepthExceededError` or was truncated by a cycle. If no
  branch grants and at least one errored, the error propagates.
- Exclusion (`excludedBy`) and intersection branches fail
  closed: an errored branch never counts as satisfied or as
  not-excluded. A definitive deny still short-circuits past a
  sibling error, matching OpenFGA — an intersection operand
  resolving `false`, or an exclusion branch resolving `true`,
  denies even when the other branch errored.
- Condition evaluation with missing declared parameters, or with
  a value that cannot be read as its declared type, is an error
  (`ConditionEvaluationError`), not an unmet condition — matching
  OpenFGA's check behavior. A silently-unmet condition would fail
  open through an exclusion branch.

  That error is held rather than raised while its **sibling rows**
  are still being read, and dropped if any of them had a condition
  that evaluated `true` — matching OpenFGA's filtered tuple
  iterator. A sibling whose condition evaluated `false` does not
  drop it; a sibling whose condition held but whose subtree denied
  does. Each read keeps its own decision, so a userset row that
  held does not rescue a broken direct row on the same relation.

  Values are coerced by a port of OpenFGA's converter table, not
  by a `typeof` check, which diverges on six cases. The numeric
  types accept numeric **strings** — JSON has no integer type, so
  upstream parses rather than asserts — while `duration` and
  `timestamp` accept **only** strings:

  | value | declared | verdict |
  |---|---|---|
  | `42`, `"42"` | int | accepted |
  | `4.5`, `"abc"`, `true` | int | refused |
  | `-1`, `"-1"` | uint | refused |
  | `"1.5"`, `1.5` | double | accepted |
  | `"1h"`, `"2h45m"` | duration | accepted |
  | `"1d"`, `3600` | duration | refused |
  | `"2026-01-01T00:00:00Z"` | timestamp | accepted |
  | `1700000000` | timestamp | refused |
  | `["a"]` | `list<string>` | accepted |
  | `[1]` | `list<string>` | refused |

  A context key the condition does not declare is accepted at
  check time and refused on write.

  **The numeric grammar is Go's, not JavaScript's.** Every numeric
  type is parsed upstream by `big.ParseFloat(value, 10, 64, 0)`,
  and the boundary is nowhere near `Number()`'s:

  | spelling | read as | note |
  |---|---|---|
  | `"0x10"`, `"0o10"`, `"0b10"`, `"1_000"` | refused | base 10 is explicit |
  | `" 42 "`, `"\n42"`, `""` | refused | no surrounding space |
  | `"1e3"`, `"1E3"`, `"4.0"`, `"5."`, `".5"`, `"1p3"` | accepted | `p` is a binary exponent |
  | `"Inf"`, `"+Inf"`, `"-Inf"`, `"inf"` | ±∞ (double) | `"Infinity"` and `"NaN"` are refused |
  | `"0.1"`, `"3.14"` | refused (double) | see below |

  An `int` is whatever parses to an integral value, so `"4.0"` and
  `"1e3"` are ints and `"4.5"` is not. Magnitudes outside int64
  saturate to its bounds — including for `uint`, whose ceiling is
  **int64**'s, because upstream converts every numeric string
  through the same `Int64()` and only then rejects a negative.

  A `double` carries one rule more: a decimal with no finite
  binary form is an error rather than the nearest double. `"0.1"`
  as a **string** is refused, while `0.1` as a **number** is
  accepted, since a number is already a `float64` and is asserted
  rather than parsed.

  The two engines ask that question at different precisions, and
  the difference is a measured divergence rather than a rounding
  detail. Upstream rounds the decimal to 64 significand bits and
  *then* asks whether the result converts to a `float64` — or, for
  `int` and `uint`, whether it is integral. tsfga asks it of the
  decimal exactly as written, at unbounded precision. They agree
  wherever the rounding moves the value, so `"0.1"` and
  `"1.0000000000000000001"` are errors on both sides; they part
  company below the half-ulp, where
  `"1.0000000000000000000000001"` rounds to `1.0` upstream and is
  read, and is refused here. See "Where tsfga and OpenFGA
  disagree" below.

  A `duration` takes Go's unit grammar plus the one unitless form
  its parser special-cases, a bare `"0"`. A `timestamp` takes RFC
  3339 with **uppercase** `T` and `Z` and any number of fractional
  digits.

### Known divergence: `listObjects` past the depth budget

`listObjects` checks each candidate forward, so a candidate
further from the grant than `maxDepth` allows is **absent from the
answer**. Upstream reports it. On a 40-hop parent chain upstream
returns all 41 objects; tsfga returns the 25 nearest the grant.

The cause is the one named in the depth-boundary section above —
upstream does not resolve `ListObjects` through `Check` at all. It
reverse-expands from the subject over a job queue
(`reverse_expand_weighted.go`), so a long chain costs it no
resolution depth. Closing the gap needs that reverse walk, which
is the same missing machinery as the depth boundary itself.

What tsfga does **not** do is lose the rest of the answer with it.
A candidate whose resolution exhausts the budget is dropped,
exactly as a candidate answering `false` is, and the call still
answers with the objects that qualify — up to
`listObjectsMaxResults`, below. Upstream's stated policy is
the opposite — a depth-exceeded candidate fails the whole
ListObjects (`ErrAuthorizationModelResolutionTooComplex`) — but
its boundary sits far enough out that it almost never reaches its
own abort, so dropping the candidate is closer to upstream on
every shape upstream can answer, and further from it only where
upstream genuinely aborts.

The policy is local to `listObjects`. `check` still raises
`DepthExceededError`, in every set position.

`DepthExceededError` is not the only class `listObjects` drops.
A `ConditionEvaluationError` raised on a read that does **not**
name the request subject is dropped the same way — the candidate
counts as `false` and the call answers. An error on a read that
*does* name the subject still aborts, because upstream's reverse
expansion always issues that read and would refuse too. Everything
else aborts the call in candidate order. Both drops run in the
under-reporting direction: nothing is granted that a full `check`
does not grant.

Pinned two-sided by `list-objects-depth-budget.test.ts` and
`list-objects-depth.test.ts`.

## A relation the subject's type cannot reach is denied

Before resolving a node's rewrite, tsfga asks whether a subject of
this *type* could hold `objectType#relation` at all — at any
depth, for any data. When it could not, the node answers `false`
without reading a tuple. This is upstream's
`typesys.PathExists(user, relation, objectType)` check, which
`LocalChecker.ResolveCheck` performs at every node.

The answer is computed from the relation configs alone, walking
*backwards* from the node: the subject refs a relation admits,
then the refs that reach those, and so on. It is memoized for the
life of a resolution scope, so a `listObjects` or `checkMany` call
pays for it once; a model changed between requests is picked up by
the next scope.

The prune never manufactures a denial the model did not prove. A
relation the model does not define still raises
`RelationConfigNotFoundError`, and any part of the walk that could
not be read — an undefined relation reached by a rewrite, a store
error — leaves the node unpruned rather than denied. A subject
type is reachable if either it or its typed wildcard (`user:*`)
reaches the node, matching upstream's retry.

Three shapes used to answer wrongly, all with one cause: tsfga
narrowed only at the node it was standing on.

| shape | before | now (and upstream) |
|---|---|---|
| a userset chain, unreachable, whose row carries a condition the request cannot evaluate | refused | `false` |
| the same chain longer than the depth budget | `DepthExceededError` | `false` |
| an unreachable cyclic subtree on the subtract side of a `but not` | `false` | `true` |

The third is the one that mattered: a cycle-truncated `false`
*denies* on the subtract side, so the prune returns a plain,
unflagged `false` — never a cycle. Nothing about the depth budget
or the cycle rules changed.

The prune reads relation configs the resolution would not
otherwise have asked for. They go through the same request-scoped
cache as every other config read, so each `objectType#relation`
costs at most one round trip per scope; see
[`@tsfga/kysely`](../kysely/README.md)'s pool-sizing section for
what that measures at on a large model.

### Each `tuple-to-userset` arm is its own union branch

A relation may have several tuple-to-userset paths
(`viewer from parent or viewer from owner`). Each is its own
branch of the relation's union, as upstream makes each `checkTTU`
its own child. One arm whose tupleset rows carry a condition the
request cannot evaluate raises only for that arm: a sibling arm
that grants still wins, and the error propagates only when nothing
granted. The per-read error rule is unchanged — an arm's condition
errors are still weighed against that arm's own rows, never
against another arm's.

## A userset can be the subject of a check

`CheckRequest` and `ListObjectsRequest` carry an optional
`subjectRelation`, which makes the subject a **userset** —
upstream's `object#relation` form of `TupleKey.user`:

```ts
await fga.check({
  objectType: "document",
  objectId: "550e8400-e29b-41d4-a716-446655440000",
  relation: "viewer",
  subjectType: "team",
  subjectId: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  subjectRelation: "member",   // team:…#member
});
```

The question is a **comparison, not an expansion**. The userset
holds `viewer` iff a row grants that exact userset, or a rewrite
of `viewer` reaches one. It is not a check for each member of the
team, and a member holding `viewer` by some other route does not
make the userset hold it.

Three consequences, each measured against v1.18.2:

| shape | answer |
|---|---|
| a relation admitting `[team#member]`, asked about the bare `team:eng` | `false` |
| a relation admitting `[team]`, asked about `team:eng#member` | `false` |
| a `team:*` row, asked about `team:eng#member` | `false` |

The third is not an oversight: a userset can never be a wildcard,
so upstream skips the public-assignability probe
(`shouldCheckPublicAssignable`) and the wildcard retry in
`PathExists` outright when the subject is a userset. tsfga does
both.

A userset holds its own relation on its own object by definition —
`team:eng#member` is a `member` of `team:eng` — ahead of the
model, and even where the relation admits no userset at all.
Upstream answers this in `IsSelfDefining`, between the cycle guard
and the relation lookup.

`listObjects` takes the same field and reaches the objects the
whole userset reaches.

### Some request shapes are refused rather than denied

The subject of a check is validated before any of it is resolved,
as upstream validates the `user` field at the command layer:

- a `subjectRelation` the subject's type does not define raises
  `RelationConfigNotFoundError` — upstream answers `relation
  'group#nonexistent' not found` rather than `false`;
- a `subjectType` the model defines no type for raises
  `InvalidSubjectTypeError` with
  `cause: "undefined subject type"`, **not**
  `RelationConfigNotFoundError`. The two are separate refusals
  because upstream's `ValidateUser` reports them separately and in
  that order: the `user` field's type is checked first, and only a
  subject that survives it has its userset relation resolved. So a
  userset subject naming an undefined type is refused for its
  type, and the relation is never looked up;
- a `subjectId` containing `:` or `#`, a `subjectRelation` that is
  empty, and a `subjectId` of `*` carrying a subject relation, all
  raise `InvalidSubjectTypeError` with
  `cause: "malformed subject"`. Upstream's `userIDRegex` is
  `^[^:#\s\x00\p{Cc}]+$`, so none of them is a subject there
  either.

`SubjectDefect` — what `InvalidSubjectTypeError.cause` carries —
therefore has two members, `"malformed subject"` and `"undefined
subject type"`, and a third state: `undefined`, which is the
ordinary "this relation does not admit that subject" refusal and
is deliberately causeless.

The second group closes a silent failure. Passing an
OpenFGA-shaped `user` string through `subjectId` — `subjectId:
"eng#member"` — used to resolve quietly to `false`, which a caller
cannot tell from a real denial. It now raises. **The ordering
differs between the two commands, and both orders are
upstream's:** `check` validates the subject first, then the
contextual tuples; `listObjects` validates contextual tuples, then
the target relation, then the subject.

The **write** path applies the same id rule. `addTuple` used to
accept a `subjectId` containing `:` or `#`, so such a row was
writable and — once the check gate landed — uncheckable. Both
gates now run the same predicate.

### Known divergence: the store's id domain

OpenFGA accepts any non-empty id with no control character and no
`#`, `:` or space. `café`, `alice` and a 300-character id are
ordinary ids there. A store may hold fewer of them than that, and
`@tsfga/kysely` on PostgreSQL does: its `object_id` and
`subject_id` are `uuid` columns.

So `TupleStore` declares an `idDomain`, and core refuses an id
outside it with `IdDomainError` — at the request boundary, before
any store read, on `check`, `checkMany`, `listObjects`,
`listSubjects`, `addTuple`, `removeTuple` and contextual tuples.

**The domain `@tsfga/kysely` declares is deliberately narrower
than the `uuid` column's own input grammar.** PostgreSQL accepts a
UUID uppercased, hyphenless, braced, or hyphenated oddly, and
stores all of them as one value — while OpenFGA treats each
spelling as a distinct id. Admitting more than the canonical
spelling would let a grant written for one answer `true` for
another. Only lower-case, hyphenated, 8-4-4-4-12 is admitted.
Nothing about the version or variant digits is checked: the nil
UUID is an ordinary id here, and that is the point — the typed
wildcard lives in a column of its own, so **no id value is
reserved**.

**Every refusal is in the refusing direction and none is in the
granting one.** A refused request is one no grant was computed
for. The read paths raise rather than answering `false`, which is
upstream's own shape: measured on v1.18.2, `Check` returns HTTP
400 for every id it cannot represent and never answers `false`. A
silent deny is indistinguishable from a real one, and the day an
identity provider changes its id format a fleet would lose access
with nothing reporting it.

The refused set is a class, not a list: **every id upstream admits
that is not a canonical UUID**.
`tests/conformance/id-domain.test.ts` pins representatives of
it, and `capability-refusals.json` carries the inventory entry
under `ID-DOMAIN-OUT-OF-DOMAIN`.

**Precedence: upstream's rules first.** An id can be malformed by
upstream's rules *and* outside the store's domain — every
malformed id is, since none of them is a canonical UUID — so a
request carrying both reports the upstream rule. `doc:*` reports
the typed wildcard; a subject holding `#` reports the malformed
subject; a well-formed `user:alice` is what is left over. The
domain gate also runs *before* the first question about the
model, because it is a rule about a string and upstream settles
every string question before it consults a type restriction.

This is a permanent, declared limitation of the store, not a bug
awaiting a fix. A store whose ids are opaque strings declares
`OPAQUE_IDS` and none of it applies.

## Cycles and indeterminacy

A cycle-truncated `false` means *no answer was reached*, not
*access is denied*, and the set operators read the difference:

| Position | A cycled branch behaves like |
|---|---|
| union branch | `false` — a granting sibling still wins |
| intersection operand | `false` — denies, it cannot be shown to hold |
| base of `but not` | `false` — denies |
| **subtract of `but not`** | **`true` — denies** |

The last row is the one that matters. Implementing "a cycle is
just `false`" makes `base:true but not subtract:cycle` grant,
because the truncated exclusion reads as "not excluded". OpenFGA
denies, and so does tsfga.

### Known divergence: recursive relations

OpenFGA has dedicated resolvers for *recursive* relation shapes
— a relation assignable to a userset of itself
(`define member: [user, group#member]`), or a TTU that recurses
on its own relation (`define viewer: [user] or viewer from
parent`). Those walk the reachable set iteratively, so a loop in
the data resolves to a definitive `false` with no cycle flag.
tsfga has a single recursive resolver and reports indeterminacy
there instead.

The only observable consequence is the subtract side of a
`but not`: given a looping recursive relation on the subtract
side and a base that grants, OpenFGA returns `true` and tsfga
returns `false`. Every other position agrees, because a plain
`false` and a cycled `false` behave identically there. tsfga is
the more conservative of the two — it denies where OpenFGA
grants — but this is a divergence, not a design choice, and it
will close if the recursive resolvers are implemented.

## Breadth limits

Branches of one resolution node are evaluated concurrently,
bounded by `maxBreadth` (default 10, via the same options
object as `maxDepth`). The default matches OpenFGA's default
`OPENFGA_RESOLVE_NODE_BREADTH_LIMIT` (10); pass
`maxBreadth: Infinity` to restore unbounded fanout. Bounding
breadth caps how many concurrent store reads a single wide node
can issue, which is useful to avoid saturating a connection pool.
It almost never changes the answer — see the exception below.
When several branches fail, which branch's error surfaces
depends on completion order — the same nondeterminism OpenFGA
has. Branches still queued when a node settles are never
started. `maxBreadth` must be an integer >= 1 or `Infinity`;
anything else throws `TsfgaError`.

**The exception: a cycle reaching an intersection operand.** An
intersection denies as soon as one operand fails to hold, and two
kinds of operand fail to hold — a definitive `false` and a branch
truncated by a cycle. The first to arrive decides, and it carries
its own indeterminacy out with the denial. One level up that
matters: on the subtract side of a `but not`, a cycle denies and a
plain `false` does not. So on a model where a cycle reaches an
intersection operand, which operand wins the race can change the
final answer, and breadth is what decides whether the operands
race at all.

This is upstream's behaviour, not a tsfga quirk: OpenFGA's
intersection short-circuits on the first `CycleDetected ||
!Allowed` outcome and propagates that outcome's flag, so its answer
tracks which operand is cheaper to resolve and its own concurrency
limit has the same exposure. Preferring the definitive `false`
would be deterministic and would diverge from OpenFGA — granting
where it denies. Matching upstream means racing as it races.
`tests/conformance/intersection-cycle-precedence.test.ts` pins both
directions against a live OpenFGA.

`maxBreadth` also bounds how many `listObjects` candidates are
checked at once — the same knob deliberately, following
upstream, whose ListObjects worker pool is sized at
`1 + resolveNodeBreadthLimit`.

**Breadth buys parallelism only if the store can execute
concurrently.** On a single pooled PostgreSQL connection — the
normal case for a request-scoped store, and unavoidable for one
bound to an open transaction — the driver serialises, so raising
breadth buys queueing rather than parallelism. It no longer costs
extra *work*: concurrent routes into the same node coalesce onto
one resolution (see below), so breadth is not a duplication
multiplier. But if your store cannot resolve reads in parallel,
the default of 10 gains you little, and `maxBreadth: 1` is a
reasonable setting. Measure before changing it.

## One resolution per node

The check graph is a DAG, not a tree: the same
`(object, relation)` is commonly reached by several routes, and a
deep permission chain funnels every route through the same few
nodes near the root of the hierarchy.

Each node is resolved once per check, whichever route gets there
first. A route arriving after another finished reads the settled
result; a route arriving while another is still resolving waits
for it rather than starting again. Both are request-scoped: no
result outlives the call it was computed in, so a check never
answers from data older than itself.

Two kinds of result are deliberately *not* shared, because they
are properties of the route rather than of the node: a subtree
truncated by a cycle, and a subtree that threw. Both are
re-resolved by the next route, matching what upstream's cached
resolver does with a cycle-detected response.

## Abandoned branches stop reading

When a union finds its grant, the branches still in flight are no
longer needed. They stop at their next checkpoint — entering a
node, a tuple-to-userset lookup, a condition evaluation — instead
of walking their subtree and querying a store the caller believes
it is finished with.

The one read that cannot be called back is the one already handed
to the store: tsfga does not put a cancellation token into
`TupleStore`. So a store may still see **one** read per abandoned
branch land after `check()` resolves. If you instrument your
store, drain its counters before reading them, or you will bill
one call's reads to the next.

## checkMany

`check()` builds its resolution scope per call, so two checks in
the same request share nothing and each pays for the whole walk.
`checkMany` runs a batch of requests in one scope: the
relation-config cache and the node memo span the batch, so the
part of the graph they have in common — usually most of it — is
resolved once.

```ts
const [canView, canEdit] = await fga.checkMany([
  { objectType: "document", objectId: docId, relation: "viewer", ...subject },
  { objectType: "document", objectId: docId, relation: "editor", ...subject },
]);
// → [{ allowed: true }, { allowed: false }]
```

- **Answers are in request order**, one outcome per request.
  Upstream's BatchCheck keys an unordered map on a
  caller-supplied correlation id; the array position is the same
  thing, without asking you for one.
- **A failing check does not fail the batch.** Its error is
  reported as `outcome.error` and `allowed` is `false`, matching
  upstream. `checkMany` itself throws only for invalid options.
- **Identical requests cost one resolution.** They coalesce at
  their root node, which is what upstream achieves by
  de-duplicating a batch on a cache key before dispatching it.
- **Concurrency is `maxConcurrentChecks`** (default 50, matching
  `OPENFGA_MAX_CONCURRENT_CHECKS_PER_BATCH_CHECK`). It bounds
  whole checks; `maxBreadth` bounds the branches inside one. There
  is no cap on batch size — upstream's
  `OPENFGA_MAX_CHECKS_PER_BATCH_CHECK` guards a server's request
  handler, and a library holds nobody's socket.
- **Pass one `context` object**, not an equal copy per request.
  Requests are grouped into one scope per context by reference
  identity, because the node memo does not key on the context and
  requests resolving over different contexts must not share one.
- **The scope is bounded by the call**, so it is safe inside a
  transaction: a tuple written earlier in the same transaction is
  visible to it. This is why a shared scope is offered rather than
  a tuple cache — a cache would hide that write.

## listObjects

`listObjects` takes a request object — `objectType`, `relation`,
`subjectType`, `subjectId`, and optionally `context` and
`contextualTuples` — mirroring upstream's `ListObjectsRequest`.

Contextual tuples are applied once to the whole call rather than
once per candidate, so every candidate sees the same overlay and
the shared node memo below still holds. They are validated exactly
as `addTuple` validates a write, before any candidate is checked,
and the objects they name join the candidate pool: an object no
stored tuple mentions is still an answer if a contextual tuple
puts the subject on it.

Candidates come from `listCandidateObjectIds`, which is only a
pre-filter: every candidate still goes through a full `check`.
All of those checks share one relation-config cache and one node
memo for the whole call, so a subtree common to many objects —
the folder behind a thousand documents — is resolved once rather
than once per object, and each relation config is read once
rather than once per object.

The returned array is in candidate order, not completion order.
That is a tsfga determinism choice rather than parity; upstream
streams objects in whatever order its pool finishes them.

The target relation is gated **before** the candidate pool is
read: a relation the model does not define raises
`RelationConfigNotFoundError`, the same error `check`, `checkMany`,
`listSubjects` and `addTuple` raise, rather than depending on
whether any row happens to name an object of that type. Contextual
tuples are validated first, because upstream orders the two gates
that way and the order is observable.

An error in any candidate otherwise fails the whole call. Which
error surfaces is deterministic: it is the first failing candidate
in *candidate* order, not the first to fail in wall-clock order.
No candidate after a failure is started. There are exactly two
exceptions, and both drop the candidate and keep the rest of the
answer:

- `DepthExceededError` — see "Known divergence: `listObjects` past
  the depth budget" above for why.
- a `ConditionEvaluationError` raised on a read that does **not**
  name the request subject. The reads that *do* name it — the
  direct row and the `subjectType:*` wildcard row — are the ones
  upstream's reverse expansion always issues, so an error there
  refuses on both engines and still aborts here. Every other read
  sits behind at least one hop, and upstream materialises it only
  if some path from the subject leads there; tsfga checks each
  candidate forward and cannot know, so it drops it. The residue
  is that where upstream's expansion does reach such a row it
  refuses the whole call and tsfga returns the partial list —
  under-reporting, never granting.

### `listObjects` truncates, silently

At most `listObjectsMaxResults` objects come back. It defaults to
**1000**, matching `OPENFGA_LIST_OBJECTS_MAX_RESULTS`, and
`Infinity` opts out. Upstream truncates silently — `ListObjects`
has no cursor and no field saying the answer was cut — and so does
this: a full answer and a truncated one are indistinguishable to
the caller. Two consequences, both shared with upstream:

- **Which** objects come back above the cap differs between the
  engines. Upstream keeps whatever its worker pool completed
  first; tsfga keeps the first `listObjectsMaxResults` granting
  candidates *in candidate order*. Compare counts, never
  membership.
- Reaching the cap **stops the producers**. Nothing further is
  launched, so a candidate past the cap is never resolved and can
  never raise. A call that answers is therefore not evidence that
  every object of the type is resolvable — only that the ones
  reported are.

The cap bounds the answer and never the gates: a relation with no
config is still refused, and a cap of `1` does not turn a refusal
into a one-element list.

## Relation configs gate the reads

Each node of a check wants up to three things about its object and
relation: a direct tuple for the subject, a `type:*` wildcard
tuple, and the userset rows. They are asked for **in one store
call**, `findCheckTuples`, because they share an object, a
relation and a plan — three separate queries cost three
round-trips and, on a single-connection handle, three serialized
ones.

A part is left out of the query when the relation config says
nothing it could find would be valid:

| Part | Left out when |
|---|---|
| direct probe | `directlyAssignable` omits the subject type |
| wildcard probe | `directlyAssignable` omits `subjectType:*` |
| userset scan | `directlyAssignable` has no `type#relation` entry |

All three parts are narrowed rather than switched: the query
carries the restrictions the relation admits, so a relation
admitting `team#member` never asks for — and never expands — a
`team:eng#owner` row. The refs are a hint the store may use to
narrow its query; the guarantee is that the reply is re-clamped
against the same list, so a store that over-returns loses rows
rather than smuggling them past the model.

`null` and `[]` are opposites on all three: `null` declines to
narrow, `[]` excludes the part. Core no longer sends `null` — a
relation with no config is refused before anything is read, so
every query carries the relation's own restrictions — but the
fields stay nullable, because "I did not narrow this part" is a
statement a wrapper may still need to make about a query it
forwards.

### The gate is wider than the clamp, deliberately

The restriction's condition is matched too, and that splits what
used to be one predicate in two. The read gate runs *before* the
row exists and the condition lives *on* the row, so the gate can
only match the subject's shape — type, wildcard, userset relation
— and asks for every restriction of that shape, conditioned or
not. `clampToQuery` then performs the exact four-field match on
the reply, before the check algorithm sees a row.

So the invariant is not that the read gate and the write gate
agree. It is:

```
readGate ⊇ writeGate     and     clamp ≡ writeGate
```

The ordering is externally observable rather than a matter of
taste: a row the model does not admit must be dropped before
anything evaluates its condition, or a missing context parameter
raises where OpenFGA answers `false`.

With all three ruled out there is nothing to ask, and the node
skips the store entirely — it still resolves through its rewrites.
That is how a purely computed relation is expressed: an empty
`directlyAssignable` says the relation admits nothing directly,
and no read is issued.

A part is left out only on a *positive* exclusion. A relation with
no config at all is not read at all: `check` raises
`RelationConfigNotFoundError` for it, exactly as `addTuple` does,
rather than reading the absence as "unrestricted". The gate is
the same predicate `addTuple` applies, so a tuple that can be
written is always a tuple that can be found.

**This makes relation configs load-bearing rather than
advisory.** A tuple written straight to the database, bypassing
`addTuple`, or left behind by a relation that has since narrowed
its type list, is no longer found by `check` — it is treated as
the invalid row it is. Previously it would have granted access.
This matches OpenFGA, whose reads are typed and which rejects
such a tuple at write time; the failure direction is closed, not
open.

The config for a relation is read once per request and cached, so
this ordering costs one round-trip per relation, not per node.

### Applying the same gate yourself

`admitsSubjectRef` and `directSubjectRef` are exported so a
consumer narrowing their own query can apply the gate tsfga
applies rather than reimplementing it and drifting out of step.

```typescript
import { admitsSubjectRef, directSubjectRef } from "@tsfga/core";
```

<!-- sample: gate-predicate -->
```typescript
const config = await store.findRelationConfig("document", "viewer");
// No config means the model does not define the relation, which
// `check` refuses rather than treats as unrestricted. The
// predicate takes it non-null so the same decision is yours to
// make here.
if (config === null) throw new Error("document.viewer is not configured");
// The fourth argument is the condition name. Passing null asks
// whether the relation admits `team#member` *unconditioned* --
// a relation admitting only `team#member with in_hours` will
// say no, which is the answer `check` gives too.
admitsSubjectRef(config, directSubjectRef("team", "eng", "member", null));
```

Two things to know before relying on it:

- **The config is not optional.** It used to be, answering `true`
  for `null` because that is what `check` did. Both are gone:
  `check` raises `RelationConfigNotFoundError` on a relation with
  no config, so the misspelled relation name that used to make the
  filter silently admit everything is now a `null` the compiler
  makes you handle.
- **It filters tuple *shapes* only.** It knows nothing of
  `excludedBy` or `intersection`, which revoke a grant after the
  row is read. A row it admits is one `check` will *consider*, not
  one `check` will allow. There is no substitute for `check`.

## Listing subjects

`listSubjects` applies the same type restrictions, so a subject it
reports is one `check` could act on rather than merely one that is
stored. Narrowing a relation does not revalidate the tuples
already written, so inadmissible rows are an ordinary state to be
in, and reporting them was a divergence: OpenFGA filters in Expand
and ListUsers for the same reason.

A relation with no config raises `RelationConfigNotFoundError`
here too, rather than reporting every stored row. `check` refuses
such a relation, and a `listSubjects` that reported subjects
`check` will not act on is the same divergence in the granting
direction.

The consequence is worth stating plainly: **there is no library
path that finds an inadmissible row in order to delete it.**
Upstream keeps `Read` unfiltered for exactly that reason. Until a
maintenance read exists, removing such rows means going to the
store directly.

`listObjects` is deliberately *not* gated at the candidate stage.
It re-checks every candidate through the gated path, so
over-returning candidates costs work and cannot grant, whereas
under-returning would silently drop objects the subject can
really reach.

## Contextual tuples

Contextual tuples passed on a `CheckRequest` are validated
against relation configs with the same rules as `addTuple`: the
relation config must exist, and the subject ref — the bare type,
`type:*` for a wildcard subject, or `type#relation` for a userset,
each with the tuple's condition — must appear in
`directlyAssignable`. Invalid contextual tuples throw
`RelationConfigNotFoundError`, `InvalidSubjectTypeError` or
`InvalidConditionalTupleError`.

### What an error message says, and what it does not

`InvalidSubjectTypeError` names the subject that was refused and
the relation that refused it, and nothing else. It does **not**
enumerate what the relation admits, because `addTuple`'s errors
are the ones a service is most likely to hand back to whoever
attempted the write, and that list describes the authorization
model: every admitted type, every userset relation, every
condition name. OpenFGA names only the offending type.

The list is still reachable, on the error rather than in the
string:

| field | what it holds |
|---|---|
| `subject` | the subject ref the write named |
| `objectType`, `relation` | what refused it |
| `allowed` | every `TypeRestriction` the relation admits |

## Write-time model validation

OpenFGA validates a whole model when it is written. tsfga has no
model document, so the same rules are applied where the pieces
arrive.

`writeRelationConfig` throws `InvalidRelationConfigError`, with
the reason on `.cause`:

| cause | meaning |
|---|---|
| `malformed type name` | the object type's own name fails upstream's proto pattern `^[^:#@\s]{1,254}$` — one cause for both `type_invalid_pattern` and `type_invalid_length`, because upstream's split is between two constraints on one field |
| `malformed relation name` | the same pattern on the relation field, under a bound of 50 |
| `malformed condition name` | the same pattern and bound again, on `writeConditionDefinition`'s `name` |
| `malformed condition parameter name` | the same, on every key of `parameters` — a separate loop, so the detail names the offending key |
| `reserved keyword` | the type's or the relation's name is `self` or `this`; upstream's `validateNames`, which looks at those two names and nothing else — a *condition* named `self` is stored |
| `intersection has fewer than two operands` | a set operation with one child or none; upstream: "as intersection has less than 2 children" |
| `undefined condition` | a type restriction names a condition the store has not got |
| `tupleset relation admits a userset` | the relation a tuple-to-userset reads is assignable to `type#relation` |
| `tupleset relation admits a wildcard` | that relation is assignable to `type:*` |
| `tupleset relation is not a direct relation` | the relation named as `tupleset` rewrites at all; upstream requires its rewrite to be exactly `This` |
| `type restrictions on a non-assignable relation` | `directlyAssignable` is non-empty on a relation whose `intersection` has no `direct` operand |
| `relation admits nothing and rewrites nothing` | the relation can never grant |
| `relation has no entrypoint` | the closed self-cycle form; see below |
| `rewrite cycle` | the rewrites lead back to a relation already on the path; upstream: "an authorization model cannot contain a cycle" |

Four of those read as stronger than they are without a
qualifier:

- **`relation admits nothing and rewrites nothing` is not
  "`directlyAssignable: []` is refused".** An empty list beside a
  rewrite is how a purely computed relation is spelled. The defect
  is an empty list with *no* rewrite either.
- **`type restrictions on a non-assignable relation` fires only
  against an `intersection` with no `direct` operand.** The
  converse is ordinary: `directlyAssignable` beside `impliedBy`,
  `computedUserset`, `tupleToUserset` or `excludedBy` is
  upstream's `union(This, …)` and `difference(This, …)`, both
  valid.
- **`rewrite cycle` follows rewrites on the same object type
  only.** Every `impliedBy` arm, the `computedUserset`, the
  `excludedBy` and every `computedUserset` intersection operand.
  Direct assignment and `tupleToUserset` are not followed, because
  upstream's own walk stops at both: `viewer: viewer from parent`
  names this relation on *another* object and is the commonest
  shape a model has. A target whose config has not been written
  yet is skipped, for the write-order reason below — so the rule
  is weaker than upstream's in the accepting direction, never the
  refusing one. The depth-1 case, `viewer: viewer`, is reported as
  `rewrite names its own relation` instead, which is the cause
  upstream reports for it.
- **`relation has no entrypoint` is the closed case only.** An
  entrypoint is a whole-model property, and upstream decides it
  over one document. A single config decides only the relation
  whose *sole* arm is a tuple-to-userset onto **itself**, over a
  tupleset admitting its own object type and nothing else
  (`define viewer: viewer from parent`, `parent: [doc]`). Any
  second arm is an entrypoint, and a tupleset admitting some other
  type is not a cycle — that type's relation may have one. The
  general rule stays open.

The table is the set of causes a config or condition write raises
today, not the whole of `RelationConfigDefect`. The union also
declares `rewrite names its own relation`, described below with
`rewrite cycle`, and two more that **nothing raises yet** —
`computed relation undefined on every tupleset type` and
`undefined relation` — for the reason in the gap below. They are
declared so the union does not change shape when a whole-model
validator arrives. `errors.ts` is the source of truth for the
union; read it before matching on `.cause` exhaustively.

Two of them close fail-open shapes. `intersection has fewer than
two operands`: a single-operand intersection resolved to whatever
that operand said. `tupleset relation admits a userset`: such a
row had its subject relation discarded on dispatch, landing on a
different relation of the linked object and granting.

**The three tupleset rules have a stated gap** — `tupleset
relation admits a userset`, `tupleset relation admits a wildcard`
and `tupleset relation is not a direct relation`. They are
properties of a
*different* relation than the one being written — the one named as
`tupleset` — so they can only be checked when that relation's
config already exists. A tuple-to-userset declared **before** its
tupleset relation is not validated, and neither is a later
widening of that relation. Closing either would need a reverse
lookup (*which configs name me as a tupleset?*) that `TupleStore`
does not have. A validator that fired on write order would be
worse: it would refuse correct models for arriving in an order
nothing documents. Conditions have no such gap — define them
before the configs that name them, which is the order upstream's
atomic model write imposes anyway.

**Two further rules are open for a harder version of the same
reason.** Upstream also refuses a rewrite naming a relation the
object type does not define, and a tuple-to-userset whose computed
relation **no** tupleset type defines. Neither can be decided from
one config: for a forward reference the premise is *always*
absent, so the "skip when the premise is not yet written" rule
above degenerates into never checking, while checking strictly
refuses correct models. Both rules were implemented warn-only and
run over the whole conformance corpus: they fire on 43 config
writes that are not defects, every one an ordinary model whose
relations are written in definition order rather than dependency
order (`viewer: a but not banned` before `banned`; `blocked:
nblocked from parent` before `nblocked`). Both belong to a
validator that sees the whole model at once — a batch config write
— and until there is one, the mistake is reported at check time
instead, where it raises `RelationConfigNotFoundError` and blames
the request rather than the model.

### Which refusals are accounted for

The rules above are one half of a gate, and the question a
consumer actually has is the other half: *which refusals does
OpenFGA make that tsfga does not?*

`packages/core/write-gate-causes.json` answers it. It enumerates
every refusal OpenFGA v1.18.2 constructs in the seven Go files
carrying its write- and model-write refusal vocabulary, and
disposes of each one: implemented by a named rule, implemented
partly with the gap written out, pinned as a divergence with the
test that pins it, open with the reason it is open, or
inapplicable with the reason. The enumeration is mechanical, and
its recall over those files is enforced on every CI run — each of
the 107 error-construction sites in them is attributed to a cause
or listed as an exclusion with a reason, and an unattributed one
fails the build.

**What it does not claim.** It does not audit whether a rule's
body is a correct port of the cause it claims; those dispositions
are decided once, by hand, and reviewed. It does not cover the
protobuf field constraints, which live in a Go module the
enumeration cannot read — those are entered by measurement
against the running container, and their completeness is not
claimed. What it does do is go red when the pinned container
moves, when upstream adds, removes or renames a refusal, and when
a reference in it stops resolving.

**Every rule has a name, and the error carries it.**
`TsfgaError.ruleId` is the id of the rule that refused —
`"TUPLE-SUBJECT-MALFORMED"`, `"CONFIG-REWRITE-NAMES-ITSELF"` — or
`null` when the error is not a write refusal. `UPSTREAM_RULE_IDS`
and `CAPABILITY_RULE_IDS` are exported, so a consumer can switch
on a refusal without matching message prose, and can tell a
parity refusal from one of tsfga's own.

The ids are names, not an order. The rules stay where they are in
the source and their precedence is the order of the statements
that raise them; what an id buys is that a test can assert *which*
of two competing refusals won, which is the only way precedence is
observable at all.

**Refusals in the other direction get their own list.**
`packages/core/capability-refusals.json` records refusals tsfga
makes that OpenFGA does not. They are divergences rather than
parity, and each carries a test that fails if the divergence ever
disappears. Two lists rather than one list with an exception:
inside a single bijection, any future rule could opt out of the
completeness argument by declaring itself special.

`addTuple` throws `ImplicitTupleError` for a tuple that says only
what the model already says — `doc:1#blocked@doc:1#blocked`.
Upstream refuses it: "cannot write a tuple that is implicit".

**On the write path only.** The same tuple supplied as a
*contextual* tuple is accepted upstream and answered over, so the
gate is deliberately not in the validation `addTuple` and
contextual tuples share. Both halves are pinned two-sided.

## Duplicate writes

`addTuple` throws `DuplicateTupleError` when the tuple is already
stored — upstream's `on_duplicate` default of `"error"`. It used
to upsert.

The natural key is upstream's `TupleKeyWithoutCondition`: object
type, object id, relation, subject type, subject id, subject
relation. **The condition is not part of it.** Re-granting a live
edge under a different condition is therefore a duplicate, not a
second row, and the way to change a grant's condition is
`removeTuple` then `addTuple`, in that order — which is what
OpenFGA requires. The upsert was silent and widened as readily as
it narrowed: dropping a condition turned a time-boxed grant
permanent.

Upstream's `on_duplicate: "ignore"` opt-in is not offered. A
caller that wants the old absorb-the-duplicate behaviour catches
`DuplicateTupleError` and ignores it.

## Deleting a tuple that is not there

`removeTuple` throws `MissingTupleError` when no such row exists,
and returns `Promise<void>`. Upstream's `on_missing` defaults to
`error`, so a delete of an absent row is
`write_failed_due_to_invalid_input` rather than a quiet no-op —
tsfga answered `false`, which encoded an outcome OpenFGA has no
word for.

A caller that wants the old behaviour catches it:

```ts
try {
  await fga.removeTuple(key);
} catch (error) {
  if (!(error instanceof MissingTupleError)) throw error;
}
```

**A malformed delete throws first.** `removeTuple` applies
upstream's *syntactic* delete validation — `IsValidUser` on the
rendered subject, the 512-byte subject bound, the
`^[^\s]{2,256}$` object bound, and the
`^[^:#@\s]{1,50}$` relation pattern on a non-empty relation. That
is the whole of it.

**It applies no model validation at all, deliberately.** Upstream
does not either: `WriteCommand`'s delete loop is one `IsValidUser`
call and a `TODO`. So an undefined relation, an undefined type,
and a subject type the relation does not admit all reach the row
and report `MissingTupleError` if it is absent. That is what makes
a bad model change recoverable — a row written under a model that
defined `editor` is still deletable under one that does not. A
delete gate built out of the write validators would strand those
rows permanently.

The subject predicate is genuinely a different one, not the write
path's narrowed: `IsValidUser` is a union over the bare wildcard,
a user id, an object and a userset, so `user:a#b` is a legal
delete key and an illegal write key.

### Malformed subjects

A subject ref that is not well formed at all — `team:*#member`, a
wildcard id carrying a subject relation — raises
`InvalidSubjectTypeError` with `cause: "malformed subject"`,
**before** the type gate, because upstream refuses it in
`ValidateUser` before any type restriction or condition is
consulted and the order is observable. It presented as the userset
`team#member` before, so a relation admitting `team#member`
accepted it and stored a row no model can describe. When the cause
is set the message takes a different form — `Invalid subject for
<type>.<relation>: malformed subject` — because rendering the
shape would print `team#member` and name a userset the caller did
not write. For every other refusal the cause is `undefined` and
the message is unchanged.

## TupleStore interface

The `TupleStore` interface is the extension point for custom
database adapters. The core check algorithm depends only on
this interface — it has no database dependencies.

Its read surface is deliberately shaped around what a check
actually asks for, not around individual predicates. The one to
understand when writing an adapter is `findCheckTuples`: it takes
a `CheckTuplesQuery` (the node, plus which restrictions each of
the three parts may be served under) and returns a `CheckTuples`
(`direct`, `wildcard`, `usersets`). Both types are exported.
Serving it as one query is the single largest thing an adapter
can do for check latency; an implementation may run three
instead, and simply gives that up.

The `directRefs`, `wildcardRefs` and `usersetRefs` fields exist so
a store can **narrow** its query — that is where the saving is.
Each carries the type restrictions the relation admits for that
part, so a row the model cannot admit need never be fetched. On
all three, `null` declines to narrow and `[]` excludes the part
outright; reading `[]` as "no filter" answers a query that asked
for nothing with a full scan.

They are a hint, not a trust boundary: `check` re-clamps every
reply against the query it sent — the exact match on type,
subject relation *and* condition — so returning a part that was
not asked for, or a row under a restriction the relation does not
admit, or filing a row under the wrong slot, loses that row. An
adapter bug cannot widen what the model admits, only lose grants
it should have found.

On the write side, `insertTuple` **inserts and reports**: it
returns `true` when a row was written and `false` when the natural
key already existed, and on `false` nothing may be written — the
stored row keeps the condition and the context it already had. It
used to mean upsert, and a store that can only upsert cannot
implement upstream's default; `TsfgaClient.addTuple` turns the
`false` into `DuplicateTupleError`.

### A store declares which ids it can hold

`TupleStore` has a required `idDomain`. OpenFGA admits any
non-empty id with no control character and no `#`, `:` or space; a
store may hold fewer than that, and a store keeping its ids in a
`uuid` column holds very many fewer.

```ts
import { OPAQUE_IDS, type TupleStore } from "@tsfga/core";

class MyStore implements TupleStore {
  readonly idDomain = OPAQUE_IDS;
  // ...
}
```

`OPAQUE_IDS` admits everything and is the right answer for a store
whose ids are strings — it is one line, and it is what every
existing adapter needs. `CANONICAL_UUID_IDS` is the other one
shipped: exactly 8-4-4-4-12 lower-case hexadecimal digits.

There is no default and no absent-means-opaque third state.
Absence would compile silently for exactly the population that
most needs to be told, and a store that never says what it can
hold reports its refusals as a driver error from three layers
down.

**A declared domain can only narrow, never widen — so there is no
clamp here, and the absence is deliberate.** Elsewhere a store's
reply is a hint that core re-applies the model to. This is the one
place a store says something core takes at its word, and it is
safe to, because both mistakes fail in the refusing direction: a
store declaring `OPAQUE_IDS` over narrow columns gets its own
driver errors back, exactly as it does today, and one declaring
narrower than its columns refuses requests it could have served.
Neither grants.

### The two write methods take a branded argument

`insertTuple` takes a `GatedTuple` and `upsertRelationConfig` a
`GatedRelationConfig`. Both are `AddTupleRequest` and
`RelationConfig` with a phantom property no value carries, minted
inside this package only after the corresponding validator has
run. An adapter declares the branded types on its own methods —
both are exported — and is otherwise unaffected: the brand erases
at emit, so nothing changes at runtime.

The point is the *caller*. `KyselyTupleStore` is exported with a
public `insertTuple`, so a seeding script or a backfill could
write a row `addTuple` refuses. That is not hypothetical: two such
rows produce `check → true` for a permission no OpenFGA store can
represent, and it compiled against the published package.

This is the read-side rule pointed the other way. A store's reply
is a hint and `clampToQuery` re-applies the model to it; a store's
*input* is likewise not where the model is decided, and the
compiler is what says so, because there is nothing to check at the
sink — the value's shape is fine, and what makes it legal is that
it went through the validator.

**Two limits, both real.** TypeScript's method parameters are
bivariant, so a third-party store declaring the unbranded
parameter still satisfies `TupleStore`; the compiler will never
demand the brand of an adapter author. And a brand is not a lock:
it erases at emit, so plain JavaScript is unaffected and anyone
writing `as` gets what they asked for. What closes is the
accidental path, which is the one that was measured.

Slots are exact. `direct` is the tuple for this subject with no
subject relation, `wildcard` the one for `subjectType:*` likewise,
and every row in `usersets` has a subject relation. A minimal
correct implementation may leave every field `null` and return
all three parts; it just gives up the saving.

See
[`src/store-interface.ts`](src/store-interface.ts)
for the full interface definition.

[`@tsfga/kysely`](../kysely/README.md) provides the included
PostgreSQL adapter.

## Conditions

A condition is a CEL expression, stored by name, evaluated on
every tuple that carries one. This is the one section about CEL:
what is unsupported, what is validated at write, what agrees, and
every measured place the two engines part company.

### `matches()` is not supported

**tsfga has no regular-expression support.** A condition whose
expression calls `matches()` is refused when you write it:

```
ConditionCompileError: undeclared reference to 'matches'
```

OpenFGA supports it. This is the largest deliberate difference
between the two, it is permanent, and it is first here because it
is the one most likely to affect you — if you are porting a model
from OpenFGA and any condition uses `matches`, that model will not
load.

**What to use instead.** Most real patterns are a prefix, a
suffix, a substring or a membership test, and all of those are
supported and behave identically on both engines:

| instead of | write |
|---|---|
| `s.matches("^ward-[0-9]+$")` | `s.startsWith("ward-")` |
| `s.matches("^https://hooks[.]acme[.]io/")` | `s.startsWith("https://hooks.acme.io/")` |
| `s.matches("@eu[.]example$")` | `s.endsWith("@eu.example")` |
| `s.matches("^sev-[1-3]$")` | `s in ["sev-1", "sev-2", "sev-3"]` |
| `s.matches("^dev-[0-9a-f]{8}$")` | `s.startsWith("dev-") && size(s) == 12` |

These are narrower than the patterns they replace. That is the
trade, and it is deliberate: a condition is a narrowing device,
and a predicate you can read at a glance is worth more in an
authorization rule than one you cannot.

If your rule genuinely needs a regular expression — validating a
user-supplied format, say — do it in your application before the
check, and pass the result to the condition as a boolean.

**Why.** tsfga evaluates CEL with
[`@marcbachmann/cel-js`](https://github.com/nicholasgasior/cel-js);
OpenFGA evaluates it with cel-go, whose `matches()` is RE2.
cel-js's is a JavaScript `RegExp`. The two are different languages
that share a syntax, and the differences do not fail loudly:

- `[[:alnum:]]` is a character class in RE2 and, in JavaScript,
  the seven literal characters `[ : a l n u m` — so an email
  allow-list silently stops matching and access disappears with no
  error anywhere.
- `[^]` is a syntax error in RE2 and matches **any character
  including newline** in JavaScript — so a pattern written as a
  whitelist admits everything.
- `^(a+)+$` is linear in RE2 and exponential in JavaScript:
  measured on V8, 5.2 seconds for a 30-character input, 20.9
  seconds at 32, and longer inputs did not finish.

An earlier release papered over this with a pattern translator. It
was a second regular-expression implementation owned by this
project, in the path of every authorization decision. Rather than
keep it, or replace it with a validator that would have caught
some of these and not others, the feature was removed. The full
analysis, including the measured backtracking curves on three
runtimes and the complete RE2-versus-cel-js gap table, is checked
in under [`docs/cel-js/`](../../docs/cel-js/).

### How a condition is handled

`writeConditionDefinition` stores the expression, **compiles** it,
and **type-checks** it against its declared parameters — which is
what OpenFGA's model write does, with
`cel.EagerlyValidateDeclarations(true)`. An expression that cannot
be parsed, that names a function cel-go does not declare, or that
does not type-check never reaches a check. Without this it was
accepted three times over: the definition write, every tuple write
beneath it, and every check until someone ran one.

At check time, context arrives from the tuple and from the request
with **tuple context taking precedence**, values are read as their
declared parameter types using OpenFGA's own conversion grammar,
and a row whose condition is false is not a grant.

Compiled expressions are cached by expression source text
(content-keyed). Redefining a condition therefore takes effect on
the next evaluation — there is no per-name cache to go stale — and
identical expressions share one compiled entry. The cache holds a
thousand entries and evicts the least recently used. The type
check is **not** cached with the expression: it belongs to the
definition, so two conditions sharing an expression and declaring
different parameters are each checked.

Besides `matches()`, tsfga **refuses** in three places, and only
three: a condition naming a function OpenFGA does not declare is
rejected at write, as OpenFGA rejects the model; an expression
that does not type-check against its declared parameters is
rejected at write; and an evaluation past
`maxConditionEvaluationCost` is refused at check. Refusing is not
emulation — it is how tsfga avoids answering `true` where OpenFGA
would not answer at all.

`addTuple` refuses a tuple whose condition the model cannot
accept, with the cause on `InvalidConditionalTupleError.cause`:

| cause | meaning |
|---|---|
| `condition is missing` | no condition, and every matching restriction has one |
| `invalid condition for type restriction` | a defined condition this relation does not name |
| `undefined condition` | no such condition in the store |
| `parameter type error` | a context value not readable as its declared type |
| `invalid context parameter` | a context key the condition does not declare |
| `context contains forbidden characters` | a Unicode control character in a context key, in a string value at any depth, or in the condition name |
| `context size limit exceeded` | a condition context over `writeContextByteLimit` |

Only the context keys actually **present** are validated. A
conditioned tuple with no context, or a partial one, is accepted:
the rest can arrive with the check request.

A tab is a control character and is refused — worth stating,
since it is the one a caller might send without meaning anything
by it. The name is scanned before the definition is looked up, so
a dirty condition name reports the characters rather than
"undefined condition", which is upstream's order.

The size rule has two qualifications. **It is upstream's rule but
not upstream's measure:** upstream sizes a serialised protobuf
`Struct` against `DefaultWriteContextByteLimit` (32 KiB); tsfga
sizes the UTF-8 bytes of the context's JSON, which cannot be made
exact, so the two agree except within a narrow band of the
boundary. The limit is `writeContextByteLimit` on `CheckOptions`,
defaulting to the exported `DEFAULT_WRITE_CONTEXT_BYTE_LIMIT`.
**And it applies to `addTuple` only:** upstream enforces it in the
Write command and nowhere else, so a check request whose
contextual tuple carries a large context is answered, not refused.

A conditioned write costs one extra round-trip — the
condition-definition lookup — so 3 rather than 2. Unconditioned
writes are unchanged. That is deliberate and uncached: a
client-lifetime cache on a *validation* gate goes stale across
processes, and would keep accepting tuples after another instance
narrowed the model.

### What agrees

The core of the language does. Booleans and logical operators,
`int` / `uint` / `double` / `string` / `bool` comparison and
arithmetic within range, list and map membership (`in`), field
access, `size()`, `has()`, the ternary, the comprehension macros
(`all`, `exists`, `exists_one`, `filter`, `map`), the string
members `contains` / `startsWith` / `endsWith`, timestamp and
duration construction, comparison and arithmetic at millisecond
resolution or coarser with the whole accessor family, and the
parameter-type coercion of every value reaching a condition from a
tuple or a request.

A `uint` parameter is carried as CEL's `uint` — cel-js's
`UnsignedInt` — so `type(n) == uint`, a bare `u`-suffixed literal,
and arithmetic bounded by **uint64** rather than int64 all agree
with upstream. Saturation is worth stating: a `uint` context value
saturates at **int64**'s ceiling, not uint64's, because upstream
converts every numeric string through the same `Int64()` and only
then rejects a negative. A mixed-type comparison such as `n >= 7`
on a `uint` parameter is refused by OpenFGA at model-write time,
so those cells are unreachable in a valid model.

That covers what conditions are normally for: an expiry, a
business-hours window, an IP or tenant allow-list expressed as a
list membership, a numeric threshold, a flag.

### Where tsfga and OpenFGA disagree

Read the **direction** first; it decides whether a divergence is
an inconvenience or a security problem.

| Direction | What happens | How bad |
|---|---|---|
| **Refusing** | OpenFGA answers, tsfga raises | Access is lost, loudly. Your caller sees an error. |
| **Different boolean** | Both answer, the answers differ | Quiet. Usually denies. |
| **Granting** | OpenFGA refuses the model or declines to answer, tsfga returns `true` | **The one to read twice.** tsfga grants where upstream would not. |

The table is short, and it is short because `matches()` was
removed rather than repaired — most of what used to be here was
regex. The row that matters most is not in it at all, because it
is not a subtle disagreement: **a condition using `matches()` is
refused outright.**

*Measured against `@marcbachmann/cel-js` 8.0.0 and OpenFGA
v1.18.2. If you have overridden or forked either, this table does
not describe your build.* Every cell is pinned two-sided in the
conformance suite, so if either engine changes a test says so
rather than this table quietly going stale. The table names the
families that have been measured; it is **not a proof of
completeness**, because the divergence set is "wherever cel-js
differs from cel-go" and nobody has enumerated that.

**Granting.** cel-go range-checks every arithmetic and conversion
overload; cel-js checks binary `+`, `-` and `*` on ints and `-` on
uints, and nothing else.

| expression | context | OpenFGA | tsfga |
|---|---|---|---|
| `int(x) > 0` | `x = 1e19` | refused | `true` |
| `int(x) < 0` | `x = -1e19` | refused | `true` |
| `double(s) > 0.0` | `s = "1e400"` | refused | `true` |
| `double(s) < 0.0` | `s = "-1e400"` | refused | `true` |
| `-n > 0` | `n = int64min` | refused | `true` |
| `n / -1 > 0` | `n = int64min` | refused | `true` |
| `d + duration('2400000h') > d` | `d = 2400000h` | refused | `true` |
| `duration('-2400000h') - d < d` | `d = 2400000h` | refused | `true` |
| `s < '\u{1F600}'` | `s = U+1F600` | `false` | `true` |
| `n == timestamp('…T00:00:00Z')` | `n = …00.000000001Z` | `false` | `true` |
| `n == timestamp('…T00:00:00Z')` | `n = …00.000001Z` | `false` | `true` |

And three at the **write** moment, where the model is what
diverges rather than the answer:

| expression | declared | OpenFGA | tsfga |
|---|---|---|---|
| `int(b) > 0` | `b: bool` | model refused | definition stored |
| `duration(i) > duration('1s')` | `i: int` | model refused | definition stored |
| `b.size() > 0` | `b: bool` | model refused | definition stored |

Each names a call **both** engines declare with an argument type
**neither** overloads. cel-js reports that the same way it reports
the five overloads cel-go has and it does not, and tsfga cannot
tell the two apart without transcribing cel-go's declaration table
— which is the second-CEL-implementation shape this project does
not build. The check that reads such a definition refuses on both
sides, so nothing can be granted on one.

**Refusing.** Five overloads cel-go declares and cel-js does not.
The definition is stored — refusing the write would refuse a model
upstream accepts — and every check that reads it raises.

| expression | declared | OpenFGA | tsfga |
|---|---|---|---|
| `int(n)` | `n: uint` | answers | refused |
| `int(d)` | `d: duration` | answers | refused |
| `int(t)` | `t: timestamp` | answers | refused |
| `string(d)` | `d: duration` | answers | refused |
| `string(t)` | `t: timestamp` | answers | refused |
| `ip.in_cidr(cidr)` / `ipaddress(s)` | — | answers | refused |

These are **per-branch**: cel-js short-circuits, so
`int(d) > 3600 || role == 'admin'` still answers `true`.

**Four more refusals, none of them a missing overload.** They are
grouped here because the direction is the same — upstream answers
and tsfga does not — but the *cause* differs in each, and the
cause is what tells you whether it will ever be closed.

| expression | context | OpenFGA | tsfga |
|---|---|---|---|
| `l.exists_one(x, x == 'zz')` | `l` = 25 non-matching strings | `false` | refused on cost |
| `n == 1.0` | `n = "1.0000000000000000000000001"` | answers | refused |
| `n > timestamp('…')` | `n = "2026-01-01T00:00:01,5Z"` | answers | refused |
| `ds[0] + ts[0] > ts[0]` | `ds: list<duration>`, `ts: list<timestamp>` | model stored | **write** refused |

- **`exists_one` costs more here than upstream charges it.**
  Upstream answers to 48 elements and refuses from 49;
  tsfga refuses from 25. This is
  `maxConditionEvaluationCost` over-charging, and over-charging is
  the direction that limit is required to fail in. cel-go's
  desugaring counts matches — `body ? __result__ + 1 : __result__`
  — so the step costs 2 only on the iterations whose predicate
  holds. tsfga's estimate runs *before* evaluation, by design, so
  it cannot know which those are and charges the branch it cannot
  rule out on every element. With an all-*true* predicate the two
  boundaries coincide, which is how the constant is known not to
  be an over-estimate of the step itself. Pinned in
  `cel-cost.test.ts`. Every other comprehension — `all`, `exists`,
  `map`, `filter` — refuses at exactly upstream's element count.
- **A decimal string below the half-ulp is read upstream and
  refused here**, for `double`, `int` and `uint` alike. Upstream
  rounds the decimal to 64 significand bits and *then* asks
  whether the result is representable, so
  `"1.0000000000000000000000001"` becomes exactly `1.0` and is
  read; tsfga asks the question of the decimal as written, at
  whatever precision it is written to, and refuses it as the
  non-dyadic value it is. `"1.0000000000000000001"` sits above the
  half-ulp and is refused by both. **This is tsfga's own coercion
  code, not a cel-js limitation** — cel-js never sees the string.
  It is deferred by an explicit decision on release risk, not
  because the CEL carve-out covers it: the fix moves the numeric
  path every `int`, `uint` and `double` context value crosses, in
  the accepting direction. Closing it means rounding to 64
  significand bits before the exactness test.
- **An RFC 3339 fractional separator must be a period here.** Go's
  `time.Parse` falls back to a parser that takes a comma as well,
  so `"…T00:00:01,5Z"` is a timestamp upstream and is not one
  here. **Again tsfga's own coercion, not a cel-js gap** — this
  time a regular expression in `conditions.ts`. Refusing, so it is
  safe; the fix is one character and is post-release work.
- **A temporal parameter declared inside a container is never
  temporal-degraded**, so `duration + timestamp` on a
  `list<duration>` and a `list<timestamp>` is refused at the
  condition *write*, where the equivalent scalar declaration is
  stored by both. **This one is cel-js's gap**: the degrade pass
  exists only because cel-js declares `duration + timestamp` as a
  Duration where cel-go declares a Timestamp, and it tests the
  declared type rather than the container's element type. Closing
  it needs a cel-js that declares the overload as cel-go does —
  not a wider accommodation here, which would grow the very layer
  this project removed.

The first is pinned in `cel-cost.test.ts`; the other three in
`condition-grammar.test.ts`, the last of them by
`expectPinnedModelWriteDivergence` because what diverges is the
write and not the answer. All four carry a row in
`docs/cel-js/cases.jsonl` with both version strings.

**Different boolean.** Go's `time.Time` is nanosecond-resolution;
cel-js maps a CEL timestamp onto a JS `Date`, which is
millisecond, and anything finer is discarded silently — from the
context value and from the `timestamp('…')` literal alike.

| expression | context `n` | OpenFGA | tsfga |
|---|---|---|---|
| `n > timestamp('…T00:00:00Z')` | `…00.0005Z` | `true` | `false` |
| `n > timestamp('…00.000000000Z')` | `…00.000000500Z` | `true` | `false` |

Everything at millisecond resolution or coarser agrees, so a
condition comparing whole seconds, minutes or dates — which is
what an expiry or a business-hours window is — is unaffected.

Every unclosed row above has the same cause and the same fix:
cel-js declines to replace a built-in overload, and its standard
library cannot be turned off, so there is no way to reach one from
outside the library. They close in `@marcbachmann/cel-js`, not
here.

### What this means for a condition you write

- **A condition is a narrowing device.** Write it so the engines
  disagreeing costs you a denial, not a grant. Prefer comparisons
  over parameters your application controls to pattern matching
  over strings an attacker controls.
- **`matches()` is unavailable**, as the top of this section says.
  There is no pattern syntax to get right, no portability rule to
  apply, and no regular expression anywhere in an authorization
  decision.
- **Stay away from the magnitudes.** Arithmetic near the int64 or
  uint64 bounds, `int()` and `double()` of an out-of-range operand
  in either direction, durations past a few thousand hours, and
  timestamps near year 1 or year 9999 are where the engines part
  company — often in the granting direction, because cel-go
  range-checks and cel-js does not.
- **Whole milliseconds, not nanoseconds.** A CEL timestamp is a JS
  `Date` here. Finer precision is silently dropped from literals
  and from context alike.
- **If you also run OpenFGA**, treat the two as sharing a model but
  not a dialect. An expression tsfga stores may be one OpenFGA
  refuses to store at all.
- **`ipaddress()` and `in_cidr()` are unavailable.** cel-js does
  not implement them. A condition naming either is stored — it is
  a model upstream accepts — and every check that reads it is
  refused. Express CIDR membership outside the condition, or as an
  explicit list.

If any of the above is load-bearing for your authorization
decisions, the shortest honest advice is: write the check you
depend on as a test against tsfga itself. That is what the
conformance suite in this repository does, and it is the only
thing that stays true across a dependency upgrade.

## License

MIT
