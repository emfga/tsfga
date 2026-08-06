import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  ConditionEvaluationError,
  createTsfga,
  type TsfgaClient,
} from "@tsfga/core";
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
  fgaCheck,
  fgaCreateStore,
  fgaWriteModel,
  fgaWriteTuples,
} from "./helpers/openfga.ts";

// Validates union error semantics against real OpenFGA: a direct
// tuple whose condition evaluation FAILS (missing context
// parameter) is one racing union branch, and a granting sibling
// branch (team#member) must win over that error in both systems.
// When nothing grants, both systems must surface an error.
//
// Ref: https://github.com/openfga/openfga/blob/e04bde9e/internal/graph/check.go
// (union continues past branch errors looking for Allowed: true;
// checkDirectUserTuple returns the condition-evaluation error)

const uuidMap = new Map<string, string>([
  ["anne", "00000000-0000-4000-c400-000000000001"],
  ["bob", "00000000-0000-4000-c400-000000000002"],
  ["carl", "00000000-0000-4000-c400-000000000003"],
  ["eng", "00000000-0000-4000-c400-000000000004"],
  ["1", "00000000-0000-4000-c400-000000000005"],
  ["2", "00000000-0000-4000-c400-000000000006"],
]);

function uuid(name: string): string {
  const id = uuidMap.get(name);
  if (!id) throw new Error(`No UUID for ${name}`);
  return id;
}

describe("Condition Error vs Sibling Grant Conformance", () => {
  let db: Kysely<DB>;
  let storeId: string;
  let authorizationModelId: string;
  let tsfgaClient: TsfgaClient;

  beforeAll(async () => {
    db = getDb();
    await beginTransaction(db);

    const store = new KyselyTupleStore(db);
    tsfgaClient = createTsfga(store);

    // === Condition definition ===
    await tsfgaClient.writeConditionDefinition({
      name: "valid_ip",
      expression: 'user_ip == "192.168.0.1"',
      parameters: { user_ip: "string" },
    });

    // === Relation configs ===
    await tsfgaClient.writeRelationConfig({
      objectType: "team",
      relation: "member",
      directlyAssignableTypes: ["user"],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
      allowsUsersetSubjects: false,
    });
    await tsfgaClient.writeRelationConfig({
      objectType: "document",
      relation: "viewer",
      directlyAssignableTypes: ["user", "team"],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
      allowsUsersetSubjects: true,
    });

    // === Tuples ===

    // anne: conditioned direct grant with no stored context, so a
    // context-free check fails condition evaluation
    await tsfgaClient.addTuple({
      objectType: "document",
      objectId: uuid("1"),
      relation: "viewer",
      subjectType: "user",
      subjectId: uuid("anne"),
      conditionName: "valid_ip",
    });

    // ...and a sibling grant path via team membership
    await tsfgaClient.addTuple({
      objectType: "document",
      objectId: uuid("1"),
      relation: "viewer",
      subjectType: "team",
      subjectId: uuid("eng"),
      subjectRelation: "member",
    });
    await tsfgaClient.addTuple({
      objectType: "team",
      objectId: uuid("eng"),
      relation: "member",
      subjectType: "user",
      subjectId: uuid("anne"),
    });
    await tsfgaClient.addTuple({
      objectType: "team",
      objectId: uuid("eng"),
      relation: "member",
      subjectType: "user",
      subjectId: uuid("bob"),
    });

    // carl: ONLY a conditioned grant on document:2
    await tsfgaClient.addTuple({
      objectType: "document",
      objectId: uuid("2"),
      relation: "viewer",
      subjectType: "user",
      subjectId: uuid("carl"),
      conditionName: "valid_ip",
    });

    // Setup OpenFGA
    storeId = await fgaCreateStore("condition-error-siblings-conformance");
    authorizationModelId = await fgaWriteModel(
      storeId,
      "./condition-error-siblings/model.dsl",
    );
    await fgaWriteTuples(
      storeId,
      "./condition-error-siblings/tuples.yaml",
      authorizationModelId,
      uuidMap,
    );
  });

  afterAll(async () => {
    await rollbackTransaction(db);
    await destroyDb();
  });

  test("1: sibling team grant beats anne's condition error", async () => {
    // No context: anne's direct branch errors (missing user_ip),
    // but the team#member branch grants — both systems say true.
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "document",
        objectId: uuid("1"),
        relation: "viewer",
        subjectType: "user",
        subjectId: uuid("anne"),
      },
      true,
    );
  });

  test("2: anne's conditioned grant works with context", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "document",
        objectId: uuid("1"),
        relation: "viewer",
        subjectType: "user",
        subjectId: uuid("anne"),
        context: { user_ip: "192.168.0.1" },
      },
      true,
    );
  });

  test("3: bob is granted via the team alone", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "document",
        objectId: uuid("1"),
        relation: "viewer",
        subjectType: "user",
        subjectId: uuid("bob"),
      },
      true,
    );
  });

  test("4: both systems error when nothing grants carl", async () => {
    // No context and no sibling path: the condition error is the
    // only outcome. tsfga throws; OpenFGA returns an error (the
    // helper maps it to null).
    await expect(
      tsfgaClient.check({
        objectType: "document",
        objectId: uuid("2"),
        relation: "viewer",
        subjectType: "user",
        subjectId: uuid("carl"),
      }),
    ).rejects.toBeInstanceOf(ConditionEvaluationError);

    const openFgaResult = await fgaCheck(storeId, authorizationModelId, {
      objectType: "document",
      objectId: uuid("2"),
      relation: "viewer",
      subjectType: "user",
      subjectId: uuid("carl"),
    });
    expect(openFgaResult).toBeNull();
  });

  test("5: carl's conditioned grant works with context", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "document",
        objectId: uuid("2"),
        relation: "viewer",
        subjectType: "user",
        subjectId: uuid("carl"),
        context: { user_ip: "192.168.0.1" },
      },
      true,
    );
  });

  test("6: wrong ip denies carl in both systems", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "document",
        objectId: uuid("2"),
        relation: "viewer",
        subjectType: "user",
        subjectId: uuid("carl"),
        context: { user_ip: "10.0.0.1" },
      },
      false,
    );
  });
});
