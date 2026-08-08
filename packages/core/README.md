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
const fga = createTsfga(store);

// Write a relation config
await fga.writeRelationConfig({
  objectType: "document",
  relation: "viewer",
  directlyAssignableTypes: ["user"],
  allowsUsersetSubjects: false,
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
// → true
```

## API

`createTsfga(store, options?)` returns a `TsfgaClient`:

| Method | Description |
|---|---|
| `check(request)` | Check if a subject has a relation on an object |
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
- Condition evaluation with missing declared parameters is an
  error (`ConditionEvaluationError`), not an unmet condition —
  matching OpenFGA's check behavior. A silently-unmet
  condition would fail open through an exclusion branch.

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
breadth never changes the boolean result or whether a check
errors — it caps how many concurrent store reads a single wide
node can issue (useful to avoid saturating a connection pool).
When several branches fail, which branch's error surfaces
depends on completion order — the same nondeterminism OpenFGA
has. Branches still queued when a node settles are never
started. `maxBreadth` must be an integer >= 1 or `Infinity`;
anything else throws `TsfgaError`.

`maxBreadth` also bounds how many `listObjects` candidates are
checked at once — the same knob deliberately, following
upstream, whose ListObjects worker pool is sized at
`1 + resolveNodeBreadthLimit`.

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
| direct probe | `directlyAssignableTypes` omits the subject type |
| wildcard probe | `directlyAssignableTypes` omits `subjectType:*` |
| userset scan | `allowsUsersetSubjects` is `false` |

With all three ruled out there is nothing to ask, and the node
skips the store entirely — it still resolves through its rewrites.

A part is left out only on a *positive* exclusion. A relation with
no config at all, or with `directlyAssignableTypes: null` — which
means "not narrowed", not "purely computed" — still reads
everything. The gate is the same predicate `addTuple` applies, so
a tuple that can be written is always a tuple that can be found.

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

tsfga skips less than upstream in one case. A purely computed
relation (`define viewer: owner`) issues no tuple reads at all in
OpenFGA, which dispatches on the relation's rewrite. tsfga
encodes "purely computed" as the same `directlyAssignableTypes:
null` that also means "unrestricted", so it cannot tell the two
apart and reads. Distinguishing them would mean changing what
`null` means for writes as well, so it is deliberately not folded
in here.

## Contextual tuples

Contextual tuples passed on a `CheckRequest` are validated
against relation configs with the same rules as `addTuple`:
the relation config must exist, the subject type must be
directly assignable (including `type:*` for wildcard
subjects), and userset subjects must be allowed. Invalid
contextual tuples throw `RelationConfigNotFoundError`,
`InvalidSubjectTypeError`, or `UsersetNotAllowedError`.

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
