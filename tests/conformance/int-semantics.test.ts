import { afterAll, beforeAll, describe, test } from "bun:test";
import { createTsfga, type TsfgaClient } from "@tsfga/core";
import type { DB } from "@tsfga/kysely";
import { KyselyTupleStore } from "@tsfga/kysely";
import type { Kysely } from "kysely";
import {
  expectConfigsMatchModel,
  expectConformance,
  type FixtureRecord,
  recordFixture,
} from "./helpers/conformance.ts";
import {
  beginTransaction,
  destroyDb,
  getDb,
  rollbackTransaction,
} from "./helpers/db.ts";
import {
  fgaCreateStore,
  fgaWriteModel,
  fgaWriteTuplesRaw,
} from "./helpers/openfga.ts";

/**
 * What an `int` parameter means once it reaches CEL.
 *
 * cel-js maps a JS `number` onto CEL's `double`, so an `int`
 * context value used to arrive as the wrong type. Every arithmetic
 * binary operator raised `no such overload` where OpenFGA answers,
 * and every comparison past 2^53 answered the opposite boolean
 * without erroring — the only place tsfga was confidently wrong
 * rather than loud. Under a `but not`, a wrong `false` on the
 * subtract side inverts to a grant.
 *
 * These are the cells that moved, pinned against upstream so the
 * representation cannot quietly change back.
 */

const uuidMap = new Map<string, string>([
  ["alice", "00000000-0000-4000-ce00-000000000001"],
  ["doc", "00000000-0000-4000-ce00-000000000010"],
]);

function uuid(name: string): string {
  const id = uuidMap.get(name);
  if (!id) throw new Error(`No UUID for ${name}`);
  return id;
}

const CONDITIONS = [
  {
    name: "arith_c",
    expression:
      "n + 1 == 8 && n - 1 == 6 && n * 2 == 14 && n / 2 == 3 && n % 2 == 1",
  },
  {
    name: "precise_c",
    expression: "n == 9007199254740993 && n > 9007199254740992",
  },
  { name: "saturating_c", expression: "n == 9223372036854775807" },
  { name: "typed_c", expression: "type(n) == int" },
  { name: "overflowing_c", expression: "n + 1 > 0" },
] as const;

const RELATIONS = [
  ["arith", "arith_c"],
  ["precise", "precise_c"],
  ["saturating", "saturating_c"],
  ["typed", "typed_c"],
  ["overflowing", "overflowing_c"],
] as const;

describe("Integer Parameter Conformance", () => {
  let db: Kysely<DB>;
  let storeId: string;
  let modelId: string;
  let tsfgaClient: TsfgaClient;
  let fixture: FixtureRecord;

  beforeAll(async () => {
    db = getDb();
    await beginTransaction(db);

    const store = new KyselyTupleStore(db);
    tsfgaClient = createTsfga(store);
    fixture = recordFixture(tsfgaClient);

    for (const condition of CONDITIONS) {
      await tsfgaClient.writeConditionDefinition({
        name: condition.name,
        expression: condition.expression,
        parameters: { n: "int" },
      });
    }
    for (const [relation, condition] of RELATIONS) {
      await tsfgaClient.writeRelationConfig({
        objectType: "doc",
        relation,
        directlyAssignable: [{ type: "user", condition }],
        impliedBy: null,
        computedUserset: null,
        tupleToUserset: null,
        excludedBy: null,
        intersection: null,
      });
      await tsfgaClient.addTuple({
        objectType: "doc",
        objectId: uuid("doc"),
        relation,
        subjectType: "user",
        subjectId: uuid("alice"),
        conditionName: condition,
      });
    }

    storeId = await fgaCreateStore("int-semantics-conformance");
    modelId = await fgaWriteModel(storeId, "./int-semantics/model.dsl");
    await fgaWriteTuplesRaw(
      storeId,
      modelId,
      RELATIONS.map(([relation, condition]) => ({
        user: `user:${uuid("alice")}`,
        relation,
        object: `doc:${uuid("doc")}`,
        condition: { name: condition },
      })),
    );
  });

  afterAll(async () => {
    await rollbackTransaction(db);
    await destroyDb();
  });

  const check = (relation: string, n: unknown, expected: boolean | "refused") =>
    expectConformance(
      storeId,
      modelId,
      tsfgaClient,
      {
        objectType: "doc",
        objectId: uuid("doc"),
        relation,
        subjectType: "user",
        subjectId: uuid("alice"),
        context: { n },
      },
      expected,
    );

  test("every arithmetic operator answers, rather than erroring", async () => {
    // All five raised `no such overload: dyn<double> + int`.
    await check("arith", "7", true);
  });

  test("a magnitude past 2^53 compares exactly", async () => {
    // Answered a silent `false` before, in both directions.
    await check("precise", "9007199254740993", true);
  });

  test("an out-of-range magnitude saturates rather than answering false", async () => {
    // Upstream converts through bigFloat.Int64(), which clamps and
    // then answers on the clamped value.
    await check("saturating", "99999999999999999999999", true);
  });

  test("the value's CEL type is int", async () => {
    await check("typed", "7", true);
  });

  test("overflow at the int64 ceiling is an error on both sides", async () => {
    await check("overflowing", "9223372036854775807", "refused");
  });

  /**
   * Controls. The fix must not be a blanket coercion change that
   * breaks the overloads which already worked -- comparison,
   * membership and conversion all resolved correctly under
   * `number` and must still resolve under `bigint`.
   */
  describe("what already worked still works", () => {
    test("a below-threshold value still denies", async () => {
      await check("arith", "3", false);
    });

    test("a decimal string is still parsed", async () => {
      await check("typed", "7", true);
    });

    test("an ill-typed value is still refused by both", async () => {
      await check("arith", "abc", "refused");
    });
  });

  test("the relation configs say what the model says", () => {
    expectConfigsMatchModel("./int-semantics/model.dsl", fixture, {
      coverage: "complete",
    });
  });
});
