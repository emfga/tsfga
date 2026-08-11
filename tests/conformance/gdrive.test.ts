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

// Ref: OpenFGA sample store "gdrive"
// Combines wildcards, group members, folder inheritance via TTU,
// and concentric permissions (owner > viewer)

const uuidMap = new Map<string, string>([
  ["alice", "00000000-0000-4000-be00-000000000001"],
  ["bob", "00000000-0000-4000-be00-000000000002"],
  ["charlie", "00000000-0000-4000-be00-000000000003"],
  ["engineering", "00000000-0000-4000-be00-000000000004"],
  ["root", "00000000-0000-4000-be00-000000000005"],
  ["shared", "00000000-0000-4000-be00-000000000006"],
  ["design", "00000000-0000-4000-be00-000000000007"],
  ["public", "00000000-0000-4000-be00-000000000008"],
  ["private", "00000000-0000-4000-be00-000000000009"],
]);

function uuid(name: string): string {
  const id = uuidMap.get(name);
  if (!id) throw new Error(`No UUID for ${name}`);
  return id;
}

describe("Google Drive Model Conformance", () => {
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

    // group.member
    await tsfgaClient.writeRelationConfig({
      objectType: "group",
      relation: "member",
      directlyAssignable: ["user"],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });

    // folder.owner
    await tsfgaClient.writeRelationConfig({
      objectType: "folder",
      relation: "owner",
      directlyAssignable: ["user"],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });

    // folder.parent
    await tsfgaClient.writeRelationConfig({
      objectType: "folder",
      relation: "parent",
      directlyAssignable: ["folder"],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });

    // folder.can_create_file: owner (computed userset)
    await tsfgaClient.writeRelationConfig({
      objectType: "folder",
      relation: "can_create_file",
      directlyAssignable: [],
      impliedBy: null,
      computedUserset: "owner",
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });

    // folder.viewer: [user, user:*, group#member] or owner or viewer from parent
    await tsfgaClient.writeRelationConfig({
      objectType: "folder",
      relation: "viewer",
      directlyAssignable: ["user", "user:*", "group#member"],
      impliedBy: ["owner"],
      computedUserset: null,
      tupleToUserset: [{ tupleset: "parent", computedUserset: "viewer" }],
      excludedBy: null,
      intersection: null,
    });

    // doc.owner
    await tsfgaClient.writeRelationConfig({
      objectType: "doc",
      relation: "owner",
      directlyAssignable: ["user"],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });

    // doc.parent
    await tsfgaClient.writeRelationConfig({
      objectType: "doc",
      relation: "parent",
      directlyAssignable: ["folder"],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });

    // doc.viewer: [user, user:*, group#member]
    await tsfgaClient.writeRelationConfig({
      objectType: "doc",
      relation: "viewer",
      directlyAssignable: ["user", "user:*", "group#member"],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });

    // doc.can_change_owner: owner (computed userset)
    await tsfgaClient.writeRelationConfig({
      objectType: "doc",
      relation: "can_change_owner",
      directlyAssignable: [],
      impliedBy: null,
      computedUserset: "owner",
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });

    // doc.can_read: viewer or owner or viewer from parent
    await tsfgaClient.writeRelationConfig({
      objectType: "doc",
      relation: "can_read",
      directlyAssignable: [],
      impliedBy: ["viewer", "owner"],
      computedUserset: null,
      tupleToUserset: [{ tupleset: "parent", computedUserset: "viewer" }],
      excludedBy: null,
      intersection: null,
    });

    // doc.can_share: owner or owner from parent
    await tsfgaClient.writeRelationConfig({
      objectType: "doc",
      relation: "can_share",
      directlyAssignable: [],
      impliedBy: ["owner"],
      computedUserset: null,
      tupleToUserset: [{ tupleset: "parent", computedUserset: "owner" }],
      excludedBy: null,
      intersection: null,
    });

    // doc.can_write: owner or owner from parent
    await tsfgaClient.writeRelationConfig({
      objectType: "doc",
      relation: "can_write",
      directlyAssignable: [],
      impliedBy: ["owner"],
      computedUserset: null,
      tupleToUserset: [{ tupleset: "parent", computedUserset: "owner" }],
      excludedBy: null,
      intersection: null,
    });

    // === Tuples ===

    // Group membership
    await tsfgaClient.addTuple({
      objectType: "group",
      objectId: uuid("engineering"),
      relation: "member",
      subjectType: "user",
      subjectId: uuid("alice"),
    });
    await tsfgaClient.addTuple({
      objectType: "group",
      objectId: uuid("engineering"),
      relation: "member",
      subjectType: "user",
      subjectId: uuid("bob"),
    });

    // Folder structure
    await tsfgaClient.addTuple({
      objectType: "folder",
      objectId: uuid("root"),
      relation: "owner",
      subjectType: "user",
      subjectId: uuid("alice"),
    });
    await tsfgaClient.addTuple({
      objectType: "folder",
      objectId: uuid("shared"),
      relation: "parent",
      subjectType: "folder",
      subjectId: uuid("root"),
    });
    // shared folder: public wildcard viewer
    await tsfgaClient.addTuple({
      objectType: "folder",
      objectId: uuid("shared"),
      relation: "viewer",
      subjectType: "user",
      subjectId: "*",
    });

    // doc:design - owned by bob, parent: folder:root
    await tsfgaClient.addTuple({
      objectType: "doc",
      objectId: uuid("design"),
      relation: "owner",
      subjectType: "user",
      subjectId: uuid("bob"),
    });
    await tsfgaClient.addTuple({
      objectType: "doc",
      objectId: uuid("design"),
      relation: "parent",
      subjectType: "folder",
      subjectId: uuid("root"),
    });

    // doc:public - parent: folder:shared (inherits public access)
    await tsfgaClient.addTuple({
      objectType: "doc",
      objectId: uuid("public"),
      relation: "parent",
      subjectType: "folder",
      subjectId: uuid("shared"),
    });

    // doc:private - viewer: group:engineering#member
    await tsfgaClient.addTuple({
      objectType: "doc",
      objectId: uuid("private"),
      relation: "viewer",
      subjectType: "group",
      subjectId: uuid("engineering"),
      subjectRelation: "member",
    });

    // Setup OpenFGA
    storeId = await fgaCreateStore("gdrive-conformance");
    authorizationModelId = await fgaWriteModel(storeId, "./gdrive/model.dsl");
    await fgaWriteTuples(
      storeId,
      "./gdrive/tuples.yaml",
      authorizationModelId,
      uuidMap,
    );
  });

  afterAll(async () => {
    await rollbackTransaction(db);
    await destroyDb();
  });

  // --- Direct owner permissions ---
  test("1: bob can_write doc:design (direct owner)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "doc",
        objectId: uuid("design"),
        relation: "can_write",
        subjectType: "user",
        subjectId: uuid("bob"),
      },
      true,
    );
  });

  test("2: bob can_change_owner doc:design (owner)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "doc",
        objectId: uuid("design"),
        relation: "can_change_owner",
        subjectType: "user",
        subjectId: uuid("bob"),
      },
      true,
    );
  });

  // --- Folder owner inherits to doc via TTU ---
  test("3: alice can_read doc:design (folder:root owner via TTU)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "doc",
        objectId: uuid("design"),
        relation: "can_read",
        subjectType: "user",
        subjectId: uuid("alice"),
      },
      true,
    );
  });

  test("4: alice can_share doc:design (owner from parent TTU)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "doc",
        objectId: uuid("design"),
        relation: "can_share",
        subjectType: "user",
        subjectId: uuid("alice"),
      },
      true,
    );
  });

  // --- Public access via wildcard ---
  test("5: charlie can_read doc:public (wildcard via folder:shared)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "doc",
        objectId: uuid("public"),
        relation: "can_read",
        subjectType: "user",
        subjectId: uuid("charlie"),
      },
      true,
    );
  });

  test("6: alice can_read doc:public (wildcard, any user)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "doc",
        objectId: uuid("public"),
        relation: "can_read",
        subjectType: "user",
        subjectId: uuid("alice"),
      },
      true,
    );
  });

  // --- Group-based access ---
  test("7: alice can_read doc:private (group:engineering member)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "doc",
        objectId: uuid("private"),
        relation: "can_read",
        subjectType: "user",
        subjectId: uuid("alice"),
      },
      true,
    );
  });

  test("8: bob can_read doc:private (group:engineering member)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "doc",
        objectId: uuid("private"),
        relation: "can_read",
        subjectType: "user",
        subjectId: uuid("bob"),
      },
      true,
    );
  });

  // --- Negative: non-member cannot access private doc ---
  test("9: charlie cannot can_read doc:private (not in engineering)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "doc",
        objectId: uuid("private"),
        relation: "can_read",
        subjectType: "user",
        subjectId: uuid("charlie"),
      },
      false,
    );
  });

  // --- Negative: viewer cannot write ---
  test("10: charlie cannot can_write doc:public (viewer only)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "doc",
        objectId: uuid("public"),
        relation: "can_write",
        subjectType: "user",
        subjectId: uuid("charlie"),
      },
      false,
    );
  });

  // --- Folder owner can create files ---
  test("11: alice can_create_file folder:root (owner)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "folder",
        objectId: uuid("root"),
        relation: "can_create_file",
        subjectType: "user",
        subjectId: uuid("alice"),
      },
      true,
    );
  });

  test("12: bob cannot can_create_file folder:root (not owner)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "folder",
        objectId: uuid("root"),
        relation: "can_create_file",
        subjectType: "user",
        subjectId: uuid("bob"),
      },
      false,
    );
  });

  test("the relation configs say what the model says", () => {
    expectConfigsMatchModel("./gdrive/model.dsl", fixture, {
      coverage: "complete",
    });
  });
});
