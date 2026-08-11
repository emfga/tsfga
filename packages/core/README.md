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
| `check(request)` | Check if a subject has a relation on an object |
| `checkMany(requests)` | Check several requests in one shared resolution scope; outcomes in request order |
| `addTuple(request)` | Insert or update a relationship tuple |
| `removeTuple(request)` | Delete a relationship tuple |
| `listObjects(objectType, relation, subjectType, subjectId, context?)` | List object IDs the subject can access, in candidate order; `context` is forwarded to each check |
| `listSubjects(objectType, objectId, relation)` | List direct subjects for an object + relation (no expansion) |
| `writeRelationConfig(config)` | Insert or update a relation configuration |
| `deleteRelationConfig(objectType, relation)` | Delete a relation configuration |
| `writeConditionDefinition(condition)` | Insert or update a CEL condition definition |
| `deleteConditionDefinition(name)` | Delete a CEL condition definition |

## Depth limits and cycles

`check()` resolves relations recursively with a configurable
recursion budget (`maxDepth`, default 25, via the second
argument of `createTsfga`). The default matches OpenFGA's
`OPENFGA_RESOLVE_NODE_LIMIT` (25), so both systems exhaust
resolution at the same model depth.

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

  A `double` carries one rule more: upstream parses at 64-bit
  precision and refuses the value if converting it to a `float64`
  loses anything. A decimal fraction with no finite binary form is
  therefore an error rather than the nearest double — `"0.1"` as a
  **string** is refused, while `0.1` as a **number** is accepted,
  since a number is already a `float64` and is asserted rather
  than parsed.

  A `duration` takes Go's unit grammar plus the one unitless form
  its parser special-cases, a bare `"0"`. A `timestamp` takes RFC
  3339 with **uppercase** `T` and `Z` and any number of fractional
  digits.

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

### Known divergence: `uint`

cel-js has no `uint` representation. An `int` and a `uint`
parameter both reach CEL as a `bigint`, which is CEL's `int`, so
two cells still differ from upstream:

| expression | OpenFGA | tsfga |
|---|---|---|
| `type(n) == uint` | `true` | `false` |
| `n + 1u == 8u` | `true` | error, no overload |

Both are pinned two-sided in the conformance suite, so they
cannot change without being noticed. `uint(n) + 1u == 8u` works
on both, and `type(n) == int` agrees. `Environment.registerType`
makes a real `uint` reachable in principle; it was judged not
worth its cost rather than found impossible, and that judgement
is the thing to revisit if these cells start mattering.

Every other integer cell agrees, including the arithmetic
operators, exact comparison past 2^53, saturation at the int64
bounds, and overflow past them.

### Known divergence: sub-millisecond timestamps

Go's `time.Time` is nanosecond-resolution; cel-js maps a CEL
timestamp onto a JS `Date`, which is millisecond. Anything finer
is discarded silently — from the context value and from the
`timestamp('…')` literal alike — and both engines still answer,
so the booleans differ:

| expression | context `n` | OpenFGA | tsfga |
|---|---|---|---|
| `n == timestamp('…T00:00:00Z')` | `…00.000000001Z` | `false` | `true` |
| `n == timestamp('…T00:00:00Z')` | `…00.000001Z` | `false` | `true` |
| `n > timestamp('…T00:00:00Z')` | `…00.0005Z` | `true` | `false` |
| `n > timestamp('…00.000000000Z')` | `…00.000000500Z` | `true` | `false` |

The first two rows are the granting direction. Everything at
millisecond resolution or coarser agrees, so a condition that
compares whole seconds, minutes or dates — which is what an
expiry or a business-hours window is — is unaffected. All four
cells and both boundary controls are pinned two-sided in the
conformance suite.

Unlike the `uint` divergence, this one was found unreachable
rather than judged too costly. `@marcbachmann/cel-js` 8.0.0
declines to displace its own `timestamp(string)` overload, and
its standard library cannot be turned off, so the literal side of
the comparison truncates whatever a custom carrier held. It will
close if cel-js changes its timestamp representation.

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

