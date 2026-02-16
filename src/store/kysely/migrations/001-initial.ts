import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.createSchema("tsfga").ifNotExists().execute();

  // Table: tsfga.tuples
  await db.schema
    .createTable("tsfga.tuples")
    .addColumn("id", "bigint", (col) =>
      col.generatedAlwaysAsIdentity().primaryKey(),
    )
    .addColumn("object_type", "text", (col) => col.notNull())
    .addColumn("object_id", "uuid", (col) => col.notNull())
    .addColumn("relation", "text", (col) => col.notNull())
    .addColumn("subject_type", "text", (col) => col.notNull())
    .addColumn("subject_id", "uuid", (col) => col.notNull())
    .addColumn("subject_relation", "text")
    .addColumn("condition_name", "text")
    .addColumn("condition_context", "jsonb")
    .addColumn("metadata", "jsonb")
    .addColumn("created_at", "timestamptz", (col) => col.notNull())
    .addColumn("updated_at", "timestamptz", (col) => col.notNull())
    .execute();

  // Unique index with COALESCE — raw SQL required (expression index)
  await sql`
    CREATE UNIQUE INDEX idx_tuples_unique
    ON tsfga.tuples (object_type, object_id, relation, subject_type, subject_id, COALESCE(subject_relation, ''))
  `.execute(db);

  // Table: tsfga.relation_configs
  await db.schema
    .createTable("tsfga.relation_configs")
    .addColumn("id", "bigint", (col) =>
      col.generatedAlwaysAsIdentity().primaryKey(),
    )
    .addColumn("object_type", "text", (col) => col.notNull())
    .addColumn("relation", "text", (col) => col.notNull())
    .addColumn("directly_assignable_types", sql`text[]`)
    .addColumn("implied_by", sql`text[]`)
    .addColumn("computed_userset", "text")
    .addColumn("tuple_to_userset", "jsonb")
    .addColumn("allows_userset_subjects", "boolean", (col) => col.notNull())
    .addColumn("metadata", "jsonb")
    .addUniqueConstraint("relation_configs_object_type_relation_unique", [
      "object_type",
      "relation",
    ])
    .execute();

  // Table: tsfga.condition_definitions
  await db.schema
    .createTable("tsfga.condition_definitions")
    .addColumn("id", "bigint", (col) =>
      col.generatedAlwaysAsIdentity().primaryKey(),
    )
    .addColumn("name", "text", (col) => col.notNull().unique())
    .addColumn("expression", "text", (col) => col.notNull())
    .addColumn("parameters", "jsonb")
    .execute();

  // Index 1: Fast lookups by object
  await db.schema
    .createIndex("idx_tuples_object")
    .on("tsfga.tuples")
    .columns(["object_type", "object_id"])
    .execute();

  // Index 2: Fast lookups by subject (reverse queries)
  await db.schema
    .createIndex("idx_tuples_subject")
    .on("tsfga.tuples")
    .columns(["subject_type", "subject_id"])
    .execute();

  // Index 3: Fast relation checks
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

  // Index 4: Fast userset expansion (partial index)
  await db.schema
    .createIndex("idx_tuples_userset")
    .on("tsfga.tuples")
    .columns(["object_type", "object_id", "relation"])
    .where(sql.ref("subject_relation"), "is not", null)
    .execute();

  // Index 5: GIN index for metadata — raw SQL required (USING GIN + WHERE)
  await sql`
    CREATE INDEX idx_tuples_metadata ON tsfga.tuples USING GIN (metadata)
    WHERE metadata IS NOT NULL
  `.execute(db);

  // Index 6: Condition name lookup (partial index)
  await db.schema
    .createIndex("idx_tuples_condition")
    .on("tsfga.tuples")
    .column("condition_name")
    .where(sql.ref("condition_name"), "is not", null)
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("tsfga.condition_definitions").ifExists().execute();
  await db.schema.dropTable("tsfga.relation_configs").ifExists().execute();
  await db.schema.dropTable("tsfga.tuples").ifExists().execute();
  await db.schema.dropSchema("tsfga").ifExists().cascade().execute();
}
