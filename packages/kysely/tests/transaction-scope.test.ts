import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { CamelCasePlugin, Kysely, PostgresDialect } from "kysely";
import pg from "pg";
import { KyselyTupleStore } from "../src/adapter.ts";
import type { DB } from "../src/schema.ts";

/**
 * `KyselyTupleStore` strips the instance's plugins, and Kysely
 * expresses a transaction as a `Kysely` subtype rather than as a
 * separate handle. So stripping plugins must not also strip the
 * transaction — if it did, `new KyselyTupleStore(trx)` would
 * silently write outside the caller's transaction, which no other
 * test in this package would catch: they all share one pooled
 * connection wrapped in a raw `BEGIN`.
 *
 * This file therefore owns its pool. Two connections is the
 * minimum that expresses the invariant — one held by the
 * transaction, one for the read that must not see into it — and no
 * more than that, because the runtime shims run test files as
 * separate processes and the server's connection slots are shared.
 */
describe("transaction scoping", () => {
  let pool: pg.Pool;
  let db: Kysely<DB>;

  const objectId = "00000000-0000-0000-0000-0000000000aa";

  beforeAll(() => {
    pool = new pg.Pool({
      host: process.env.POSTGRES_HOST,
      port: Number(process.env.POSTGRES_PORT),
      user: process.env.POSTGRES_USER,
      password: process.env.POSTGRES_PASSWORD,
      database: process.env.POSTGRES_DB,
      max: 2,
    });
    db = new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
  });

  afterAll(async () => {
    await db.destroy();
  });

  for (const [name, instance] of [
    ["a plain instance", () => db],
    ["an instance with plugins", () => db.withPlugin(new CamelCasePlugin())],
  ] as const) {
    test(`a store over a transaction of ${name} stays in it`, async () => {
      const outside = new KyselyTupleStore(db);
      // Thrown to roll the transaction back, and rethrown by
      // Kysely, so catching it below is the success path.
      const sentinel = new Error("roll back");
      let rolledBack = false;

      try {
        await instance()
          .transaction()
          .execute(async (trx) => {
            const inside = new KyselyTupleStore(trx);
            await inside.insertTuple({
              objectType: "probe",
              objectId,
              relation: "reader",
              subjectType: "user",
              subjectId: objectId,
            });

            expect(
              await inside.findTuplesByRelation("probe", objectId, "reader"),
            ).toHaveLength(1);
            expect(
              await outside.findTuplesByRelation("probe", objectId, "reader"),
            ).toHaveLength(0);

            throw sentinel;
          });
      } catch (error) {
        rolledBack = error === sentinel;
      }
      expect(rolledBack).toBe(true);

      expect(
        await outside.findTuplesByRelation("probe", objectId, "reader"),
      ).toHaveLength(0);
    });
  }
});