An error in any candidate fails the whole call, `check`'s errors
included — `DepthExceededError` in one object does not silently
drop that object from the list, matching upstream. Which error
surfaces is deterministic: it is the first failing candidate in
*candidate* order, not the first to fail in wall-clock order. No
candidate after a failure is started.

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
narrow, `[]` excludes the part.

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
no config at all still reads everything — there is nothing to
narrow against. The gate is the same predicate `addTuple` applies,
so a tuple that can be written is always a tuple that can be
found.

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
// The fourth argument is the condition name. Passing null asks
// whether the relation admits `team#member` *unconditioned* --
// a relation admitting only `team#member with in_hours` will
// say no, which is the answer `check` gives too.
admitsSubjectRef(config, directSubjectRef("team", "eng", "member", null));
```

Two things to know before relying on it:

- **A `null` config is permissive**, because that is what `check`
  does and agreement is the whole point of exporting these. Inside
  `check` a `null` config means the relation is unconstrained; in
  your `WHERE` clause it usually means you misspelled the relation
  name, and the filter then silently admits everything. Look the
  config up yourself and fail on `null` if that is what you meant.
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

## Write-time condition validation

`addTuple` refuses a tuple whose condition the model cannot
accept, with the cause on `InvalidConditionalTupleError.cause`:

| cause | meaning |
|---|---|
| `condition is missing` | no condition, and every matching restriction has one |
| `invalid condition for type restriction` | a defined condition this relation does not name |
| `undefined condition` | no such condition in the store |
| `parameter type error` | a context value not readable as its declared type |
| `invalid context parameter` | a context key the condition does not declare |

Only the context keys actually **present** are validated. A
conditioned tuple with no context, or a partial one, is accepted:
the rest can arrive with the check request.

A conditioned write costs one extra round-trip — the
condition-definition lookup — so 3 rather than 2. Unconditioned
writes are unchanged. That is deliberate and uncached: a
client-lifetime cache on a *validation* gate goes stale across
processes, and would keep accepting tuples after another instance
narrowed the model.

## TupleStore interface

The `TupleStore` interface is the extension point for custom
database adapters. The core check algorithm depends only on
this interface — it has no database dependencies.

Its read surface is deliberately shaped around what a check
actually asks for, not around individual predicates. The one to
understand when writing an adapter is `findCheckTuples`: it takes
a `CheckTuplesQuery` (the node, plus which of the three parts are
wanted) and returns a `CheckTuples` (`direct`, `wildcard`,
`usersets`). Both types are exported. Serving it as one query is
the single largest thing an adapter can do for check latency; an
implementation may run three instead, and simply gives that up.

The `include*` flags exist so a store can **narrow** its query —
that is where the saving is. They are a hint, not a trust
boundary: `check` re-clamps every reply against the query it
sent, so returning a part that was not asked for, or filing a row
under the wrong slot, loses that row. An adapter bug cannot widen
what the model admits, only lose grants it should have found.

Slots are exact. `direct` is the tuple for this subject with no
subject relation, `wildcard` the one for `subjectType:*` likewise,
and every row in `usersets` has a subject relation. A minimal
correct implementation may ignore the flags entirely and return
all three parts; it just gives up the saving.

See
[`src/store-interface.ts`](src/store-interface.ts)
for the full interface definition.

[`@tsfga/kysely`](../kysely/README.md) provides the included
PostgreSQL adapter.

## Conditions

CEL condition evaluation is supported via
[`@marcbachmann/cel-js`](https://github.com/nicholasgasior/cel-js).
Tuples can reference named condition definitions, and the
check algorithm evaluates them automatically.

Context merge rule: tuple context properties take precedence
over request context properties (matching OpenFGA behavior).

Compiled CEL expressions are cached by expression source text
(content-keyed). Redefining a condition via
`writeConditionDefinition` therefore takes effect on the next
evaluation — there is no per-name cache to go stale — and
identical expressions share one compiled entry.

## License

MIT
