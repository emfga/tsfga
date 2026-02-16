import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  FileMigrationProvider,
  Kysely,
  Migrator,
  PostgresDialect,
  sql,
} from "kysely";
import pg from "pg";
import type { DB } from "src/store/kysely/schema.ts";

async function waitForPostgres(maxRetries = 30): Promise<void> {
  const pool = new pg.Pool({
    host: process.env.POSTGRES_HOST,
    port: Number(process.env.POSTGRES_PORT),
    user: process.env.POSTGRES_USER,
    password: process.env.POSTGRES_PASSWORD,
    database: process.env.POSTGRES_DB,
  });

  let lastError: unknown | null = null;

  for (let i = 0; i < maxRetries; i++) {
    try {
      await pool.query("SELECT 1");
      await pool.end();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  await pool.end();
  throw new Error("PostgreSQL not ready after retries", { cause: lastError });
}

async function waitForOpenFGA(maxRetries = 30): Promise<void> {
  const url = process.env.FGA_API_URL;

  let lastError: unknown | null = null;
  for (let i = 0; i < maxRetries; i++) {
    try {
      const resp = await fetch(`${url}/stores`);
      if (resp.ok) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("OpenFGA not ready after retries", { cause: lastError });
}

async function runMigrations(): Promise<void> {
  const pool = new pg.Pool({
    host: process.env.POSTGRES_HOST,
    port: Number(process.env.POSTGRES_PORT),
    user: process.env.POSTGRES_USER,
    password: process.env.POSTGRES_PASSWORD,
    database: process.env.POSTGRES_DB,
  });

  const db = new Kysely<DB>({
    dialect: new PostgresDialect({ pool }),
  });

  // Drop tsfga schema and Kysely migration state for clean state
  await sql`DROP SCHEMA IF EXISTS tsfga CASCADE`.execute(db);
  await sql`DROP TABLE IF EXISTS kysely_migration`.execute(db);
  await sql`DROP TABLE IF EXISTS kysely_migration_lock`.execute(db);

  const migrator = new Migrator({
    db,
    provider: new FileMigrationProvider({
      fs,
      path,
      migrationFolder: path.resolve("src/store/kysely/migrations"),
    }),
  });

  const { error, results } = await migrator.migrateToLatest();

  for (const r of results ?? []) {
    if (r.status === "Error") {
      console.error(`Migration ${r.migrationName} failed`);
    }
  }

  if (error) {
    await db.destroy();
    throw error;
  }

  await db.destroy();
}

export async function setupInfrastructure(): Promise<void> {
  // Start Docker services
  const proc = Bun.spawn(["docker", "compose", "up", "-d", "--wait"], {
    cwd: process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
  });
  await proc.exited;

  // Wait for services
  await waitForPostgres();
  await waitForOpenFGA();

  // Run Kysely migrations
  await runMigrations();
}
