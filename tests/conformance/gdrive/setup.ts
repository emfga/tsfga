import {
  type AddTupleRequest,
  createTsfga,
  type RelationConfig,
  type TsfgaClient,
} from "@tsfga/core";
import { type DB, KyselyTupleStore } from "@tsfga/kysely";
import type { Kysely } from "kysely";
import { type FixtureRecord, recordFixture } from "../helpers/conformance.ts";
import {
  beginTransaction,
  destroyDb,
  getDb,
  rollbackTransaction,
} from "../helpers/db.ts";
import {
  fgaCreateStore,
  fgaWriteModel,
  fgaWriteTuples,
} from "../helpers/openfga.ts";

// Ref: OpenFGA sample store "gdrive"
// Combines wildcards, group members, folder inheritance via TTU,
// and concentric permissions (owner > viewer)
//
// Shared, rather than restated per suite, because two suites ask
// different questions of the same fixture: `gdrive.test.ts` checks
// one object at a time, `list-objects.test.ts` asks which objects
// a subject reaches. A second copy of thirteen configs would let
// the two drift into checking different models under one name.

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

export function uuid(name: string): string {
  const id = uuidMap.get(name);
  if (!id) throw new Error(`No UUID for ${name}`);
  return id;
}

const RELATION_CONFIGS: RelationConfig[] = [
  {
    objectType: "group",
    relation: "member",
    directlyAssignable: [{ type: "user" }],
    impliedBy: null,
    computedUserset: null,
    tupleToUserset: null,
    excludedBy: null,
    intersection: null,
  },
  {
    objectType: "folder",
    relation: "owner",
    directlyAssignable: [{ type: "user" }],
    impliedBy: null,
    computedUserset: null,
    tupleToUserset: null,
    excludedBy: null,
    intersection: null,
  },
  {
    objectType: "folder",
    relation: "parent",
    directlyAssignable: [{ type: "folder" }],
    impliedBy: null,
    computedUserset: null,
    tupleToUserset: null,
    excludedBy: null,
    intersection: null,
  },
  // folder.can_create_file: owner
  {
    objectType: "folder",
    relation: "can_create_file",
    directlyAssignable: [],
    impliedBy: null,
    computedUserset: "owner",
    tupleToUserset: null,
    excludedBy: null,
    intersection: null,
  },
  // folder.viewer: [user, user:*, group#member] or owner
  //                or viewer from parent
  {
    objectType: "folder",
    relation: "viewer",
    directlyAssignable: [
      { type: "user" },
      { type: "user", wildcard: true },
      { type: "group", relation: "member" },
    ],
    impliedBy: ["owner"],
    computedUserset: null,
    tupleToUserset: [{ tupleset: "parent", computedUserset: "viewer" }],
    excludedBy: null,
    intersection: null,
  },
  {
    objectType: "doc",
    relation: "owner",
    directlyAssignable: [{ type: "user" }],
    impliedBy: null,
    computedUserset: null,
    tupleToUserset: null,
    excludedBy: null,
    intersection: null,
  },
  {
    objectType: "doc",
    relation: "parent",
    directlyAssignable: [{ type: "folder" }],
    impliedBy: null,
    computedUserset: null,
    tupleToUserset: null,
    excludedBy: null,
    intersection: null,
  },
  // doc.viewer: [user, user:*, group#member]
  {
    objectType: "doc",
    relation: "viewer",
    directlyAssignable: [
      { type: "user" },
      { type: "user", wildcard: true },
      { type: "group", relation: "member" },
    ],
    impliedBy: null,
    computedUserset: null,
    tupleToUserset: null,
    excludedBy: null,
    intersection: null,
  },
  // doc.can_change_owner: owner
  {
    objectType: "doc",
    relation: "can_change_owner",
    directlyAssignable: [],
    impliedBy: null,
    computedUserset: "owner",
    tupleToUserset: null,
    excludedBy: null,
    intersection: null,
  },
  // doc.can_read: viewer or owner or viewer from parent
  {
    objectType: "doc",
    relation: "can_read",
    directlyAssignable: [],
    impliedBy: ["viewer", "owner"],
    computedUserset: null,
    tupleToUserset: [{ tupleset: "parent", computedUserset: "viewer" }],
    excludedBy: null,
    intersection: null,
  },
  // doc.can_share: owner or owner from parent
  {
    objectType: "doc",
    relation: "can_share",
    directlyAssignable: [],
    impliedBy: ["owner"],
    computedUserset: null,
    tupleToUserset: [{ tupleset: "parent", computedUserset: "owner" }],
    excludedBy: null,
    intersection: null,
  },
  // doc.can_write: owner or owner from parent
  {
    objectType: "doc",
    relation: "can_write",
    directlyAssignable: [],
    impliedBy: ["owner"],
    computedUserset: null,
    tupleToUserset: [{ tupleset: "parent", computedUserset: "owner" }],
    excludedBy: null,
    intersection: null,
  },
];

