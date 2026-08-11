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

// Ref: https://openfga.dev/docs/modeling/direct-access

const uuidMap = new Map<string, string>([
  ["bob", "00000000-0000-4000-b000-000000000001"],
  ["alice", "00000000-0000-4000-b000-000000000002"],
  ["meeting_notes", "00000000-0000-4000-b000-000000000003"],
]);

function uuid(name: string): string {
  const id = uuidMap.get(name);
  if (!id) throw new Error(`No UUID for ${name}`);
  return id;
}

describe("Direct Access Conformance", () => {
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

    // Write relation configs
    await tsfgaClient.writeRelationConfig({
      objectType: "document",
      relation: "viewer",
      directlyAssignable: [{ type: "user" }],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });
    await tsfgaClient.writeRelationConfig({
      objectType: "document",
      relation: "editor",
      directlyAssignable: [{ type: "user" }],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });

    // Write tuples
    await tsfgaClient.addTuple({
      objectType: "document",
      objectId: uuid("meeting_notes"),
      relation: "editor",
      subjectType: "user",
      subjectId: uuid("bob"),
    });

    // Setup OpenFGA
    storeId = await fgaCreateStore("direct-access-conformance");
    authorizationModelId = await fgaWriteModel(
      storeId,
      "./direct-access/model.dsl",
    );
    await fgaWriteTuples(
      storeId,
      "./direct-access/tuples.yaml",
      authorizationModelId,
      uuidMap,
    );
  });

  afterAll(async () => {
    await rollbackTransaction(db);
    await destroyDb();
  });

  test("1: bob is editor of document:meeting_notes", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "document",
        objectId: uuid("meeting_notes"),
        relation: "editor",
        subjectType: "user",
        subjectId: uuid("bob"),
      },
      true,
    );
  });

  test("2: bob is NOT viewer of document:meeting_notes", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "document",
        objectId: uuid("meeting_notes"),
        relation: "viewer",
        subjectType: "user",
        subjectId: uuid("bob"),
      },
      false,
    );
  });

  test("3: alice is NOT editor of document:meeting_notes", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "document",
        objectId: uuid("meeting_notes"),
        relation: "editor",
        subjectType: "user",
        subjectId: uuid("alice"),
      },
      false,
    );
  });

  test("4: alice is NOT viewer of document:meeting_notes", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "document",
        objectId: uuid("meeting_notes"),
        relation: "viewer",
        subjectType: "user",
        subjectId: uuid("alice"),
      },
      false,
    );
  });

  test("the relation configs say what the model says", () => {
    expectConfigsMatchModel("./direct-access/model.dsl", fixture, {
      coverage: "complete",
    });
  });
});
