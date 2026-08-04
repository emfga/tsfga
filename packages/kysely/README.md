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

## License

MIT
