import { type Kysely, sql } from "kysely";

/**
 * Drops three indexes on `tsfga.tuples` that no adapter query can
 * use. See the migration notes in the package README for the
 * measurements behind each drop.
 *
 * - `idx_tuples_check` — its five columns are exactly the leading
 *   five of `idx_tuples_unique`, so every query it served is
 *   served by that index at the same buffer count.
 * - `idx_tuples_metadata` — indexes a column the adapter never
 *   writes or reads.
 * - `idx_tuples_condition` — `condition_name` is written and
 *   projected, but never appears in a predicate.
 *
 * `idx_tuples_object` and `idx_tuples_userset` are also prefixes
 * of `idx_tuples_unique` and are deliberately kept: both are far
 * narrower than it, and measurably win on the queries they serve.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  // No `.on()` — PostgreSQL's DROP INDEX names the index, not the
  // table, so the schema comes from `withSchema` rather than from
  // a dotted name (which Kysely would quote as one identifier).
  const schema = db.schema.withSchema("tsfga");
  await schema.dropIndex("idx_tuples_check").execute();
  await schema.dropIndex("idx_tuples_metadata").execute();
  await schema.dropIndex("idx_tuples_condition").execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createIndex("idx_tuples_check")
    .on("tsfga.tuples")
    .columns([
      "object_type",
      "object_id",
      "relation",
      "subject_type",
      "subject_id",
    ])
    .execute();

  // Raw SQL required — the builder cannot express USING GIN with
  // a WHERE clause.
  await sql`
    CREATE INDEX idx_tuples_metadata ON tsfga.tuples USING GIN (metadata)
    WHERE metadata IS NOT NULL
  `.execute(db);

  await db.schema
    .createIndex("idx_tuples_condition")
    .on("tsfga.tuples")
    .column("condition_name")
    .where(sql.ref("condition_name"), "is not", null)
    .execute();
}
