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
 * A tuple-to-userset's *tupleset* row can carry a condition, and
 * that condition gates the expansion.
 *
 * `define parent: [folder with flag]` plus
 * `define viewer: viewer from parent` means the link from document
 * to folder only exists while `flag` holds. tsfga read the tupleset
 * rows and dispatched on every one of them without ever evaluating
 * their conditions, so access granted through a link the model had
 * switched off. Fail-open, through the ordinary public API.
 *
 * **Two call sites, and the obvious test only covers one.** The
 * plain TTU of step 5 and the `tupleToUserset` operand of an
 * intersection are separate code paths that each read a tupleset.
 * `gated` exercises the second. It is the worse of the two: a
 * conditioned tupleset row satisfying an intersection operand
 * inside the subtrahend of an exclusion grants rather than denies.
 *
 * Probed against v1.18.2; both relations answer `false` at
 * `on: false` and `true` at `on: true`, while the unconditioned
 * link answers `true` either way.
 */

const uuidMap = new Map<string, string>([
  ["alice", "00000000-0000-4000-cb00-000000000001"],
  ["f1", "00000000-0000-4000-cb00-000000000002"],
  ["cond", "00000000-0000-4000-cb00-000000000003"],
  ["bare", "00000000-0000-4000-cb00-000000000004"],
]);

function uuid(name: string): string {
  const id = uuidMap.get(name);
  if (!id) throw new Error(`No UUID for ${name}`);
  return id;
}

describe("Tupleset Conditions Conformance", () => {
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
      name: "flag",
      expression: "on == true",
      parameters: { on: "bool" },
    });

    await tsfgaClient.writeRelationConfig({
      objectType: "folder",
      relation: "viewer",
      directlyAssignable: [{ type: "user" }],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });
    await tsfgaClient.writeRelationConfig({
      objectType: "folder",
      relation: "editor",
      directlyAssignable: [{ type: "user" }],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });
    await tsfgaClient.writeRelationConfig({
      objectType: "document",
      relation: "parent",
      directlyAssignable: [
        { type: "folder" },
        { type: "folder", condition: "flag" },
      ],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });
    await tsfgaClient.writeRelationConfig({
      objectType: "document",
      relation: "viewer",
      directlyAssignable: [],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: [{ tupleset: "parent", computedUserset: "viewer" }],
      excludedBy: null,
      intersection: null,
    });
    await tsfgaClient.writeRelationConfig({
      objectType: "document",
      relation: "gated",
      directlyAssignable: [],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: [
        {
          type: "tupleToUserset",
          tupleset: "parent",
          computedUserset: "editor",
        },
        {
          type: "tupleToUserset",
          tupleset: "parent",
          computedUserset: "viewer",
        },
      ],
    });

    await tsfgaClient.addTuple({
      objectType: "folder",
      objectId: uuid("f1"),
      relation: "viewer",
      subjectType: "user",
      subjectId: uuid("alice"),
    });
    await tsfgaClient.addTuple({
      objectType: "folder",
      objectId: uuid("f1"),
      relation: "editor",
      subjectType: "user",
      subjectId: uuid("alice"),
    });
    // The link under test: conditioned on one document, plain on
    // the other, so every case below has its own control.
    await tsfgaClient.addTuple({
      objectType: "document",
      objectId: uuid("cond"),
      relation: "parent",
      subjectType: "folder",
      subjectId: uuid("f1"),
      conditionName: "flag",
    });
    await tsfgaClient.addTuple({
      objectType: "document",
      objectId: uuid("bare"),
      relation: "parent",
      subjectType: "folder",
      subjectId: uuid("f1"),
    });

    storeId = await fgaCreateStore("tupleset-conditions-conformance");
    authorizationModelId = await fgaWriteModel(
      storeId,
      "./tupleset-conditions/model.dsl",
    );
    await fgaWriteTuples(
      storeId,
      "./tupleset-conditions/tuples.yaml",
      authorizationModelId,
      uuidMap,
    );
  });

  afterAll(async () => {
    await rollbackTransaction(db);
    await destroyDb();
  });

  async function expectAccess(
    relation: string,
    object: string,
    on: boolean,
    expected: boolean,
  ): Promise<void> {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "document",
        objectId: uuid(object),
        relation,
        subjectType: "user",
        subjectId: uuid("alice"),
        context: { on },
      },
      expected,
    );
  }

  describe("a plain tuple-to-userset", () => {
    test("expands through a satisfied tupleset condition", async () => {
      await expectAccess("viewer", "cond", true, true);
    });

    test("does not expand through an unsatisfied one", async () => {
      // The fail-open case. tsfga dispatched on the tupleset row
      // without looking at its condition, so it granted here.
      await expectAccess("viewer", "cond", false, false);
    });

    test("an unconditioned link is unaffected by the context", async () => {
      await expectAccess("viewer", "bare", true, true);
      await expectAccess("viewer", "bare", false, true);
    });
  });

  describe("a tupleToUserset intersection operand", () => {
    // The second call site. A test of the plain TTU alone passes
    // with this one still granting.
    test("expands through a satisfied tupleset condition", async () => {
      await expectAccess("gated", "cond", true, true);
    });

    test("does not expand through an unsatisfied one", async () => {
      await expectAccess("gated", "cond", false, false);
    });

    test("an unconditioned link is unaffected by the context", async () => {
      await expectAccess("gated", "bare", true, true);
      await expectAccess("gated", "bare", false, true);
    });
  });

  test("the relation configs say what the model says", () => {
    expectConfigsMatchModel("./tupleset-conditions/model.dsl", fixture, {
      coverage: "complete",
    });
  });
});
