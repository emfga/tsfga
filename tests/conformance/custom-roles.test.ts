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

// Ref: https://openfga.dev/docs/modeling/custom-roles

const uuidMap = new Map<string, string>([
  ["anne", "00000000-0000-4000-b400-000000000001"],
  ["beth", "00000000-0000-4000-b400-000000000002"],
  ["charlie", "00000000-0000-4000-b400-000000000003"],
  ["media_manager", "00000000-0000-4000-b400-000000000004"],
  ["media_viewer", "00000000-0000-4000-b400-000000000005"],
  ["logos", "00000000-0000-4000-b400-000000000006"],
]);

function uuid(name: string): string {
  const id = uuidMap.get(name);
  if (!id) throw new Error(`No UUID for ${name}`);
  return id;
}

describe("Custom Roles Conformance", () => {
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
      objectType: "role",
      relation: "assignee",
      directlyAssignable: [{ type: "user" }],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });
    await tsfgaClient.writeRelationConfig({
      objectType: "asset-category",
      relation: "editor",
      directlyAssignable: [
        { type: "user" },
        { type: "role", relation: "assignee" },
      ],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });
    await tsfgaClient.writeRelationConfig({
      objectType: "asset-category",
      relation: "viewer",
      directlyAssignable: [
        { type: "user" },
        { type: "role", relation: "assignee" },
      ],
      impliedBy: ["editor"],
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });

    // Write tuples
    await tsfgaClient.addTuple({
      objectType: "role",
      objectId: uuid("media_manager"),
      relation: "assignee",
      subjectType: "user",
      subjectId: uuid("anne"),
    });
    await tsfgaClient.addTuple({
      objectType: "role",
      objectId: uuid("media_viewer"),
      relation: "assignee",
      subjectType: "user",
      subjectId: uuid("beth"),
    });
    await tsfgaClient.addTuple({
      objectType: "asset-category",
      objectId: uuid("logos"),
      relation: "editor",
      subjectType: "role",
      subjectId: uuid("media_manager"),
      subjectRelation: "assignee",
    });
    await tsfgaClient.addTuple({
      objectType: "asset-category",
      objectId: uuid("logos"),
      relation: "viewer",
      subjectType: "role",
      subjectId: uuid("media_viewer"),
      subjectRelation: "assignee",
    });

    // Setup OpenFGA
    storeId = await fgaCreateStore("custom-roles-conformance");
    authorizationModelId = await fgaWriteModel(
      storeId,
      "./custom-roles/model.dsl",
    );
    await fgaWriteTuples(
      storeId,
      "./custom-roles/tuples.yaml",
      authorizationModelId,
      uuidMap,
    );
  });

  afterAll(async () => {
    await rollbackTransaction(db);
    await destroyDb();
  });

  test("1: anne is editor of asset-category:logos (via role:media_manager#assignee)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "asset-category",
        objectId: uuid("logos"),
        relation: "editor",
        subjectType: "user",
        subjectId: uuid("anne"),
      },
      true,
    );
  });

  test("2: beth is viewer of asset-category:logos (via role:media_viewer#assignee)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "asset-category",
        objectId: uuid("logos"),
        relation: "viewer",
        subjectType: "user",
        subjectId: uuid("beth"),
      },
      true,
    );
  });

  test("3: anne is viewer of asset-category:logos (editor implies viewer)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "asset-category",
        objectId: uuid("logos"),
        relation: "viewer",
        subjectType: "user",
        subjectId: uuid("anne"),
      },
      true,
    );
  });

  test("4: beth is NOT editor of asset-category:logos", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "asset-category",
        objectId: uuid("logos"),
        relation: "editor",
        subjectType: "user",
        subjectId: uuid("beth"),
      },
      false,
    );
  });

  test("5: charlie is NOT viewer of asset-category:logos", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "asset-category",
        objectId: uuid("logos"),
        relation: "viewer",
        subjectType: "user",
        subjectId: uuid("charlie"),
      },
      false,
    );
  });

  test("6: charlie is NOT editor of asset-category:logos", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "asset-category",
        objectId: uuid("logos"),
        relation: "editor",
        subjectType: "user",
        subjectId: uuid("charlie"),
      },
      false,
    );
  });

  test("the relation configs say what the model says", () => {
    expectConfigsMatchModel("./custom-roles/model.dsl", fixture, {
      coverage: "complete",
    });
  });
});
