import { type Kysely, sql } from "kysely";

/** The pre-006 encoding of the typed wildcard subject. */
const NIL_UUID = "00000000-0000-0000-0000-000000000000";

/**
 * Gives the typed wildcard subject a column of its own, so no id
 * value is reserved.
 *
 * The public wildcard subject is the literal `"*"`, which a `uuid`
 * column cannot hold, so the adapter stored it as the nil UUID and
 * mapped it back on every read. That reserved a value the library
 * documented and nothing enforced: a tuple written for a real
 * subject whose id happens to be
 * `00000000-0000-0000-0000-000000000000` landed in the wildcard's
 * slot, read back as `"*"`, granted the relation to *every*
 * subject of its type, and stopped matching the subject it was
 * written for. Upstream reserves no id at all.
 *
 * `subject_wildcard boolean` carries the shape and `subject_id`
 * carries only ids, so the nil UUID is an ordinary subject and the
 * bug has nowhere left to live. This is a stronger fix than
 * widening the column to `text`, which is what the deleted
 * `006-subject-id-text` did: that removed the sentinel by making
 * `"*"` storable as itself, and in doing so made every id a
 * `text` comparison, where `uuid_in`'s many-to-one input grammar
 * had been folding five spellings of one UUID onto one row.
 *
 * **There is no type change here, and that is not an oversight.**
 * The two migrations that widened `subject_id` and `object_id` to
 * `text` are *deleted* rather than superseded, so the chain a
 * database runs is `001`…`005` and then this one — and
 * `001-initial` already creates both columns `uuid NOT NULL`.
 * There is nothing to narrow, no `USING` clause, and nothing for
 * `up` to do with an unparseable id.
 *
 * A development database that ran the deleted `006`/`007` cannot
 * reach this one: Kysely's migrator throws `corrupted migrations:
 * previously executed migration … is missing` and `db:latest`
 * fails before anything else runs. Re-provision it. No published
 * `@tsfga/kysely` ever carried those two — 0.5.0 stops at `005` —
 * so no consumer database has them either.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  // 1. The marker, defaulted so the rows already there are legal.
  await db.schema
    .alterTable("tsfga.tuples")
    .addColumn("subject_wildcard", "boolean", (col) =>
      col.notNull().defaultTo(false),
    )
    .execute();

  // 2. The wildcard leaves the id namespace, so the id may be
  //    absent. This must precede the backfill, which writes NULLs.
  await db.schema
    .alterTable("tsfga.tuples")
    .alterColumn("subject_id", (col) => col.dropNotNull())
    .execute();

  // 3. The old wildcard rows. On a fresh database this matches
  //    nothing; it exists for a pre-release database provisioned
  //    at 005, where the nil UUID *was* the wildcard. It is the
  //    one conversion this migration can make honestly, because it
  //    is exactly what the adapter already read those rows as, so
  //    no live answer changes.
  //
  //    Raw `sql`, like every other statement here that is not
  //    DDL: a migration takes `Kysely<unknown>`, which the DML
  //    builder cannot type at all. The adapter's no-raw-DML rule
  //    is about queries that have a schema to be checked against;
  //    these have none by construction.
  await sql`
    UPDATE tsfga.tuples
    SET subject_wildcard = true, subject_id = NULL
    WHERE subject_id = ${NIL_UUID}::uuid
  `.execute(db);

  // 4. The old unique index names `subject_id` and cannot be
  //    altered in place: neither `NULLS NOT DISTINCT` nor an
  //    expression change can be added to an existing index.
  await db.schema.withSchema("tsfga").dropIndex("idx_tuples_unique").execute();

  // 5. Both invalid shapes, in one constraint. The second conjunct
  //    is `user:*#member` at the column level: core refuses it on
  //    write and clamps it on read, and the column refuses it too,
  //    so no layer is relying on another.
  await db.schema
    .alterTable("tsfga.tuples")
    .addCheckConstraint(
      "tuples_wildcard_shape",
      sql`(subject_id IS NULL) = subject_wildcard
          AND NOT (subject_wildcard AND subject_relation IS NOT NULL)`,
    )
    .execute();

  // 6. Raw `sql`: the COALESCE makes this an expression index,
  //    which the builder cannot express — the same carve-out
  //    `001-initial` already takes.
  //
  //    `NULLS NOT DISTINCT` does the work the nil-UUID sentinel
  //    did: a second wildcard row on one key is rejected, while a
  //    *real* subject whose id is the nil UUID inserts alongside
  //    it. Both verified on PG 18. It needs PostgreSQL 15.
  //
  //    The alternative, `COALESCE(subject_id::text, '*')`, was
  //    built and measured at 242 000 rows: 25 MB against 18 MB,
  //    +34.8% on the largest index in the schema, because casting
  //    a `uuid` to `text` turns 16 fixed bytes into a 36-byte
  //    varlena in every entry. It also makes the adapter's
  //    `ON CONFLICT` clause hard-error rather than infer. Same
  //    plan, buffers within noise, so there is nothing on the
  //    other side of the ledger.
  await sql`
    CREATE UNIQUE INDEX idx_tuples_unique
    ON tsfga.tuples (object_type, object_id, relation, subject_type, subject_id, COALESCE(subject_relation, ''))
    NULLS NOT DISTINCT
  `.execute(db);

  // 7. The 005 idiom: a default that persists lets a caller that
  //    forgot the field write a row it did not mean.
  await db.schema
    .alterTable("tsfga.tuples")
    .alterColumn("subject_wildcard", (col) => col.dropDefault())
    .execute();
}

/**
 * **Refuses rather than merging, and that is the best available
 * outcome.**
 *
 * A real subject whose id is the nil UUID is legal under this
 * migration and illegal under `005`, where that value *is* the
 * wildcard. Restoring the old encoding would fold such a row into
 * the wildcard's slot and grant its relation to every subject of
 * the type — a grant nobody authorized, in the granting direction,
 * with nothing to report it.
 *
 * So `down` counts those rows and names them. This is `005`'s
 * precedent applied honestly: it refused to guess a model, and
 * this refuses to guess a subject.
 */
export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.withSchema("tsfga").dropIndex("idx_tuples_unique").execute();

  const collisions = await sql<{ n: string }>`
    SELECT count(*) AS n FROM tsfga.tuples
    WHERE subject_id = ${NIL_UUID}::uuid
  `.execute(db);
  const held = Number(collisions.rows[0]?.n ?? 0);

  if (held > 0) {
    throw new Error(
      `cannot roll back 006-wildcard-subject: ${held} row(s) ` +
        `hold ${NIL_UUID} as a real subject, which the 005 shape reads ` +
        "as the typed wildcard. Delete or rewrite them deliberately " +
        "before rolling back.",
    );
  }

  await sql`
    UPDATE tsfga.tuples
    SET subject_id = ${NIL_UUID}::uuid, subject_wildcard = false
    WHERE subject_wildcard
  `.execute(db);

  await db.schema
    .alterTable("tsfga.tuples")
    .dropConstraint("tuples_wildcard_shape")
    .execute();

  await db.schema
    .alterTable("tsfga.tuples")
    .alterColumn("subject_id", (col) => col.setNotNull())
    .execute();

  await db.schema
    .alterTable("tsfga.tuples")
    .dropColumn("subject_wildcard")
    .execute();

  // The 005 shape, verbatim from `001-initial`.
  await sql`
    CREATE UNIQUE INDEX idx_tuples_unique
    ON tsfga.tuples (object_type, object_id, relation, subject_type, subject_id, COALESCE(subject_relation, ''))
  `.execute(db);
}
