# tsfga

TypeScript implementation of OpenFGA-compatible relationship-based access
control (ReBAC).

## Features

- **5-step recursive check algorithm** — direct tuples, userset expansion,
  relation inheritance, computed usersets, and tuple-to-userset
- **CEL condition evaluation** — conditional tuple access via
  `@marcbachmann/cel-js`
- **Database-agnostic core** — the check algorithm depends only on a `TupleStore`
  interface
- **Kysely adapter** — PostgreSQL implementation included out of the box
- **Conformance-tested** — validated against a real OpenFGA service to ensure
  identical results

## Architecture

```
createTsfga (public API)
  ↓
check / conditions (core algorithm)
  ↓
TupleStore (interface)
  ↓
KyselyTupleStore (adapter)
```

The `@tsfga/core` package contains pure logic with no database dependencies.
It communicates with storage through the `TupleStore` interface, which the
`@tsfga/kysely` adapter implements for PostgreSQL.

## Supported runtimes

- **Node.js** `>= 22.12.0`. Support follows the
  [Node.js release schedule](https://github.com/nodejs/release#release-schedule):
  active and maintenance LTS lines only. Node.js 20 reached end of life
  in April 2026 and is not supported.
- **Bun** `>= 1.2`
- **Deno** `>= 2.6`

Both published packages are **ESM-only** — there is no CommonJS build.
Use `import`; CommonJS consumers can load them via dynamic `import()`
or Node's `require(esm)` support (stable since Node.js 22.12).

## Installation

```bash
# Core library (check algorithm, types, conditions)
npm install @tsfga/core

# PostgreSQL adapter (requires Kysely and pg as peer deps)
npm install @tsfga/kysely kysely pg
```

`@tsfga/kysely` supports `kysely >=0.27.0 <0.30.0` and `pg >=8.0.0`
as peer dependencies.

## Quick start

```typescript
import { createTsfga } from "@tsfga/core";
import { KyselyTupleStore, type DB } from "@tsfga/kysely";
import { migrationProvider } from "@tsfga/kysely/migrations";
import { Kysely, Migrator, PostgresDialect } from "kysely";
import pg from "pg";

const db = new Kysely<DB>({
  dialect: new PostgresDialect({
    pool: new pg.Pool({ connectionString: "..." }),
  }),
});

// Provision the tsfga schema (idempotent — applies pending migrations)
const migrator = new Migrator({ db, provider: migrationProvider });
await migrator.migrateToLatest();

const store = new KyselyTupleStore(db);
const fga = createTsfga(store);

// Write relation configs (typically derived from your authorization model)
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

`createTsfga(store, options?)` returns a `TsfgaClient` with the
following methods:

| Method | Description |
|---|---|
| `check(request)` | Check if a subject has a relation on an object |
| `checkMany(requests)` | Check several requests in one shared resolution scope |
| `addTuple(request)` | Insert or update a relationship tuple |
| `removeTuple(request)` | Delete a relationship tuple |
| `listObjects(objectType, relation, subjectType, subjectId)` | List object IDs the subject can access |
| `listSubjects(objectType, objectId, relation)` | List direct subjects for an object + relation |
| `writeRelationConfig(config)` | Insert or update a relation configuration |
| `deleteRelationConfig(objectType, relation)` | Delete a relation configuration |
| `writeConditionDefinition(condition)` | Insert or update a CEL condition definition |
| `deleteConditionDefinition(name)` | Delete a CEL condition definition |

## Development

### Prerequisites

- [Bun](https://bun.sh/) >= 1.3
- [Docker](https://www.docker.com/) (for integration and conformance tests)

### Commands

```bash
bun install                            # Install dependencies
bun run infra:setup                    # Start services + run migrations
bun run turbo:test                     # Run all tests (infra must be running)
bun run turbo:test:core                # Unit tests only (no infra needed)
bun run turbo:test:conformance         # Conformance tests (infra required)
bun run turbo:test:kysely              # Adapter tests (infra required)
bun run turbo:test:node                # Core tests on Node.js (no infra needed)
bun run turbo:test:deno                # Core tests on Deno (no infra needed)
bun run build                          # Build all packages
bun run tsc                            # Type check all packages
bun run biome:check                    # Lint + format check (Biome)
bun run biome:lint                     # Lint only (Biome)
bun run biome:format                   # Auto-format (Biome)
```

### Infrastructure

```bash
bun run infra:setup           # Start services + run migrations (first time)
bun run infra:up              # Start PostgreSQL + OpenFGA
bun run infra:down            # Tear down with volumes (clean slate)
```

PostgreSQL and OpenFGA share the same database instance but use separate schemas
(`tsfga` and `openfga` respectively).

## Releases

Each package is versioned and published independently. See
[RELEASING.md](RELEASING.md) for the release process and the
per-package changelogs for notable changes:

- [`packages/core/CHANGELOG.md`](packages/core/CHANGELOG.md)
- [`packages/kysely/CHANGELOG.md`](packages/kysely/CHANGELOG.md)
