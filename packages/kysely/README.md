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
version accepts `@tsfga/core` `>=0.4.0 <0.6.0` — the adapter
implements the `TupleStore` interface as those releases shape
it. The range carries an explicit ceiling rather than a caret:
below 1.0.0 a core minor may change that interface, so each
minor is admitted only once the adapter has been tested
against it.

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
| `idx_tuples_object` | `(object_type, object_id)` | `findTuplesByRelation`, `listDirectSubjects` |
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
