# @tsfga/kysely

Kysely/PostgreSQL adapter for
[`@tsfga/core`](../core/README.md).

Part of the [tsfga](../../README.md) monorepo. Implements
the `TupleStore` interface from `@tsfga/core` using
[Kysely](https://kysely.dev/) for PostgreSQL.

## Installation

```bash
npm install @tsfga/kysely @tsfga/core kysely pg
```

`@tsfga/core`, `kysely` and `pg` are peer dependencies. This
version accepts `@tsfga/core` `>=0.6.0 <0.7.0` — the adapter
implements the `TupleStore` interface as that release shapes it.
The range carries an explicit ceiling rather than a caret: below
1.0.0 a core minor may change that interface, so each minor is
admitted only once the adapter has been tested against it.

The floor moved to 0.6.0 rather than the ceiling widening,
because core 0.6.0 changed `TupleStore` itself — `RelationConfig`
holds one `directlyAssignable` list of structured type
restrictions, `CheckTuplesQuery` carries a ref set per part
instead of the three `include*` booleans, and
`listDirectSubjects` is gone. This
adapter does not work with earlier cores, and earlier adapters do
not work with this core.

## Quick start

```typescript
import { createTsfga } from "@tsfga/core";
import { KyselyTupleStore, type DB } from "@tsfga/kysely";
import { Kysely, PostgresDialect } from "kysely";
import pg from "pg";

const db = new Kysely<DB>({
  dialect: new PostgresDialect({
    pool: new pg.Pool({ connectionString: "..." }),
  }),
});

const store = new KyselyTupleStore(db);
const fga = createTsfga(store);

// Now use fga.check(), fga.addTuple(), etc.
```

## Migrations

The package bundles its migrations behind a static Kysely
`MigrationProvider`, exported from `@tsfga/kysely/migrations`.
It holds the migrations in code (no filesystem scanning), so it
works with bundlers and on any runtime. Provision or upgrade the
`tsfga` schema with Kysely's `Migrator`:

```typescript
import { Migrator } from "kysely/migration";
import { migrationProvider } from "@tsfga/kysely/migrations";

const migrator = new Migrator({ db, provider: migrationProvider });
const { error, results } = await migrator.migrateToLatest();
if (error) throw error;
```

Re-running `migrateToLatest()` on an already-migrated database is
a no-op — the `Migrator` tracks applied migrations in Kysely's
standard migration tables.

The raw migration map is also exported as `migrations` for tools
that need direct access.

### 005-type-restrictions is destructive

This migration replaces `directly_assignable_types` and
`allows_userset_subjects` on `tsfga.relation_configs` with a
single `directly_assignable` (jsonb, NOT NULL) holding OpenFGA
type restrictions as objects, one per admitted assignment:

```json
[{"type": "user"},
 {"type": "user", "wildcard": true},
 {"type": "team", "relation": "member"},
 {"type": "user", "condition": "weekday_only"}]
```

The adapter validates this shape on every read and raises
`InvalidStoredDataError` on anything else — a bare string entry
included, which is what the column held before this migration.

**Existing relation configs are not converted, and cannot be.**
`allows_userset_subjects = true` does not record which usersets
the model intended, and `NULL` does not record which types — so
any automatic conversion would invent a model nobody authored, in
the granting direction. After migrating, rewrite your relation
configs from your authorization model. **Tuples are untouched.**

Consumers on `@tsfga/core` 0.5.x and `@tsfga/kysely` 0.4.x should
plan this as a coordinated deploy: the new adapter cannot read the
old columns, and the old adapter cannot read the new one.

## Transactions

`KyselyTupleStore` takes a `Kysely<DB>` it does not own, and
Kysely declares `Transaction<DB>` as a subtype of `Kysely<DB>`.
So a store — and a whole `TsfgaClient` built over it — can be
scoped to a transaction with no extra API:

```typescript
await db.transaction().execute(async (trx) => {
  const fga = createTsfga(new KyselyTupleStore(trx));
  await fga.addTuple(/* ... */);
  if (!(await fga.check(/* ... */))) throw new Error("rolled back");
});
```

Every store method then runs inside `trx`.

### Preserving an invariant across concurrent writers

For a rule like "an organization always keeps at least one
administrator", the read and the write must be in the same
transaction *and* the transaction must be isolated enough that a
concurrent writer cannot invalidate what was read.

**Use `SERIALIZABLE`.** It preserves the invariant with no extra
API surface — the losing transaction aborts with `40001` and you
retry it.

**It holds only if every writer that can invalidate the read is
also `SERIALIZABLE`.** PostgreSQL detects the conflict from the
predicate locks the serializable readers take, so a concurrent
`READ COMMITTED` writer — another service, a migration, a
psql session, or one path in your own application that forgot the
isolation level — is not part of that bookkeeping and is never
aborted. This is a property of the whole set of writers on the
table, not of the transaction below.

```typescript
await db.transaction().setIsolationLevel("serializable").execute(
  async (trx) => {
    const fga = createTsfga(new KyselyTupleStore(trx));
    const admins = await fga.listSubjects("organization", orgId, "admin");
    if (admins.length <= 1) throw new Error("last administrator");
    await fga.removeTuple(/* ... */);
  },
);
```

**Do not reach for `SELECT … FOR UPDATE` instead.** Probed against
PostgreSQL 18: row locks are taken on rows that *exist*, so a
concurrent `INSERT` of a new administrator is not blocked at
either isolation level. `FOR UPDATE` is therefore adequate for
"at least one X" only if you count from the locking read itself,
and useless for any "at most N X" invariant. That is why the
adapter exposes no lock option: a `TupleStore` that cannot lock
would have to ignore one silently, which is a fail-open mode the
core's clamping cannot protect against. OpenFGA reaches the same
conclusion — it uses `SELECT … FOR UPDATE` strictly inside its
Postgres datastore, never on its storage interface.

## Subject IDs and wildcards

All object and subject IDs are stored in `uuid` columns, so
callers must pass UUID-formatted strings. The one exception is
the public wildcard subject `"*"` ("all subjects"), which the
adapter stores internally as the nil UUID
`00000000-0000-0000-0000-000000000000` and maps back to `"*"` on
every read. The nil UUID is therefore reserved: never use it as
the ID of a real subject, or its tuples will be indistinguishable
from wildcard grants.

## Schema

Migrations create a `tsfga` schema with three tables:

| Table | Description |
|---|---|
| `tsfga.tuples` | Relationship tuples with optional conditions |
| `tsfga.relation_configs` | Relation definitions (implied_by, computed_userset, etc.) |
| `tsfga.condition_definitions` | Named CEL condition expressions |

`tsfga.tuples` carries four indexes, each earning its place on a
query the adapter actually issues:

| Index | Columns | Serves |
|---|---|---|
| `idx_tuples_unique` | `(object_type, object_id, relation, subject_type, subject_id, COALESCE(subject_relation, ''))`, unique | The upsert's conflict target; also every probe, via its leading columns |
| `idx_tuples_object` | `(object_type, object_id)` | `findTuplesByRelation` |
| `idx_tuples_userset` | `(object_type, object_id, relation)` where `subject_relation IS NOT NULL`, partial | The userset scan |
| `idx_tuples_subject` | `(subject_type, subject_id)` | Reverse lookups by subject |

`idx_tuples_object` and `idx_tuples_userset` are prefixes of
`idx_tuples_unique` and could in principle be dropped, but both
are far narrower than it — a tenth of its size — so they fit more
entries per page and measurably win the scans they serve.

## How a check reads

Every node of a check calls `findCheckTuples` once. The adapter
serves it as a single query: one `(object_type, object_id,
relation)` predicate with an OR over just the subject predicates
the caller asked for — the subject's own direct tuple, the
`type:*` wildcard tuple, the userset rows, or any subset.

One round-trip per node instead of up to three, and one
connection held instead of up to three. The latter is usually the
bigger effect: branches of a node resolve concurrently up to
`maxBreadth`, so three reads per node meant a wide node could ask
the pool for three times as many connections as it has branches.

### Size the pool for the fanout, not for the call

`maxBreadth` bounds the branches of **one** node, not the call, so
concurrent reads compound with every further level of dispatch.
Measured with an instrumented store counting simultaneous reads,
at the shipped defaults (`maxBreadth` 10, `maxConcurrentChecks`
50):

| call | grants one dispatch away | two | three |
|---|---|---|---|
| `check` | 10 | 100 | 1000 |
| `listObjects` | 100 | 1000 | 10000 |
| `checkMany` | 500 | 5000 | 50000 |

Each row is the one above it times a factor the call adds —
`maxBreadth` again for `listObjects`, which checks candidates
concurrently at the same bound, and `maxConcurrentChecks` for
`checkMany` — and each column is the previous one times
`maxBreadth`, because a userset or tuple-to-userset row dispatches
to another object whose own branches then fan out again. The
exponent is the model's dispatch depth, which `maxDepth` caps at
25.

A pool smaller than the peak does not break anything: the excess
reads queue. But they queue *holding* the branches that are
waiting on them, so a pool sized for the first column against a
model shaped like the third turns concurrency into a queue and
the latency win into its opposite. Lower `maxBreadth` if that is
the trade you want — it is the same knob on both.

Inside a transaction the whole question dissolves: every store
call runs on the transaction's one connection, so the peak is 1
and the queries serialize there instead of at the pool. The
concurrency knobs then buy nothing — which is worth knowing,
because scoping a client to a transaction is a documented and
otherwise unremarkable thing to do.

Which plan PostgreSQL picks depends on the disjuncts. Asking for
one part gives the same plan as before this was merged. Asking
for a direct probe and a wildcard probe collapses to the full
five-column condition on `idx_tuples_unique`, since the two
differ only in `subject_id`.

Mixing a probe with the userset scan is the interesting case, and
the plan is not fixed: the two disjuncts share nothing past
`relation`, so PostgreSQL either combines `idx_tuples_unique`
with the partial `idx_tuples_userset` under a `BitmapOr`, or
descends the three-column prefix and filters. Which one it picks
turns on how many subjects sit on the relation and on the
relative selectivity of the two disjuncts, so both plans are
reachable on ordinary data. The filter plan reads rows it then
discards — still cheaper than the round-trip it saves, but not
free on objects with many subjects on one relation.

Parts the caller excludes are omitted from the SQL, so they cost
nothing to skip. In the filter plan this narrows the `Filter`,
not the `Index Cond` — the saving is in rows examined, not in
index descent.

## License

MIT
