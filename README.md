# fga-ts

TypeScript implementation of OpenFGA-compatible relationship-based access
control (ReBAC).

Ports the recursive check algorithm from [pgfga](https://github.com/lemuelroberto/poc-pgfga) (a PL/pgSQL PostgreSQL extension) to TypeScript, adding CEL condition support and a database-agnostic architecture with a Kysely adapter.

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
createFga() → Core Algorithm (check, conditions) → TupleStore interface → Kysely adapter
```

The `src/core/` module contains pure logic with no database dependencies. It
communicates with storage through the `TupleStore` interface, which the Kysely
adapter implements for PostgreSQL.

## Installation

```bash
bun add lemuelroberto/fga-ts
```

### Peer dependencies

```bash
bun add kysely pg
```

## Quick start

```typescript
import { Kysely, PostgresDialect } from "kysely";
import Pool from "pg-pool";
import { createFga, KyselyTupleStore } from "lemuelroberto/fga-ts";

const db = new Kysely({
  dialect: new PostgresDialect({ pool: new Pool({ connectionString: "..." }) }),
});

const store = new KyselyTupleStore(db);
const fga = createFga(store);

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

`createFga(store, options?)` returns an `FgaClient` with the following methods:

| Method | Description |
|---|---|
| `check(request)` | Check if a subject has a relation on an object |
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
bun install                   # Install dependencies
bun test                      # Run all tests (needs Docker)
bun test tests/core/          # Unit tests only (no Docker)
bun test tests/conformance/   # Conformance tests (needs Docker)
bun test tests/store/         # Integration tests (needs Docker)
bun run tsc                   # Type check
bun run check                 # Lint + format check (Biome)
bun run format                # Auto-format (Biome)
```

### Infrastructure

```bash
docker compose up -d          # Start PostgreSQL + OpenFGA
docker compose down -v        # Tear down with volumes
```

PostgreSQL and OpenFGA share the same database instance but use separate schemas (`fga` and `openfga` respectively).

## Lineage

fga-ts is a direct port of [pgfga](https://github.com/lemuelroberto/poc-pgfga)'s
recursive check algorithm. Conformance is validated by running both fga-ts and a
real OpenFGA service against identical authorization models and tuples,
then asserting identical results.
