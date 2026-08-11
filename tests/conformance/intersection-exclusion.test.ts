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

// Regression coverage: a relation that combines an intersection
// with an exclusion (`(writer and member from owner) but not
// banned`). Verifies excludedBy is applied on top of the
// intersection result, matching OpenFGA.

const uuidMap = new Map<string, string>([
  ["becky", "00000000-0000-4000-c300-000000000001"],
  ["carl", "00000000-0000-4000-c300-000000000002"],
  ["dora", "00000000-0000-4000-c300-000000000003"],
  ["acme", "00000000-0000-4000-c300-000000000004"],
  ["planning", "00000000-0000-4000-c300-000000000005"],
]);

function uuid(name: string): string {
  const id = uuidMap.get(name);
  if (!id) throw new Error(`No UUID for ${name}`);
  return id;
}

describe("Intersection + Exclusion Conformance", () => {
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
      directlyAssignable: ["user"],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });
    await tsfgaClient.writeRelationConfig({
      objectType: "document",
      relation: "banned",
      directlyAssignable: ["user"],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });
    await tsfgaClient.writeRelationConfig({
      objectType: "document",
      relation: "owner",
      directlyAssignable: ["organization"],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });
    await tsfgaClient.writeRelationConfig({
      objectType: "document",
      relation: "writer",
      directlyAssignable: ["user"],
      impliedBy: null,
      computedUserset: null,
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
      excludedBy: "banned",
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
      relation: "writer",
      subjectType: "user",
      subjectId: uuid("dora"),
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
    await tsfgaClient.addTuple({
      objectType: "organization",
      objectId: uuid("acme"),
      relation: "member",
      subjectType: "user",
      subjectId: uuid("dora"),
    });
    await tsfgaClient.addTuple({
      objectType: "document",
      objectId: uuid("planning"),
      relation: "banned",
      subjectType: "user",
      subjectId: uuid("dora"),
    });

    // Setup OpenFGA
    storeId = await fgaCreateStore("intersection-exclusion-conformance");
    authorizationModelId = await fgaWriteModel(
      storeId,
      "./intersection-exclusion/model.dsl",
    );
    await fgaWriteTuples(
      storeId,
      "./intersection-exclusion/tuples.yaml",
      authorizationModelId,
      uuidMap,
    );
  });

  afterAll(async () => {
    await rollbackTransaction(db);
    await destroyDb();
  });

  test("1: becky can_delete (intersection satisfied, not banned)", async () => {
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

  test("2: carl cannot can_delete (intersection not satisfied)", async () => {
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

  test("3: dora cannot can_delete (intersection satisfied but banned)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "document",
        objectId: uuid("planning"),
        relation: "can_delete",
        subjectType: "user",
        subjectId: uuid("dora"),
      },
      false,
    );
  });

  test("the relation configs say what the model says", () => {
    expectConfigsMatchModel("./intersection-exclusion/model.dsl", fixture, {
      coverage: "complete",
    });
  });
});
