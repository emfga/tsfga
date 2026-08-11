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

// Ref: https://openfga.dev/docs/modeling/user-groups

const uuidMap = new Map<string, string>([
  ["alice", "00000000-0000-4000-b100-000000000001"],
  ["bob", "00000000-0000-4000-b100-000000000002"],
  ["writers", "00000000-0000-4000-b100-000000000003"],
  ["meeting_notes", "00000000-0000-4000-b100-000000000004"],
]);

function uuid(name: string): string {
  const id = uuidMap.get(name);
  if (!id) throw new Error(`No UUID for ${name}`);
  return id;
}

describe("User Groups Conformance", () => {
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
      objectType: "team",
      relation: "member",
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
      directlyAssignable: [{ type: "team", relation: "member" }],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });

    // Write tuples
    await tsfgaClient.addTuple({
      objectType: "team",
      objectId: uuid("writers"),
      relation: "member",
      subjectType: "user",
      subjectId: uuid("alice"),
    });
    await tsfgaClient.addTuple({
      objectType: "document",
      objectId: uuid("meeting_notes"),
      relation: "editor",
      subjectType: "team",
      subjectId: uuid("writers"),
      subjectRelation: "member",
    });

    // Setup OpenFGA
    storeId = await fgaCreateStore("user-groups-conformance");
    authorizationModelId = await fgaWriteModel(
      storeId,
      "./user-groups/model.dsl",
    );
    await fgaWriteTuples(
      storeId,
      "./user-groups/tuples.yaml",
      authorizationModelId,
      uuidMap,
    );
  });

  afterAll(async () => {
    await rollbackTransaction(db);
    await destroyDb();
  });

  test("1: alice is editor of document:meeting_notes (via team userset)", async () => {
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
      true,
    );
  });

  test("2: bob is NOT editor of document:meeting_notes", async () => {
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
      false,
    );
  });

  test("3: alice is member of team:writers", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "team",
        objectId: uuid("writers"),
        relation: "member",
        subjectType: "user",
        subjectId: uuid("alice"),
      },
      true,
    );
  });

  test("4: bob is NOT member of team:writers", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "team",
        objectId: uuid("writers"),
        relation: "member",
        subjectType: "user",
        subjectId: uuid("bob"),
      },
      false,
    );
  });

  test("the relation configs say what the model says", () => {
    expectConfigsMatchModel("./user-groups/model.dsl", fixture, {
      coverage: "complete",
    });
  });
});
