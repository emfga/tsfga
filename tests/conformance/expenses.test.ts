import { afterAll, beforeAll, describe, test } from "bun:test";
import type { Kysely } from "kysely";
import { createTsfga, type TsfgaClient } from "src/index.ts";
import { KyselyTupleStore } from "src/store/kysely/adapter.ts";
import type { DB } from "src/store/kysely/schema.ts";
import { expectConformance } from "tests/helpers/conformance.ts";
import {
  beginTransaction,
  destroyDb,
  getDb,
  rollbackTransaction,
} from "tests/helpers/db.ts";
import {
  fgaCreateStore,
  fgaWriteModel,
  fgaWriteTuples,
} from "tests/helpers/openfga.ts";

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

  beforeAll(async () => {
    db = getDb();
    await beginTransaction(db);

    const store = new KyselyTupleStore(db);
    tsfgaClient = createTsfga(store);

    // === Relation configs ===

    // employee.manager: [employee]
    await tsfgaClient.writeRelationConfig({
      objectType: "employee",
      relation: "manager",
      directlyAssignableTypes: ["employee"],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
      allowsUsersetSubjects: false,
    });

    // employee.can_manage: manager or can_manage from manager
    await tsfgaClient.writeRelationConfig({
      objectType: "employee",
      relation: "can_manage",
      directlyAssignableTypes: null,
      impliedBy: ["manager"],
      computedUserset: null,
      tupleToUserset: {
        tupleset: "manager",
        computedUserset: "can_manage",
      },
      excludedBy: null,
      intersection: null,
      allowsUsersetSubjects: false,
    });

    // report.submitter: [employee]
    await tsfgaClient.writeRelationConfig({
      objectType: "report",
      relation: "submitter",
      directlyAssignableTypes: ["employee"],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
      allowsUsersetSubjects: false,
    });

    // report.can_approve: can_manage from submitter
    await tsfgaClient.writeRelationConfig({
      objectType: "report",
      relation: "can_approve",
      directlyAssignableTypes: null,
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: {
        tupleset: "submitter",
        computedUserset: "can_manage",
      },
      excludedBy: null,
      intersection: null,
      allowsUsersetSubjects: false,
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
    authorizationModelId = await fgaWriteModel(
      storeId,
      "tests/conformance/expenses/model.dsl",
    );
    await fgaWriteTuples(
      storeId,
      "tests/conformance/expenses/tuples.yaml",
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
});
