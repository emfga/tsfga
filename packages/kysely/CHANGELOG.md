# Changelog

Notable changes to `@tsfga/kysely`. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions
follow [Semantic Versioning](https://semver.org/) (pre-1.0: minor
releases may contain breaking changes).

## 0.4.1 — 2026-08

### Fixed

- **The peer range on `@tsfga/core` admits 0.5.x.** 0.4.0
  published `"@tsfga/core": "^0.4.0"`, which below 1.0.0 means
  `>=0.4.0 <0.5.0` — so installing core 0.5.0 alongside it
  raised a peer conflict even though nothing in the adapter
  changed. The range is now `>=0.4.0 <0.6.0`.

  The adapter needs no change to work with core 0.5.0: that
  release added `checkMany` and shared one resolution scope
  across a batch, but did not touch the `TupleStore` interface.
  A batch reaches the adapter as the same `findCheckTuples`,
  `findTuplesByRelation` and `findRelationConfig` calls a
  sequence of `check` calls would make — fewer of them, because
  the memo and the config cache now span the batch.

  One consequence worth knowing if you instrument the store:
  core 0.5.0 stops abandoned branches from querying, but a read
  already handed to the adapter still completes. Drain your
  counters before reading them.

  The range is now hand-written in `package.json` instead of
  derived from the core version at publish time, and
  `scripts/check-peer-range.sh` fails CI when a core bump leaves
  it behind. It required no `@tsfga/kysely` API change, hence a
  patch release.

## 0.4.0 — 2026-08

### Breaking changes

- **Requires `@tsfga/core` 0.4.0 or later.** The adapter
  implements the reshaped `TupleStore` interface below, so a
  0.3.x core cannot drive it; the peer range is bumped
  accordingly.

- **`KyselyTupleStore.findDirectTuple` and `findUsersetTuples` are
  replaced by `findCheckTuples`**, following the same change to
  the `TupleStore` interface in `@tsfga/core`. Code calling the
  adapter directly (rather than through `createTsfga`) must be
  updated; there is no fallback shim.

  The three per-node reads a check used to make separately are now
  one query: the same `(object_type, object_id, relation)`
  predicate with an OR over only the subject predicates the caller
  asked for. One round-trip instead of up to three, and one
  connection instead of up to three held at once — which is where
  the measured win comes from, since a wide node at the default
  `maxBreadth` of 10 could otherwise demand 30 connections from
  the pool.

  Relations admitting more than one part resolve 1.8x–3.0x faster
  on a 10-connection pool; relations admitting exactly one part
  emit identical SQL and are unchanged.

  The plan varies with the model shape. When the disjuncts differ
  only in `subject_id` — the `[user, user:*]` shape — they
  collapse to the full five-column index condition. When a probe
  is mixed with the userset scan, the two disjuncts share nothing
  past `relation`, and PostgreSQL either combines the probe index
  with the partial `idx_tuples_userset` under a `BitmapOr` or
  descends the three-column prefix and filters. The filter plan
  reads rows it discards, so a relation admitting both a direct
  type and usersets can examine rows the old direct probe would
  have looked up exactly — measured at 0.17 ms against 0.13 ms,
  still net faster, since the round-trip it removes costs more
  than the difference.

### Changed

- **Migration `003-drop-unused-indexes` removes three indexes from
  `tsfga.tuples`.** None of them can serve a query the adapter
  issues, and the largest was 10 MB on a 90k-row table. Existing
  deployments pick this up through the normal migration path;
  `down` recreates all three with their original definitions.

  - `idx_tuples_check` — its five columns are exactly the leading
    five of `idx_tuples_unique`, so every plan that used it now
    uses that index instead, at the same buffer count. Verified
    across every adapter query shape: direct probe, probe plus
    wildcard, probe plus usersets, and `deleteTuple`.
  - `idx_tuples_metadata` — a GIN index on a column the adapter
    never writes or reads.
  - `idx_tuples_condition` — `condition_name` is written and
    projected, but never appears in a predicate in any adapter
    query. OpenFGA does filter on condition name, via
    `COALESCE(condition_name, '') IN (...)`, yet indexes the
    column in no dialect and on neither its tuple nor its
    changelog table — the predicate always trails an equality on
    the object columns. A bare-column index could not have served
    that expression anyway.

  `idx_tuples_object` and `idx_tuples_userset` are prefixes of
  `idx_tuples_unique` too, and were evaluated for the same
  treatment, but both are kept: they are roughly a tenth its size,
  so they hold more entries per page. Dropping `idx_tuples_object`
  costs `findTuplesByRelation` and `listDirectSubjects` 4 buffers
  against 7 on a small object and 9 against 16 on a large one, and
  dropping `idx_tuples_userset` costs the userset scan 4 buffers
  against 16, with 400 rows filtered out that the partial index
  excludes outright. Prefix redundancy alone does not make an
  index free to drop.

- **Migration `004-drop-metadata-columns` removes the `metadata`
  column from `tsfga.tuples` and `tsfga.relation_configs`**, and
  the generated `DB` type no longer carries it.

  Neither column was reachable through the library: `@tsfga/core`
  has no metadata concept on `Tuple` or `RelationConfig`, and no
  adapter method wrote, read, or filtered it. Nothing tsfga does
  could put a value there. It came in from a predecessor schema
  and was never wired to anything; OpenFGA has no analogue on its
  tuple table in any dialect, so it was not anticipating a
  feature either.

  **Destructive, and `down` restores the columns but not their
  contents.** This only matters for a consumer who wrote to them
  out of band through their own `Kysely<DB>` handle — possible,
  and type-visible, because the exported `DB` type declared the
  columns even though no adapter method touched them. Copy any
  such data out before migrating.

## 0.3.1 — 2026-08

Maintenance release. No changes to the published code — the
package contents are identical to 0.3.0.

### Changed

- Release tooling: the publish job pins Node 24.19.0 and uses its
  bundled npm 11.17.0 for Trusted Publishing, and CI actions moved
  off the deprecated Node 20 runtime.
- CI now builds and runs the `examples/node-kysely` example
  against the workspace packages, so the documented consumer
  setup is verified on every run.
- Development toolchain: `@types/pg` updated to 8.20.4; the
  conformance stack now runs OpenFGA v1.18.2 and a refreshed
  `postgres:18-alpine` digest.

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
