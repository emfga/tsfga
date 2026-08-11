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

// Ref: OpenFGA sample store "expenses"
// Tests recursive self-referential TTU: can_manage from manager

const uuidMap = new Map<string, string>([
  ["A", "00000000-0000-4000-bd00-000000000001"],
  ["B", "00000000-0000-4000-bd00-000000000002"],
  ["C", "00000000-0000-4000-bd00-000000000003"],
  ["D", "00000000-0000-4000-bd00-000000000004"],
  ["expense_1", "00000000-0000-4000-bd00-000000000005"],
]);

function uuid(name: string): string {
  const id = uuidMap.get(name);
  if (!id) throw new Error(`No UUID for ${name}`);
  return id;
}

describe("Expenses Model Conformance", () => {
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

    // === Relation configs ===

    // employee.manager: [employee]
    await tsfgaClient.writeRelationConfig({
      objectType: "employee",
      relation: "manager",
      directlyAssignable: ["employee"],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });

    // employee.can_manage: manager or can_manage from manager
    await tsfgaClient.writeRelationConfig({
      objectType: "employee",
      relation: "can_manage",
      directlyAssignable: [],
      impliedBy: ["manager"],
      computedUserset: null,
      tupleToUserset: [{ tupleset: "manager", computedUserset: "can_manage" }],
      excludedBy: null,
      intersection: null,
    });

    // report.submitter: [employee]
    await tsfgaClient.writeRelationConfig({
      objectType: "report",
      relation: "submitter",
      directlyAssignable: ["employee"],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });

    // report.can_approve: can_manage from submitter
    await tsfgaClient.writeRelationConfig({
      objectType: "report",
      relation: "can_approve",
      directlyAssignable: [],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: [
        { tupleset: "submitter", computedUserset: "can_manage" },
      ],
      excludedBy: null,
      intersection: null,
    });

    // === Tuples ===
    // Management chain: A manages B, B manages C, C manages D
    await tsfgaClient.addTuple({
      objectType: "employee",
      objectId: uuid("B"),
      relation: "manager",
      subjectType: "employee",
      subjectId: uuid("A"),
    });
    await tsfgaClient.addTuple({
      objectType: "employee",
      objectId: uuid("C"),
      relation: "manager",
      subjectType: "employee",
      subjectId: uuid("B"),
    });
    await tsfgaClient.addTuple({
      objectType: "employee",
      objectId: uuid("D"),
      relation: "manager",
      subjectType: "employee",
      subjectId: uuid("C"),
    });

    // Report submitted by employee D
    await tsfgaClient.addTuple({
      objectType: "report",
      objectId: uuid("expense_1"),
      relation: "submitter",
      subjectType: "employee",
      subjectId: uuid("D"),
    });

    // Setup OpenFGA
    storeId = await fgaCreateStore("expenses-conformance");
    authorizationModelId = await fgaWriteModel(storeId, "./expenses/model.dsl");
    await fgaWriteTuples(
      storeId,
      "./expenses/tuples.yaml",
      authorizationModelId,
      uuidMap,
    );
  });

  afterAll(async () => {
    await rollbackTransaction(db);
    await destroyDb();
  });

  // --- Direct manager ---
  test("1: C can_manage D (direct manager)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "employee",
        objectId: uuid("D"),
        relation: "can_manage",
        subjectType: "employee",
        subjectId: uuid("C"),
      },
      true,
    );
  });

  // --- Transitive management ---
  test("2: A can_manage D (transitive: A->B->C->D)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "employee",
        objectId: uuid("D"),
        relation: "can_manage",
        subjectType: "employee",
        subjectId: uuid("A"),
      },
      true,
    );
  });

  // --- Report approval through management chain ---
  test("3: A can_approve report:expense_1 (submitted by D)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "report",
        objectId: uuid("expense_1"),
        relation: "can_approve",
        subjectType: "employee",
        subjectId: uuid("A"),
      },
      true,
    );
  });

  // --- Negative: cannot self-approve ---
  test("4: D cannot can_approve own report:expense_1", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "report",
        objectId: uuid("expense_1"),
        relation: "can_approve",
        subjectType: "employee",
        subjectId: uuid("D"),
      },
      false,
    );
  });

  // --- Negative: subordinate cannot manage superior ---
  test("5: D cannot can_manage A (reverse direction)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "employee",
        objectId: uuid("A"),
        relation: "can_manage",
        subjectType: "employee",
        subjectId: uuid("D"),
      },
      false,
    );
  });

  test("the relation configs say what the model says", () => {
    expectConfigsMatchModel("./expenses/model.dsl", fixture, {
      coverage: "complete",
    });
  });
});
