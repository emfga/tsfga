import type { Kysely } from "kysely";

/**
 * Drops the `metadata` column from `tsfga.tuples` and
 * `tsfga.relation_configs`.
 *
 * Neither column was reachable through the library. `@tsfga/core`
 * has no metadata concept on `Tuple` or `RelationConfig`, and the
 * adapter never wrote, read, or filtered the column — it appeared
 * only in the generated `schema.ts`. Nothing tsfga does could
 * populate it.
 *
 * Destructive, and not fully reversible: `down` restores the
 * columns but not their contents. That matters only for a
 * consumer who wrote to them out of band through their own
 * `Kysely<DB>` handle, since the exported `DB` type made the
 * columns type-visible even though no adapter method touched
 * them. Such a consumer should copy the data out before
 * migrating.
 *
 * The GIN index that covered `tuples.metadata` is already gone,
 * dropped in `003-drop-unused-indexes`.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("tsfga.tuples").dropColumn("metadata").execute();

  await db.schema
    .alterTable("tsfga.relation_configs")
    .dropColumn("metadata")
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("tsfga.tuples")
    .addColumn("metadata", "jsonb")
    .execute();

  await db.schema
    .alterTable("tsfga.relation_configs")
    .addColumn("metadata", "jsonb")
    .execute();

  // No index to restore here: `003-drop-unused-indexes` owns
  // `idx_tuples_metadata`, and rolling back reaches this
  // migration first, so the column is back before that `down`
  // recreates the index on it.
}