const TUPLES: AddTupleRequest[] = [
  // Group membership
  {
    objectType: "group",
    objectId: uuid("engineering"),
    relation: "member",
    subjectType: "user",
    subjectId: uuid("alice"),
  },
  {
    objectType: "group",
    objectId: uuid("engineering"),
    relation: "member",
    subjectType: "user",
    subjectId: uuid("bob"),
  },
  // Folder structure
  {
    objectType: "folder",
    objectId: uuid("root"),
    relation: "owner",
    subjectType: "user",
    subjectId: uuid("alice"),
  },
  {
    objectType: "folder",
    objectId: uuid("shared"),
    relation: "parent",
    subjectType: "folder",
    subjectId: uuid("root"),
  },
  // shared folder: public wildcard viewer
  {
    objectType: "folder",
    objectId: uuid("shared"),
    relation: "viewer",
    subjectType: "user",
    subjectId: "*",
  },
  // doc:design - owned by bob, parent: folder:root
  {
    objectType: "doc",
    objectId: uuid("design"),
    relation: "owner",
    subjectType: "user",
    subjectId: uuid("bob"),
  },
  {
    objectType: "doc",
    objectId: uuid("design"),
    relation: "parent",
    subjectType: "folder",
    subjectId: uuid("root"),
  },
  // doc:public - parent: folder:shared (inherits public access)
  {
    objectType: "doc",
    objectId: uuid("public"),
    relation: "parent",
    subjectType: "folder",
    subjectId: uuid("shared"),
  },
  // doc:private - viewer: group:engineering#member
  {
    objectType: "doc",
    objectId: uuid("private"),
    relation: "viewer",
    subjectType: "group",
    subjectId: uuid("engineering"),
    subjectRelation: "member",
  },
];

// === Setup & Teardown ===

export interface GdriveSetup {
  db: Kysely<DB>;
  storeId: string;
  authorizationModelId: string;
  tsfgaClient: TsfgaClient;
  /** What this setup wrote, for the config drift assertion. */
  fixture: FixtureRecord;
}

export async function setupGdrive(): Promise<GdriveSetup> {
  const db = getDb();
  await beginTransaction(db);

  const store = new KyselyTupleStore(db);
  const tsfgaClient = createTsfga(store);
  const fixture = recordFixture(tsfgaClient);

  for (const config of RELATION_CONFIGS) {
    await tsfgaClient.writeRelationConfig(config);
  }

  for (const tuple of TUPLES) {
    await tsfgaClient.addTuple(tuple);
  }

  const storeId = await fgaCreateStore("gdrive-conformance");
  const authorizationModelId = await fgaWriteModel(
    storeId,
    "./gdrive/model.dsl",
  );
  await fgaWriteTuples(
    storeId,
    "./gdrive/tuples.yaml",
    authorizationModelId,
    uuidMap,
  );

  return { db, storeId, authorizationModelId, tsfgaClient, fixture };
}

export async function teardownGdrive(db: Kysely<DB>): Promise<void> {
  await rollbackTransaction(db);
  await destroyDb();
}
