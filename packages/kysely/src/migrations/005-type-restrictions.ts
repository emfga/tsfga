import { type Kysely, sql } from "kysely";

/**
 * Replaces `directly_assignable_types` + `allows_userset_subjects`
 * on `tsfga.relation_configs` with a single `directly_assignable`.
 *
 * The two old columns could not express what OpenFGA stores. Its
 * `directly_related_user_types` is one list whose entries name the
 * userset relation — `[user, team#member]` — whereas tsfga kept a
 * type array plus a bare boolean, recording *whether* usersets
 * were allowed and discarding *which*. A relation admitting only
 * `team#member` therefore accepted a `team#owner` tuple that
 * OpenFGA refuses outright, and granted on it.
 *
 * The old shape also overloaded `NULL`, which meant both
 * "unrestricted" and "purely computed", so a purely computed
 * relation could not say that it admits nothing at all.
 *
 * **Destructive, and deliberately not data-preserving.** There is
 * no honest automatic conversion: `allows_userset_subjects = true`
 * does not say which usersets the model intended, and `NULL` does
 * not say which types it meant to admit. Inventing either would
 * write a model the operator never authored, in the granting
 * direction. Relation configs must be rewritten from the
 * authorization model after migrating; the tuples are untouched.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("tsfga.relation_configs")
    .dropColumn("directly_assignable_types")
    .execute();

  await db.schema
    .alterTable("tsfga.relation_configs")
    .dropColumn("allows_userset_subjects")
    .execute();

  // NOT NULL with no default: `[]` is a meaningful value here —
  // "admits no direct assignment" — so a default would let a
  // caller that forgot the field silently write a relation that
  // grants nothing directly, rather than failing.
  await db.schema
    .alterTable("tsfga.relation_configs")
    .addColumn("directly_assignable", "jsonb", (col) =>
      col.notNull().defaultTo(sql`'[]'::jsonb`),
    )
    .execute();

  await db.schema
    .alterTable("tsfga.relation_configs")
    .alterColumn("directly_assignable", (col) => col.dropDefault())
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("tsfga.relation_configs")
    .dropColumn("directly_assignable")
    .execute();

  await db.schema
    .alterTable("tsfga.relation_configs")
    .addColumn("directly_assignable_types", sql`text[]`)
    .execute();

  await db.schema
    .alterTable("tsfga.relation_configs")
    // `001` declares this NOT NULL with no default; rolling
    // back onto rows that exist needs one, so it is added and
    // dropped as `up` does for the column replacing it.
    .addColumn("allows_userset_subjects", "boolean", (col) =>
      col.notNull().defaultTo(false),
    )
    .execute();

  await db.schema
    .alterTable("tsfga.relation_configs")
    .alterColumn("allows_userset_subjects", (col) => col.dropDefault())
    .execute();
}
