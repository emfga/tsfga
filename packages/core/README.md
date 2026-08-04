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
| `listObjects(objectType, relation, subjectType, subjectId, context?)` | List object IDs the subject can access; `context` is forwarded to each check |
| `listSubjects(objectType, objectId, relation)` | List direct subjects for an object + relation (no expansion) |
| `writeRelationConfig(config)` | Insert or update a relation configuration |
| `deleteRelationConfig(objectType, relation)` | Delete a relation configuration |
| `writeConditionDefinition(condition)` | Insert or update a CEL condition definition |
| `deleteConditionDefinition(name)` | Delete a CEL condition definition |

## Depth limits and cycles

`check()` resolves relations recursively with a configurable
recursion budget (`maxDepth`, default 10, via the second
argument of `createTsfga`).

- When the budget is exhausted, or when the resolution path
  revisits a node it already contains (a cyclic model),
  `check()` throws `DepthExceededError` — mirroring OpenFGA's
  "resolution too complex" error. Prior to 0.3.0 exhaustion
  silently resolved to `false`, which could fail open: a
  truncated `excludedBy` sub-check read as "not excluded" and
  granted access.
- Union-style branches (direct, userset, implied_by, computed
  userset, tuple-to-userset) are resolved concurrently: a
  branch that resolves `true` wins even if a sibling branch
  threw `DepthExceededError`. If no branch grants and at least
  one errored, the error propagates.
- In exclusion (`excludedBy`) and intersection branches,
  errors always propagate (fail closed). A definite `false`
  base result still denies without waiting on the exclusion
  branch's outcome.

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
