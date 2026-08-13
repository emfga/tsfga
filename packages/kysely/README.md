# @tsfga/kysely

Kysely/PostgreSQL adapter for
[`@tsfga/core`](../core/README.md).

Part of the [tsfga](../../README.md) monorepo. Implements
the `TupleStore` interface from `@tsfga/core` using
[Kysely](https://kysely.dev/) for PostgreSQL.

## Identifiers must be canonical UUIDs

**This store holds object and subject ids that are exactly
8-4-4-4-12 lower-case hexadecimal digits, hyphenated, and nothing
else. `user:alice` is an ordinary subject in OpenFGA and this
store refuses it, permanently.**

It is the first thing to know about it, and it is a declared
design limit rather than a bug awaiting a fix. `object_id` and
`subject_id` are `uuid` columns; `KyselyTupleStore` declares
`CANONICAL_UUID_IDS` as its `TupleStore.idDomain`, and core
refuses anything outside it with `IdDomainError` — at the request
boundary, before any query, on `check`, `checkMany`,
`listObjects`, `listSubjects`, `addTuple`, `removeTuple` and
contextual tuples.

The domain is deliberately **narrower than PostgreSQL's own `uuid`
input grammar**, which accepts a UUID uppercased, hyphenless,
braced, or hyphenated oddly and stores every one of them as the
same value. OpenFGA treats each spelling as a distinct id.
Admitting more than the canonical spelling would let a grant
written for one answer `true` for another, so only the canonical
spelling is admitted.

Nothing about the version or variant digits is checked. The nil
UUID `00000000-0000-0000-0000-000000000000` is an ordinary id
here — no id value is reserved.

Every refusal is in the refusing direction: a refused request is
one no grant was computed for, and the read paths raise rather
than answering `false`, which is what upstream does (HTTP 400, for
every id it cannot represent). If your ids are not UUIDs, this
adapter is not the one to use — `@tsfga/core` is
database-agnostic and a store declaring `OPAQUE_IDS` has none of
these restrictions.

See the [core README's id-domain
section](../core/README.md#known-divergence-the-stores-id-domain)
and `tests/conformance/id-domain.test.ts`, which pins the
divergence against a live OpenFGA.

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

### 006-wildcard-subject needs PostgreSQL 15

This migration gives the typed wildcard subject a column of its
own — `tsfga.tuples.subject_wildcard boolean`, with `subject_id`
NULL on those rows — so **no id value is reserved**.

It fixes a grant to everybody. `subject_id` is a `uuid` column and
`"*"` is not a UUID, so the adapter used to store the wildcard as
the nil UUID. A tuple written for a real subject whose id was
`00000000-0000-0000-0000-000000000000` landed in the wildcard's
slot: it read back as `"*"`, granted every subject of its type on
any relation admitting `type:*`, and stopped matching the subject
it was written for. OpenFGA reserves no id. Neither does this,
now — `user:00000000-0000-0000-0000-000000000000` names that one
subject.

**PostgreSQL 15 or later.** `idx_tuples_unique` is recreated with
`NULLS NOT DISTINCT`, which is what makes a second wildcard row on
one key a duplicate while leaving a real nil-UUID subject free to
sit beside it. That clause landed in PostgreSQL 15. The floor is
claimed by feature inspection rather than by a CI matrix — CI runs
PostgreSQL 18, and a floor nothing exercises is a claim, so this
says which it is. The alternative is an expression index on
`COALESCE(subject_id::text, '*')`, which needs no version floor
and costs 25 MB against 18 MB at 242 000 rows.

**Rolling `006` back refuses rather than merging.** A real subject
whose id is the nil UUID is legal under this migration and is the
*wildcard* under `005`, so restoring the old encoding would fold
such a row into the wildcard's slot and grant its relation to
every subject of the type — a grant nobody authorized. `down`
counts those rows and names them; delete or rewrite them
deliberately first.

**If you are on a pre-release `006-subject-id-text` or
`007-object-id-text`**, those two migrations are deleted rather
than superseded. Kysely's migrator refuses to run against a
database that applied them (`corrupted migrations: previously
executed migration … is missing`), and re-provisioning is the
answer. No published `@tsfga/kysely` ever carried them — 0.5.0
stops at `005`.

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

`object_id` and `subject_id` are `uuid` columns, so ids must be
canonical UUIDs — see [the top of this
README](#identifiers-must-be-canonical-uuids).

The public wildcard subject `"*"` ("all subjects") is **not** an
id and is not stored as one. `tsfga.tuples.subject_wildcard` is a
boolean and `subject_id` is NULL on those rows, so **no id value
is reserved**: a grant to
`user:00000000-0000-0000-0000-000000000000` names that one
subject, exactly as it does upstream. `@tsfga/core` still spells
the wildcard `subjectId: "*"`; the adapter maps it in both
directions and raises `InvalidStoredDataError` on a row that
carries neither shape or both.

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
| `idx_tuples_unique` | `(object_type, object_id, relation, subject_type, subject_id, COALESCE(subject_relation, ''))`, unique, `NULLS NOT DISTINCT` | The insert's conflict target; also every probe, via its leading columns. `NULLS NOT DISTINCT` is what makes a second wildcard row a duplicate |
| `idx_tuples_object` | `(object_type, object_id)` | `findTuplesByRelation` |
| `idx_tuples_userset` | `(object_type, object_id, relation)` where `subject_relation IS NOT NULL`, partial | The userset scan |
| `idx_tuples_subject` | `(subject_type, subject_id)` | Reverse lookups by subject |

`idx_tuples_object` and `idx_tuples_userset` are prefixes of
`idx_tuples_unique` and could in principle be dropped, but both
are far narrower than it — a tenth of its size — so they fit more
entries per page and measurably win the scans they serve.

## How a write lands

`insertTuple` inserts and reports: the conflict clause does
nothing on a duplicate and the method returns `false`, so the
stored row keeps the condition and the context it already had. It
used to update the row in place. `TsfgaClient.addTuple` turns the
`false` into `DuplicateTupleError`; the way to change a live
grant's condition is `removeTuple` then `addTuple`.

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

**The reachability prune adds config reads, not width.** Core asks
whether the subject's type can reach a node before resolving it,
and answers from the relation configs — which means reading
configs the resolution itself would never have asked for. Every
read goes through the scope's config cache, so each
`objectType#relation` costs at most one round trip per scope, and
the walks are *serialized* within a scope: they lengthen a scope's
read sequence without widening it. The width bound is still
`maxBreadth` per node.

Measured against `theopenlane`, the largest model in the suite at
225 relation configs, one resolution scope's walk read 11 distinct
configs at the smallest, 18 at the median and 192 at the largest.
So a single `check()` against a large, densely cross-referenced
model can turn ~10 config round trips into up to ~190 on its first
node, and none afterwards. `listObjects` and `checkMany` amortise
that across the whole call, which is where it is cheapest; a
one-shot `check()` on a big model is where it is dearest — about
+18 % wall clock on the `theopenlane` conformance files against a
warm database.

A **userset** subject is cheaper per node, not dearer: both the
direct and the wildcard probe are excluded rather than narrowed,
so its node reads are strictly a subset of a concrete subject's.
It adds one relation-config read per scope, for the subject's own
relation, cached like every other.

Inside a transaction the whole question dissolves: every store
call runs on the transaction's one connection, so the peak is 1
and the queries serialize there instead of at the pool. The
concurrency knobs then buy nothing — which is worth knowing,
because scoping a client to a transaction is a documented and
otherwise unremarkable thing to do.

Which plan PostgreSQL picks depends on the disjuncts. Asking for
one part gives the same plan as before this was merged. A direct
probe and a wildcard probe differ only in `subject_id` — an
equality against the id for one, `IS NULL` for the other — so
both reach five columns of `idx_tuples_unique` and the pair is
combined under it.

The wildcard probe spells that `IS NULL` out even though
`subject_wildcard` alone would be equivalent, and the difference
is not cosmetic. The check constraint ties the two together and
the planner does not know it: measured on PostgreSQL 18 with one
object carrying 5000 subjects, the bare boolean has nothing
indexed to descend on, falls to a sequential scan at 77 buffers
and discards 5000 rows, while the `IS NULL` conjunct extends the
index condition to five columns and costs 3.

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
