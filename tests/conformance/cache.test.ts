import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import { transformer } from "@openfga/syntax-transformer";
import {
  type AddTupleRequest,
  createTsfga,
  type RelationConfig,
  type TsfgaClient,
  TsfgaError,
} from "@tsfga/core";
import type { DB } from "@tsfga/kysely";
import { KyselyTupleStore } from "@tsfga/kysely";
import type { Kysely } from "kysely";
import {
  type CheckOutcome,
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
  fgaWriteModelOutcome,
  fgaWriteTuplesRaw,
} from "./helpers/openfga.ts";

/**
 * The caching layers, probed where sharing a cache entry could
 * hand one question's answer to another.
 *
 * `conditions.ts` caches compiled expressions **by source text**,
 * so three conditions declaring three different parameter types
 * over one expression — `p.size() > 0` on a `string`, a
 * `list<string>` and a `map<string>` — share a single cache entry.
 * The verdict that must *not* be shared is the type check, which
 * is a property of the definition rather than of the expression.
 *
 * Redefinition is the other half: the key is the source text, so a
 * condition rewritten under the same name is a new key, and the
 * old compiled entry must not answer for it. Upstream reaches the
 * same place by writing a new authorization model, which is what
 * `model-v2.dsl` is.
 */

const USER = "user_d5c";
const DOC = "doc_d5c";

const ALICE = "00000000-0000-4000-d560-000000010001";
const DOC1 = "00000000-0000-4000-d560-000000010002";

const EXPRESSION = "p.size() > 0";

/** A second shared expression, for the verdict-caching cell. */
const COMPARISON = "q > 0";

const CONDITIONS = [
  { name: "size_str_d5", parameters: { p: "string" } },
  { name: "size_list_d5", parameters: { p: "list<string>" } },
  { name: "size_map_d5", parameters: { p: "map<string>" } },
] as const;

function config(relation: string, condition: string): RelationConfig {
  return {
    objectType: DOC,
    relation,
    directlyAssignable: [{ type: USER, condition }],
    impliedBy: null,
    computedUserset: null,
    tupleToUserset: null,
    excludedBy: null,
    intersection: null,
  };
}

const CONFIGS: RelationConfig[] = [
  config("str_view", "size_str_d5"),
  config("list_view", "size_list_d5"),
  config("map_view", "size_map_d5"),
];

const TUPLES: AddTupleRequest[] = [
  {
    objectType: DOC,
    objectId: DOC1,
    relation: "str_view",
    subjectType: USER,
    subjectId: ALICE,
    conditionName: "size_str_d5",
  },
  {
    objectType: DOC,
    objectId: DOC1,
    relation: "list_view",
    subjectType: USER,
    subjectId: ALICE,
    conditionName: "size_list_d5",
  },
  {
    objectType: DOC,
    objectId: DOC1,
    relation: "map_view",
    subjectType: USER,
    subjectId: ALICE,
    conditionName: "size_map_d5",
  },
];

