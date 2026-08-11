import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { InvalidStoredDataError } from "@tsfga/core";
import type { Kysely } from "kysely";
import { KyselyTupleStore } from "../src/adapter.ts";
import type { DB, Json } from "../src/schema.ts";
import {
  beginTransaction,
  destroyDb,
  getDb,
  rollbackTransaction,
} from "./helpers/db.ts";

/**
 * Validation of JSON columns at the adapter boundary. Each test
 * inserts a malformed row directly (bypassing the adapter's write
 * path) and asserts the corresponding read throws
 * InvalidStoredDataError. Together these cover every throw site in
 * the four JSON parsers of KyselyTupleStore.
 */
describe("Invalid stored data", () => {
  let db: Kysely<DB>;
  let store: KyselyTupleStore;

  const uuid1 = "00000000-0000-0000-0000-000000000101";
  const uuid2 = "00000000-0000-0000-0000-000000000102";

  beforeAll(() => {
    db = getDb();
    store = new KyselyTupleStore(db);
  });

  beforeEach(async () => {
    await rollbackTransaction(db);
    await beginTransaction(db);
  });

  afterEach(async () => {
    await rollbackTransaction(db);
  });

  afterAll(async () => {
    await destroyDb();
  });

  async function insertConfigRow(columns: {
    directly_assignable?: Json;
    tuple_to_userset?: Json;
    intersection?: Json;
  }): Promise<void> {
    await db
      .insertInto("tsfga.relation_configs")
      .values({
        object_type: "malformed",
        relation: "rel",
        directly_assignable: columns.directly_assignable ?? JSON.stringify([]),
        implied_by: null,
        computed_userset: null,
        tuple_to_userset: columns.tuple_to_userset ?? null,
        excluded_by: null,
        intersection: columns.intersection ?? null,
      })
      .execute();
  }

  async function insertConditionRow(parameters: Json): Promise<void> {
    await db
      .insertInto("tsfga.condition_definitions")
      .values({
        name: "malformed",
        expression: "true",
        parameters,
      })
      .execute();
  }

  describe("relation_configs.directly_assignable", () => {
    test("throws when value is not an array", async () => {
      await insertConfigRow({
        directly_assignable: JSON.stringify({ user: true }),
      });
      await expect(
        store.findRelationConfig("malformed", "rel"),
      ).rejects.toBeInstanceOf(InvalidStoredDataError);
    });

    test("throws when an element is not a string", async () => {
      await insertConfigRow({ directly_assignable: JSON.stringify([1]) });
      await expect(
        store.findRelationConfig("malformed", "rel"),
      ).rejects.toBeInstanceOf(InvalidStoredDataError);
    });
  });

  describe("relation_configs.tuple_to_userset", () => {
    test("throws when value is not an array", async () => {
      await insertConfigRow({
        tuple_to_userset: JSON.stringify({ tupleset: "t" }),
      });
      await expect(
        store.findRelationConfig("malformed", "rel"),
      ).rejects.toBeInstanceOf(InvalidStoredDataError);
    });

    test("throws when an element is not an object", async () => {
      await insertConfigRow({
        tuple_to_userset: JSON.stringify([1]),
      });
      await expect(
        store.findRelationConfig("malformed", "rel"),
      ).rejects.toBeInstanceOf(InvalidStoredDataError);
    });

    test("throws when element fields are not strings", async () => {
      await insertConfigRow({
        tuple_to_userset: JSON.stringify([
          { tupleset: 1, computedUserset: "member" },
        ]),
      });
      await expect(
        store.findRelationConfig("malformed", "rel"),
      ).rejects.toBeInstanceOf(InvalidStoredDataError);
    });
  });

  describe("relation_configs.intersection", () => {
    test("throws when value is not an array", async () => {
      await insertConfigRow({
        intersection: JSON.stringify({ type: "direct" }),
      });
      await expect(
        store.findRelationConfig("malformed", "rel"),
      ).rejects.toBeInstanceOf(InvalidStoredDataError);
    });

    test("throws when an operand is not an object", async () => {
      await insertConfigRow({
        intersection: JSON.stringify(["direct"]),
      });
      await expect(
        store.findRelationConfig("malformed", "rel"),
      ).rejects.toBeInstanceOf(InvalidStoredDataError);
    });

    test("throws when computedUserset operand lacks relation", async () => {
      await insertConfigRow({
        intersection: JSON.stringify([{ type: "computedUserset" }]),
      });
      await expect(
        store.findRelationConfig("malformed", "rel"),
      ).rejects.toBeInstanceOf(InvalidStoredDataError);
    });

    test("throws when tupleToUserset operand lacks fields", async () => {
      await insertConfigRow({
        intersection: JSON.stringify([
          { type: "tupleToUserset", tupleset: "owner" },
        ]),
      });
      await expect(
        store.findRelationConfig("malformed", "rel"),
      ).rejects.toBeInstanceOf(InvalidStoredDataError);
    });

    test("throws on unknown operand type", async () => {
      await insertConfigRow({
        intersection: JSON.stringify([{ type: "union" }]),
      });
      await expect(
        store.findRelationConfig("malformed", "rel"),
      ).rejects.toBeInstanceOf(InvalidStoredDataError);
    });
  });

  describe("condition_definitions.parameters", () => {
    test("throws when value is not an object", async () => {
      await insertConditionRow(JSON.stringify(["string"]));
      await expect(
        store.findConditionDefinition("malformed"),
      ).rejects.toBeInstanceOf(InvalidStoredDataError);
    });

    test("throws on unknown parameter type", async () => {
      await insertConditionRow(JSON.stringify({ region: "varchar" }));
      await expect(
        store.findConditionDefinition("malformed"),
      ).rejects.toBeInstanceOf(InvalidStoredDataError);
    });

    test("throws on non-string parameter type", async () => {
      await insertConditionRow(JSON.stringify({ region: 42 }));
      await expect(
        store.findConditionDefinition("malformed"),
      ).rejects.toBeInstanceOf(InvalidStoredDataError);
    });
  });

  describe("tuples.condition_context", () => {
    test("throws when value is not an object", async () => {
      const now = new Date();
      await db
        .insertInto("tsfga.tuples")
        .values({
          object_type: "doc",
          object_id: uuid1,
          relation: "viewer",
          subject_type: "user",
          subject_id: uuid2,
          subject_relation: null,
          condition_name: "in_region",
          condition_context: JSON.stringify([1, 2]),
          created_at: now,
          updated_at: now,
        })
        .execute();

      await expect(
        store.findCheckTuples({
          objectType: "doc",
          objectId: uuid1,
          relation: "viewer",
          subjectType: "user",
          subjectId: uuid2,
          directRefs: null,
          wildcardRefs: [],
          usersetRefs: [],
        }),
      ).rejects.toBeInstanceOf(InvalidStoredDataError);
    });
  });
});
