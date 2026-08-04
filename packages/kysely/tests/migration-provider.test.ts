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
});
