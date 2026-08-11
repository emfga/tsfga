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

// Ref: https://openfga.dev/docs/modeling/multiple-restrictions

const uuidMap = new Map<string, string>([
  ["becky", "00000000-0000-4000-b700-000000000001"],
  ["carl", "00000000-0000-4000-b700-000000000002"],
  ["acme", "00000000-0000-4000-b700-000000000003"],
  ["planning", "00000000-0000-4000-b700-000000000004"],
]);

function uuid(name: string): string {
  const id = uuidMap.get(name);
  if (!id) throw new Error(`No UUID for ${name}`);
  return id;
}

describe("Multiple Restrictions Conformance", () => {
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
      objectType: "organization",
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
      relation: "owner",
      directlyAssignable: [{ type: "organization" }],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });
    await tsfgaClient.writeRelationConfig({
      objectType: "document",
      relation: "writer",
      directlyAssignable: [{ type: "user" }],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });
    await tsfgaClient.writeRelationConfig({
      objectType: "document",
      relation: "can_write",
      directlyAssignable: [],
      impliedBy: null,
      computedUserset: "writer",
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });
    await tsfgaClient.writeRelationConfig({
      objectType: "document",
      relation: "can_delete",
      directlyAssignable: [],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: [
        { type: "computedUserset", relation: "writer" },
        {
          type: "tupleToUserset",
          tupleset: "owner",
          computedUserset: "member",
        },
      ],
    });

    // Write tuples
    await tsfgaClient.addTuple({
      objectType: "document",
      objectId: uuid("planning"),
      relation: "writer",
      subjectType: "user",
      subjectId: uuid("becky"),
    });
    await tsfgaClient.addTuple({
      objectType: "document",
      objectId: uuid("planning"),
      relation: "writer",
      subjectType: "user",
      subjectId: uuid("carl"),
    });
    await tsfgaClient.addTuple({
      objectType: "document",
      objectId: uuid("planning"),
      relation: "owner",
      subjectType: "organization",
      subjectId: uuid("acme"),
    });
    await tsfgaClient.addTuple({
      objectType: "organization",
      objectId: uuid("acme"),
      relation: "member",
      subjectType: "user",
      subjectId: uuid("becky"),
    });

    // Setup OpenFGA
    storeId = await fgaCreateStore("multiple-restrictions-conformance");
    authorizationModelId = await fgaWriteModel(
      storeId,
      "./multiple-restrictions/model.dsl",
    );
    await fgaWriteTuples(
      storeId,
      "./multiple-restrictions/tuples.yaml",
      authorizationModelId,
      uuidMap,
    );
  });

  afterAll(async () => {
    await rollbackTransaction(db);
    await destroyDb();
  });

  test("1: becky can_write document:planning (is writer)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "document",
        objectId: uuid("planning"),
        relation: "can_write",
        subjectType: "user",
        subjectId: uuid("becky"),
      },
      true,
    );
  });

  test("2: carl can_write document:planning (is writer)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "document",
        objectId: uuid("planning"),
        relation: "can_write",
        subjectType: "user",
        subjectId: uuid("carl"),
      },
      true,
    );
  });

  test("3: becky can_delete document:planning (writer AND member of owner org)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "document",
        objectId: uuid("planning"),
        relation: "can_delete",
        subjectType: "user",
        subjectId: uuid("becky"),
      },
      true,
    );
  });

  test("4: carl cannot can_delete document:planning (writer but NOT member of owner org)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "document",
        objectId: uuid("planning"),
        relation: "can_delete",
        subjectType: "user",
        subjectId: uuid("carl"),
      },
      false,
    );
  });

  test("the relation configs say what the model says", () => {
    expectConfigsMatchModel("./multiple-restrictions/model.dsl", fixture, {
      coverage: "complete",
    });
  });
});
