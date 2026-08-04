# Changelog

Notable changes to `@tsfga/kysely`. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions
follow [Semantic Versioning](https://semver.org/) (pre-1.0: minor
releases may contain breaking changes).

## 0.3.0 — 2026-08

### Breaking changes

- **Generated `DB` type covers only the `tsfga` schema.** The
  kysely-codegen output no longer includes the `openfga.*` tables
  that leaked in from the shared development database. Consumers
  that referenced those tables through the exported `DB` type must
  define their own types for them.
- **`listSubjects` returns `"*"` for wildcard subjects** instead of
  leaking the internal sentinel UUID
  (`00000000-0000-0000-0000-000000000000`).
- **kysely peer range narrowed to `>=0.27.0 <0.30.0`.** kysely 0.x
  minors are breaking; the range now caps at the last verified
  minor. Toolchain updated to kysely 0.29.4.
- **ESM-only, Node.js >= 22.12.0.** The package declares
  `engines.node: ">=22.12.0"` and ships only an ESM build. Node.js
  20 (EOL April 2026) is no longer supported.

### Added

- **`@tsfga/kysely/migrations` export.** A static
  `migrationProvider` (a kysely `MigrationProvider` backed by an
  in-code migration map — no filesystem scanning, bundler-safe)
  enables one-call schema provisioning:

  ```typescript
  import { migrationProvider } from "@tsfga/kysely/migrations";
  import { Migrator } from "kysely";

  const migrator = new Migrator({ db, provider: migrationProvider });
  await migrator.migrateToLatest();
  ```

  Previously the compiled migrations shipped in the tarball but
  were unreachable (no subpath export).
- `sideEffects: false` for bundler tree-shaking; the MIT `LICENSE`
  file now ships in the npm tarball.

### Fixed

- `deleteTuple` no longer treats an empty-string `subjectRelation`
  as absent (truthiness bug).
- Residual `as` casts removed from the stored-JSON parsers; invalid
  stored data consistently throws `InvalidStoredDataError`.

## 0.2.0 — 2026-02-18

First published release, as part of the tsfga Turborepo monorepo.

- `KyselyTupleStore`, a PostgreSQL implementation of the
  `@tsfga/core` `TupleStore` interface built on the Kysely query
  builder.
- Migrations creating the `tsfga` schema (tuples, relation configs,
  condition definitions) with supporting indexes.
- Generated, committed schema types (`DB`) via kysely-codegen.
- UUID mapping between the string-based `TupleStore` interface and
  the `uuid` database columns, with a sentinel UUID for wildcard
  subjects.
