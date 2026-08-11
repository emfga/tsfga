import { afterAll, beforeAll, describe, test } from "bun:test";
import { createTsfga, type TsfgaClient } from "@tsfga/core";
import type { DB } from "@tsfga/kysely";
import { KyselyTupleStore } from "@tsfga/kysely";
import type { Kysely } from "kysely";
import { expectConformance } from "./helpers/conformance.ts";
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
 * Refusal as an outcome both engines can share.
 *
 * `fgaCheck` used to collapse every failure into `null` and
 * `expectConformance` turned `null` into a thrown error, so a check
 * OpenFGA refuses could only ever *fail* a test -- never satisfy
 * one. That made a whole class of parity assertions inexpressible,
 * and it is the class the coercion matrix mostly lives in: the two
 * engines frequently disagree about whether a request is even
 * answerable, which is a divergence exactly as real as disagreeing
 * about `true` and `false`.
 *
 * This file is the proof that the assertion can now be written, and
 * the guard that "refused" does not quietly become the answer to
 * everything.
 */

const uuidMap = new Map<string, string>([
  ["alice", "00000000-0000-4000-cb00-000000000001"],
  ["report", "00000000-0000-4000-cb00-000000000010"],
]);

function uuid(name: string): string {
  const id = uuidMap.get(name);
  if (!id) throw new Error(`No UUID for ${name}`);
  return id;
}

describe("Check Refusal Conformance", () => {
  let db: Kysely<DB>;
  let storeId: string;
  let modelId: string;
  let tsfgaClient: TsfgaClient;

  beforeAll(async () => {
    db = getDb();
    await beginTransaction(db);

    const store = new KyselyTupleStore(db);
    tsfgaClient = createTsfga(store);

    await tsfgaClient.writeConditionDefinition({
      name: "at_least",
      expression: "n >= 10",
      parameters: { n: "int" },
    });
    await tsfgaClient.writeRelationConfig({
      objectType: "report",
      relation: "viewer",
      directlyAssignable: [{ type: "user", condition: "at_least" }],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });
    await tsfgaClient.addTuple({
      objectType: "report",
      objectId: uuid("report"),
      relation: "viewer",
      subjectType: "user",
      subjectId: uuid("alice"),
      conditionName: "at_least",
    });

    storeId = await fgaCreateStore("check-refusal-conformance");
    modelId = await fgaWriteModel(storeId, "./check-refusal/model.dsl");
    await fgaWriteTuplesRaw(storeId, modelId, [
      {
        user: `user:${uuid("alice")}`,
        relation: "viewer",
        object: `report:${uuid("report")}`,
        condition: { name: "at_least" },
      },
    ]);
  });

  afterAll(async () => {
    await rollbackTransaction(db);
    await destroyDb();
  });

  test("both engines refuse a context value they cannot read", async () => {
    // `1_000` is a legal integer literal in several languages and
    // in neither engine's context grammar. This assertion could not
    // be written at all before refusal became an outcome.
    await expectConformance(
      storeId,
      modelId,
      tsfgaClient,
      {
        objectType: "report",
        objectId: uuid("report"),
        relation: "viewer",
        subjectType: "user",
        subjectId: uuid("alice"),
        context: { n: "1_000" },
      },
      "refused",
    );
  });

  /**
   * The control. Without these, "refused" would be satisfied by a
   * helper that reported refusal for everything, which is the
   * failure mode the previous shape actually had.
   */
  test("a readable context is answered, not refused", async () => {
    await expectConformance(
      storeId,
      modelId,
      tsfgaClient,
      {
        objectType: "report",
        objectId: uuid("report"),
        relation: "viewer",
        subjectType: "user",
        subjectId: uuid("alice"),
        context: { n: 50 },
      },
      true,
    );
  });

  test("a readable context that denies is answered false", async () => {
    await expectConformance(
      storeId,
      modelId,
      tsfgaClient,
      {
        objectType: "report",
        objectId: uuid("report"),
        relation: "viewer",
        subjectType: "user",
        subjectId: uuid("alice"),
        context: { n: 1 },
      },
      false,
    );
  });
});
