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

// Ref: https://openfga.dev/docs/modeling/token-claims-contextual-tuples

const uuidMap = new Map<string, string>([
  ["alice", "00000000-0000-4000-b800-000000000001"],
  ["bob", "00000000-0000-4000-b800-000000000002"],
  ["marketing", "00000000-0000-4000-b800-000000000003"],
  ["everyone", "00000000-0000-4000-b800-000000000004"],
  ["product_launch", "00000000-0000-4000-b800-000000000005"],
  ["welcome", "00000000-0000-4000-b800-000000000006"],
]);

function uuid(name: string): string {
  const id = uuidMap.get(name);
  if (!id) throw new Error(`No UUID for ${name}`);
  return id;
}

describe("Token Claims Contextual Tuples Conformance", () => {
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
      objectType: "group",
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
      relation: "viewer",
      directlyAssignable: [{ type: "group", relation: "member" }],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });

    // Write stored tuples (group membership is contextual, not stored)
    await tsfgaClient.addTuple({
      objectType: "document",
      objectId: uuid("product_launch"),
      relation: "viewer",
      subjectType: "group",
      subjectId: uuid("marketing"),
      subjectRelation: "member",
    });
    await tsfgaClient.addTuple({
      objectType: "document",
      objectId: uuid("welcome"),
      relation: "viewer",
      subjectType: "group",
      subjectId: uuid("everyone"),
      subjectRelation: "member",
    });

    // Setup OpenFGA
    storeId = await fgaCreateStore("token-claims-conformance");
    authorizationModelId = await fgaWriteModel(
      storeId,
      "./token-claims-contextual-tuples/model.dsl",
    );
    await fgaWriteTuples(
      storeId,
      "./token-claims-contextual-tuples/tuples.yaml",
      authorizationModelId,
      uuidMap,
    );
  });

  afterAll(async () => {
    await rollbackTransaction(db);
    await destroyDb();
  });

  test("1: alice can view product_launch (contextual: alice in marketing)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "document",
        objectId: uuid("product_launch"),
        relation: "viewer",
        subjectType: "user",
        subjectId: uuid("alice"),
        contextualTuples: [
          {
            objectType: "group",
            objectId: uuid("marketing"),
            relation: "member",
            subjectType: "user",
            subjectId: uuid("alice"),
          },
        ],
      },
      true,
    );
  });

  test("2: alice can view welcome (contextual: alice in everyone)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "document",
        objectId: uuid("welcome"),
        relation: "viewer",
        subjectType: "user",
        subjectId: uuid("alice"),
        contextualTuples: [
          {
            objectType: "group",
            objectId: uuid("everyone"),
            relation: "member",
            subjectType: "user",
            subjectId: uuid("alice"),
          },
        ],
      },
      true,
    );
  });

  test("3: bob cannot view product_launch (contextual: bob in everyone only)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "document",
        objectId: uuid("product_launch"),
        relation: "viewer",
        subjectType: "user",
        subjectId: uuid("bob"),
        contextualTuples: [
          {
            objectType: "group",
            objectId: uuid("everyone"),
            relation: "member",
            subjectType: "user",
            subjectId: uuid("bob"),
          },
        ],
      },
      false,
    );
  });

  test("4: bob can view welcome (contextual: bob in everyone)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "document",
        objectId: uuid("welcome"),
        relation: "viewer",
        subjectType: "user",
        subjectId: uuid("bob"),
        contextualTuples: [
          {
            objectType: "group",
            objectId: uuid("everyone"),
            relation: "member",
            subjectType: "user",
            subjectId: uuid("bob"),
          },
        ],
      },
      true,
    );
  });

  test("5: alice cannot view product_launch (no contextual tuples)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "document",
        objectId: uuid("product_launch"),
        relation: "viewer",
        subjectType: "user",
        subjectId: uuid("alice"),
      },
      false,
    );
  });

  test("6: bob cannot view welcome (no contextual tuples)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "document",
        objectId: uuid("welcome"),
        relation: "viewer",
        subjectType: "user",
        subjectId: uuid("bob"),
      },
      false,
    );
  });

  test("the relation configs say what the model says", () => {
    expectConfigsMatchModel(
      "./token-claims-contextual-tuples/model.dsl",
      fixture,
      {
        coverage: "complete",
      },
    );
  });
});
