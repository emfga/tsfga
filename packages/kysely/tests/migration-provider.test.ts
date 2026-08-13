import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Kysely, PostgresDialect } from "kysely";
import { Migrator } from "kysely/migration";
import pg from "pg";
import { migrationProvider, migrations } from "../src/migrations/index.ts";

/**
 * Verifies the static migrationProvider exported via
 * `@tsfga/kysely/migrations` provisions the tsfga schema from
 * scratch with Kysely's Migrator.
 *
 * Safety: the shared dev database already contains a live tsfga
 * schema managed by kysely-ctl, and running the Migrator against it
 * could conflict with (or on rollback destroy) that schema. This
 * test therefore creates a throwaway database, migrates it from
 * scratch, asserts idempotency, and drops it afterwards.
 */
describe("migrationProvider", () => {
  const scratchDb = `tsfga_migrator_test_${Date.now()}`;
  let admin: pg.Client;
  let db: Kysely<unknown>;

  beforeAll(async () => {
    admin = new pg.Client({
      host: process.env.POSTGRES_HOST,
      port: Number(process.env.POSTGRES_PORT),
      user: process.env.POSTGRES_USER,
      password: process.env.POSTGRES_PASSWORD,
      database: process.env.POSTGRES_DB,
    });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${scratchDb}`);

    db = new Kysely({
      dialect: new PostgresDialect({
        pool: new pg.Pool({
          host: process.env.POSTGRES_HOST,
          port: Number(process.env.POSTGRES_PORT),
          user: process.env.POSTGRES_USER,
          password: process.env.POSTGRES_PASSWORD,
          database: scratchDb,
          max: 1,
        }),
      }),
    });
  });

  afterAll(async () => {
    await db.destroy();
    await admin.query(`DROP DATABASE ${scratchDb} WITH (FORCE)`);
    await admin.end();
  });

  /** The declared type of one `tsfga.tuples` column. */
  async function columnType(column: string): Promise<string | undefined> {
    const columns = await db
      .withTables<{
        "information_schema.columns": {
          table_schema: string;
          table_name: string;
          column_name: string;
          data_type: string;
        };
      }>()
      .selectFrom("information_schema.columns")
      .select("data_type")
      .where("table_schema", "=", "tsfga")
      .where("table_name", "=", "tuples")
      .where("column_name", "=", column)
      .execute();
    return columns[0]?.data_type;
  }

  test("migrateToLatest provisions the tsfga schema", async () => {
    const migrator = new Migrator({ db, provider: migrationProvider });
    const { error, results } = await migrator.migrateToLatest();

    expect(error).toBe(undefined);
    expect(results).toHaveLength(Object.keys(migrations).length);
    for (const result of results ?? []) {
      expect(result.status).toBe("Success");
    }

    const tables = await db
      .withTables<{
        "information_schema.tables": {
          table_schema: string;
          table_name: string;
        };
      }>()
      .selectFrom("information_schema.tables")
      .select("table_name")
      .where("table_schema", "=", "tsfga")
      .execute();
    const names = tables.map((t) => t.table_name).sort();
    expect(names).toEqual([
      "condition_definitions",
      "relation_configs",
      "tuples",
    ]);
  });

  test("migrateToLatest is a no-op when already migrated", async () => {
    const migrator = new Migrator({ db, provider: migrationProvider });
    const { error, results } = await migrator.migrateToLatest();

    expect(error).toBe(undefined);
    expect(results).toHaveLength(0);
  });

  /**
   * `006` gives the typed wildcard a column of its own, so a real
   * subject whose id is the nil UUID becomes legal — and rolling
   * back reinstates a shape where that value *is* the wildcard.
   * Merging the two would grant a relation to every subject of the
   * type on the strength of a row written for one, in the granting
   * direction, with nothing to report it.
   *
   * So `down` counts those rows and refuses, naming them. It is
   * the only contract of the migration nothing else exercises: the
   * `up` direction is covered by every other suite in this
   * package.
   */
  test("rolling back 006 refuses a nil-UUID subject", async () => {
    const tuples = db.withTables<{
      "tsfga.tuples": {
        object_type: string;
        object_id: string;
        relation: string;
        subject_type: string;
        subject_id: string | null;
        subject_wildcard: boolean;
        created_at: Date;
        updated_at: Date;
      };
    }>();
    const now = new Date();
    // The wildcard, which rolls back cleanly onto the nil UUID,
    // and a real subject holding that same value, which does not.
    await tuples
      .insertInto("tsfga.tuples")
      .values([
        {
          object_type: "document",
          object_id: "00000000-0000-0000-0000-00000000000a",
          relation: "viewer",
          subject_type: "user",
          subject_id: null,
          subject_wildcard: true,
          created_at: now,
          updated_at: now,
        },
        {
          object_type: "document",
          object_id: "00000000-0000-0000-0000-00000000000b",
          relation: "viewer",
          subject_type: "user",
          subject_id: "00000000-0000-0000-0000-000000000000",
          subject_wildcard: false,
          created_at: now,
          updated_at: now,
        },
      ])
      .execute();

    const blocked = await new Migrator({
      db,
      provider: migrationProvider,
    }).migrateDown();
    expect(blocked.error).not.toBe(undefined);

    // The failed migration is transactional, so the column pair is
    // untouched and the row is still there to be dealt with.
    await tuples
      .deleteFrom("tsfga.tuples")
      .where("subject_id", "=", "00000000-0000-0000-0000-000000000000")
      .execute();

    const { error } = await new Migrator({
      db,
      provider: migrationProvider,
    }).migrateDown();
    expect(error).toBe(undefined);
    expect(await columnType("subject_id")).toBe("uuid");
    expect(await columnType("subject_wildcard")).toBe(undefined);
  });

  /**
   * Rolling `005` back must leave the restored column empty rather
   * than null: pre-005 core reads a null
   * `directly_assignable_types` as "no restriction", so a null
   * rollback would silently widen every relation it restores.
   */
  test("rolling back 005 restores an empty type column", async () => {
    await db
      .withTables<{
        "tsfga.relation_configs": {
          object_type: string;
          relation: string;
          directly_assignable: string;
        };
      }>()
      .insertInto("tsfga.relation_configs")
      .values({
        object_type: "document",
        relation: "viewer",
        directly_assignable: JSON.stringify([{ type: "user" }]),
      })
      .execute();

    const migrator = new Migrator({ db, provider: migrationProvider });
    const { error } = await migrator.migrateDown();
    expect(error).toBe(undefined);

    const rows = await db
      .withTables<{
        "tsfga.relation_configs": {
          object_type: string;
          directly_assignable_types: string[] | null;
        };
      }>()
      .selectFrom("tsfga.relation_configs")
      .select("directly_assignable_types")
      .where("object_type", "=", "document")
      .execute();

    expect(rows).toHaveLength(1);
    expect(rows[0]?.directly_assignable_types).not.toBeNull();
    expect(rows[0]?.directly_assignable_types).toEqual([]);
  });
});
