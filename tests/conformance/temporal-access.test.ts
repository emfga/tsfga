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

// Ref: OpenFGA sample store "temporal-access"
// First conformance test exercising CEL conditions with timestamp/duration types

const uuidMap = new Map<string, string>([
  ["anne", "00000000-0000-4000-bf00-000000000001"],
  ["bob", "00000000-0000-4000-bf00-000000000002"],
  ["1", "00000000-0000-4000-bf00-000000000003"],
  ["2", "00000000-0000-4000-bf00-000000000004"],
]);

function uuid(name: string): string {
  const id = uuidMap.get(name);
  if (!id) throw new Error(`No UUID for ${name}`);
  return id;
}

describe("Temporal Access Conformance", () => {
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
      name: "temporal_access",
      expression: "current_time < grant_time + grant_duration",
      parameters: {
        grant_time: "timestamp",
        grant_duration: "duration",
        current_time: "timestamp",
      },
    });

    // === Relation configs ===
    await tsfgaClient.writeRelationConfig({
      objectType: "document",
      relation: "viewer",
      directlyAssignableTypes: ["user"],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
      allowsUsersetSubjects: false,
    });

    // === Tuples ===

    // bob has unconditional viewer access to document:1
    await tsfgaClient.addTuple({
      objectType: "document",
      objectId: uuid("1"),
      relation: "viewer",
      subjectType: "user",
      subjectId: uuid("bob"),
    });

    // anne has time-bounded viewer access to document:1 (1 hour window)
    await tsfgaClient.addTuple({
      objectType: "document",
      objectId: uuid("1"),
      relation: "viewer",
      subjectType: "user",
      subjectId: uuid("anne"),
      conditionName: "temporal_access",
      conditionContext: {
        grant_time: "2023-01-01T00:00:00Z",
        grant_duration: "1h",
      },
    });

    // anne has time-bounded viewer access to document:2 (5 second window)
    await tsfgaClient.addTuple({
      objectType: "document",
      objectId: uuid("2"),
      relation: "viewer",
      subjectType: "user",
      subjectId: uuid("anne"),
      conditionName: "temporal_access",
      conditionContext: {
        grant_time: "2023-01-01T00:00:00Z",
        grant_duration: "5s",
      },
    });

    // Setup OpenFGA
    storeId = await fgaCreateStore("temporal-access-conformance");
    authorizationModelId = await fgaWriteModel(
      storeId,
      "tests/conformance/temporal-access/model.dsl",
    );
    await fgaWriteTuples(
      storeId,
      "tests/conformance/temporal-access/tuples.yaml",
      authorizationModelId,
      uuidMap,
    );
  });

  afterAll(async () => {
    await rollbackTransaction(db);
    await destroyDb();
  });

  // --- Unconditional access ---
  test("1: bob can view document:1 (unconditional)", async () => {
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

  // --- Time-bounded access within window ---
  test("2: anne can view document:1 at T+10min (within 1h window)", async () => {
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
        context: {
          current_time: "2023-01-01T00:10:00Z",
        },
      },
      true,
    );
  });

  // --- Time-bounded access past window ---
  test("3: anne cannot view document:1 at T+2h (past 1h window)", async () => {
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
        context: {
          current_time: "2023-01-01T02:00:00Z",
        },
      },
      false,
    );
  });

  // --- Short duration expired ---
  test("4: anne cannot view document:2 at T+10s (past 5s window)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "document",
        objectId: uuid("2"),
        relation: "viewer",
        subjectType: "user",
        subjectId: uuid("anne"),
        context: {
          current_time: "2023-01-01T00:00:10Z",
        },
      },
      false,
    );
  });
});
