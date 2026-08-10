import { afterAll, beforeAll, describe, test } from "bun:test";
import { createTsfga, type TsfgaClient } from "@tsfga/core";
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
  fgaCreateStore,
  fgaWriteModel,
  fgaWriteTuples,
} from "./helpers/openfga.ts";

// Ref: https://openfga.dev/docs/modeling/parent-child

const uuidMap = new Map<string, string>([
  ["alice", "00000000-0000-4000-b300-000000000001"],
  ["bob", "00000000-0000-4000-b300-000000000002"],
  ["charlie", "00000000-0000-4000-b300-000000000003"],
  ["notes", "00000000-0000-4000-b300-000000000004"],
  ["meeting_notes", "00000000-0000-4000-b300-000000000005"],
]);

function uuid(name: string): string {
  const id = uuidMap.get(name);
  if (!id) throw new Error(`No UUID for ${name}`);
  return id;
}

describe("Parent-Child Conformance", () => {
  let db: Kysely<DB>;
  let storeId: string;
  let authorizationModelId: string;
  let tsfgaClient: TsfgaClient;

  beforeAll(async () => {
    db = getDb();
    await beginTransaction(db);

    const store = new KyselyTupleStore(db);
    tsfgaClient = createTsfga(store);

    // Write relation configs
    await tsfgaClient.writeRelationConfig({
      objectType: "folder",
      relation: "editor",
      directlyAssignable: ["user"],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });
    await tsfgaClient.writeRelationConfig({
      objectType: "document",
      relation: "parent",
      directlyAssignable: ["folder"],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });
    await tsfgaClient.writeRelationConfig({
      objectType: "document",
      relation: "editor",
      directlyAssignable: ["user"],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: [{ tupleset: "parent", computedUserset: "editor" }],
      excludedBy: null,
      intersection: null,
    });

    // Write tuples
    await tsfgaClient.addTuple({
      objectType: "folder",
      objectId: uuid("notes"),
      relation: "editor",
      subjectType: "user",
      subjectId: uuid("bob"),
    });
    await tsfgaClient.addTuple({
      objectType: "document",
      objectId: uuid("meeting_notes"),
      relation: "parent",
      subjectType: "folder",
      subjectId: uuid("notes"),
    });
    await tsfgaClient.addTuple({
      objectType: "document",
      objectId: uuid("meeting_notes"),
      relation: "editor",
      subjectType: "user",
      subjectId: uuid("alice"),
    });

    // Setup OpenFGA
    storeId = await fgaCreateStore("parent-child-conformance");
    authorizationModelId = await fgaWriteModel(
      storeId,
      "./parent-child/model.dsl",
    );
    await fgaWriteTuples(
      storeId,
      "./parent-child/tuples.yaml",
      authorizationModelId,
      uuidMap,
    );
  });

  afterAll(async () => {
    await rollbackTransaction(db);
    await destroyDb();
  });

  test("1: bob is editor of folder:notes", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "folder",
        objectId: uuid("notes"),
        relation: "editor",
        subjectType: "user",
        subjectId: uuid("bob"),
      },
      true,
    );
  });

  test("2: bob is editor of document:meeting_notes (via TTU: parent->folder->editor)", async () => {
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

  test("3: alice is editor of document:meeting_notes (direct)", async () => {
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

  test("4: alice is NOT editor of folder:notes", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "folder",
        objectId: uuid("notes"),
        relation: "editor",
        subjectType: "user",
        subjectId: uuid("alice"),
      },
      false,
    );
  });

  test("5: charlie is NOT editor of document:meeting_notes", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "document",
        objectId: uuid("meeting_notes"),
        relation: "editor",
        subjectType: "user",
        subjectId: uuid("charlie"),
      },
      false,
    );
  });

  test("6: charlie is NOT editor of folder:notes", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "folder",
        objectId: uuid("notes"),
        relation: "editor",
        subjectType: "user",
        subjectId: uuid("charlie"),
      },
      false,
    );
  });
});
