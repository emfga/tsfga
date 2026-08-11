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
  fgaWriteTuples,
} from "./helpers/openfga.ts";

/**
 * A context value is read as its declared parameter type, or the
 * check fails — it is never quietly compared as whatever JSON
 * happened to carry.
 *
 * `n: int` given `4.5` is the case that matters. tsfga passed the
 * number through, CEL compared it, `4.5 >= 40` was `false`, and
 * the condition read as *unmet*. An unmet condition on the
 * subtract side of an `excludedBy` means the exclusion does not
 * fire, so a mistyped context value **grants**. OpenFGA raises a
 * parameter type error instead.
 *
 * `n: int` given `"42"` is the mirror, and the reason a `typeof`
 * check is not the fix: JSON has no integer type, so OpenFGA
 * *parses* numeric strings and accepts this. tsfga threw.
 */

const uuidMap = new Map<string, string>([
  ["alice", "00000000-0000-4000-cc00-000000000001"],
  ["d1", "00000000-0000-4000-cc00-000000000002"],
]);

function uuid(name: string): string {
  const id = uuidMap.get(name);
  if (!id) throw new Error(`No UUID for ${name}`);
  return id;
}

describe("Condition Coercion Conformance", () => {
  let db: Kysely<DB>;
  let storeId: string;
  let authorizationModelId: string;
  let tsfgaClient: TsfgaClient;
  let fixture: FixtureRecord;

  beforeAll(async () => {
    db = getDb();
    await beginTransaction(db);

    const store = new KyselyTupleStore(db);
    tsfgaClient = createTsfga(store);
    fixture = recordFixture(tsfgaClient);

    await tsfgaClient.writeConditionDefinition({
      name: "at_least",
      expression: "n >= 40",
      parameters: { n: "int" },
    });
    await tsfgaClient.writeRelationConfig({
      objectType: "doc",
      relation: "v",
      directlyAssignable: [{ type: "user", condition: "at_least" }],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });
    await tsfgaClient.addTuple({
      objectType: "doc",
      objectId: uuid("d1"),
      relation: "v",
      subjectType: "user",
      subjectId: uuid("alice"),
      conditionName: "at_least",
    });

    storeId = await fgaCreateStore("condition-coercion-conformance");
    authorizationModelId = await fgaWriteModel(
      storeId,
      "./condition-coercion/model.dsl",
    );
    await fgaWriteTuples(
      storeId,
      "./condition-coercion/tuples.yaml",
      authorizationModelId,
      uuidMap,
    );
  });

  afterAll(async () => {
    await rollbackTransaction(db);
    await destroyDb();
  });

  const request = (n: unknown) => ({
    objectType: "doc",
    objectId: uuid("d1"),
    relation: "v",
    subjectType: "user",
    subjectId: uuid("alice"),
    context: { n },
  });

  /** Both systems must refuse to answer, not answer differently. */
  async function expectBothRefuse(n: unknown): Promise<void> {
    // Refusal is an outcome both engines can report, so this is
    // the ordinary conformance assertion rather than a bespoke
    // one that reads an error as an absent answer.
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      request(n),
      "refused",
    );
  }

  describe("a numeric string is parsed, not rejected", () => {
    test("an int parameter accepts 42", async () => {
      await expectConformance(
        storeId,
        authorizationModelId,
        tsfgaClient,
        request(42),
        true,
      );
    });

    test('an int parameter accepts "42"', async () => {
      // JSON has no integer type, so OpenFGA parses the string.
      // tsfga used to hand it to CEL as a string and throw.
      await expectConformance(
        storeId,
        authorizationModelId,
        tsfgaClient,
        request("42"),
        true,
      );
    });

    test('an int parameter accepts "7", below the threshold', async () => {
      // Parsed and then genuinely unmet, which is a `false` both
      // systems agree on — distinct from a refusal.
      await expectConformance(
        storeId,
        authorizationModelId,
        tsfgaClient,
        request("7"),
        false,
      );
    });
  });

  describe("an ill-typed value is refused, not read as false", () => {
    test("a non-integer number", async () => {
      // The fail-open one: `4.5 >= 40` is `false`, and a `false`
      // condition under a `but not` does not exclude.
      await expectBothRefuse(4.5);
    });

    test("a non-numeric string", async () => {
      await expectBothRefuse("abc");
    });

    test("a boolean", async () => {
      await expectBothRefuse(true);
    });
  });

  test("the relation configs say what the model says", () => {
    expectConfigsMatchModel("./condition-coercion/model.dsl", fixture, {
      coverage: "complete",
    });
  });
});