describe("D5 condition caches", () => {
  let db: Kysely<DB>;
  let storeId: string;
  let modelV1: string;
  let client: TsfgaClient;
  let fixture: FixtureRecord;

  beforeAll(async () => {
    db = getDb();
    await beginTransaction(db);

    client = createTsfga(new KyselyTupleStore(db));
    fixture = recordFixture(client);

    for (const condition of CONDITIONS) {
      await client.writeConditionDefinition({
        name: condition.name,
        expression: EXPRESSION,
        parameters: { ...condition.parameters },
      });
    }
    for (const relationConfig of CONFIGS) {
      await client.writeRelationConfig(relationConfig);
    }
    for (const tuple of TUPLES) {
      await client.addTuple(tuple);
    }

    storeId = await fgaCreateStore("cache");
    modelV1 = await fgaWriteModel(storeId, "./cache/model.dsl");
    await fgaWriteTuplesRaw(
      storeId,
      modelV1,
      TUPLES.map((tuple) => ({
        user: `${tuple.subjectType}:${tuple.subjectId}`,
        relation: tuple.relation,
        object: `${tuple.objectType}:${tuple.objectId}`,
        ...(tuple.conditionName
          ? { condition: { name: tuple.conditionName } }
          : {}),
      })),
    );
  });

  afterAll(async () => {
    await rollbackTransaction(db);
    await destroyDb();
  });

  describe("one expression, three declared parameter types", () => {
    const cells: ReadonlyArray<
      readonly [string, Record<string, unknown>, CheckOutcome]
    > = [
      ["str_view", { p: "ab" }, true],
      ["str_view", { p: "" }, false],
      ["list_view", { p: ["x"] }, true],
      ["list_view", { p: [] }, false],
      ["map_view", { p: { k: "v" } }, true],
      ["map_view", { p: {} }, false],
      // Each condition fed the *other's* value. The expression is
      // one cache entry; the coercion is not, so a value of the
      // wrong declared type must be refused rather than sized.
      ["str_view", { p: ["x"] }, "refused"],
      ["str_view", { p: { k: "v" } }, "refused"],
      ["list_view", { p: "ab" }, "refused"],
      ["map_view", { p: ["x"] }, "refused"],
    ];

    for (const [relation, context, expected] of cells) {
      test(`${relation} with ${JSON.stringify(context)} is ${expected}`, async () => {
        await expectConformance(
          storeId,
          modelV1,
          client,
          {
            objectType: DOC,
            objectId: DOC1,
            relation,
            subjectType: USER,
            subjectId: ALICE,
            context,
          },
          expected,
        );
      });
    }

    test("a warm cache entry does not excuse a failing type check", async () => {
      // `q > 0` is compiled and cached by the `int` definition, so
      // the `string` one that follows shares its entry. It must
      // still be refused: the type check belongs to the
      // definition, and reading the cached verdict would accept a
      // condition upstream refuses the whole model for.
      //
      // This used to be spelled with `p.size() > 0` on a `bool`,
      // which is a shorter route to the same point but no longer
      // reaches it: cel-js reports a `size()` with no matching
      // overload the same way it reports the five conversions
      // cel-go declares and it does not, and `typeVerdict`
      // suppresses that whole family. `cel-gate` pins the
      // divergence that leaves (ledger mechanism M7). A comparison
      // is a cel-js *operator*, which the type gate still enforces
      // and which is where the three cells §4.2 credits it with
      // live.
      await client.writeConditionDefinition({
        name: "cmp_int_d5",
        expression: COMPARISON,
        parameters: { q: "int" },
      });
      const write = client.writeConditionDefinition({
        name: "cmp_str_d5",
        expression: COMPARISON,
        parameters: { q: "string" },
      });
      await expect(write).rejects.toBeInstanceOf(TsfgaError);

      const bad = transformer.transformDSLToJSONObject(
        fs.readFileSync("./cache/model-bad.dsl", "utf-8"),
      );
      const outcome = await fgaWriteModelOutcome(storeId, bad);
      expect(typeof outcome === "string" ? outcome : outcome.outcome).toBe(
        "refused",
      );
    });
  });

  describe("redefinition under the same name", () => {
    let modelV2: string;

    beforeAll(async () => {
      // The source text is the cache key, so the rewrite is a new
      // key and the old entry must never answer for it.
      await client.writeConditionDefinition({
        name: "size_str_d5",
        expression: "p.size() > 1",
        parameters: { p: "string" },
      });
      modelV2 = await fgaWriteModel(storeId, "./cache/model-v2.dsl");
    });

    const cells: ReadonlyArray<
      readonly [Record<string, unknown>, CheckOutcome]
    > = [
      [{ p: "a" }, false],
      [{ p: "ab" }, true],
      [{ p: "" }, false],
    ];

    for (const [context, expected] of cells) {
      test(`str_view with ${JSON.stringify(context)} is ${expected} after the rewrite`, async () => {
        await expectConformance(
          storeId,
          modelV2,
          client,
          {
            objectType: DOC,
            objectId: DOC1,
            relation: "str_view",
            subjectType: USER,
            subjectId: ALICE,
            context,
          },
          expected,
        );
      });
    }

    test("the conditions sharing the old expression are untouched", async () => {
      for (const [relation, context, expected] of [
        ["list_view", { p: ["x"] }, true],
        ["map_view", { p: {} }, false],
      ] as const) {
        await expectConformance(
          storeId,
          modelV2,
          client,
          {
            objectType: DOC,
            objectId: DOC1,
            relation,
            subjectType: USER,
            subjectId: ALICE,
            context,
          },
          expected,
        );
      }
    });
  });

  test("the relation configs say what the model says", () => {
    expectConfigsMatchModel("./cache/model.dsl", fixture, {
      coverage: "complete",
    });
  });
});
