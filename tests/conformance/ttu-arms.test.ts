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

// One relation, two tuple-to-userset arms.
//
// Upstream builds one union child per TTU rewrite, so an arm whose
// tupleset rows cannot be evaluated is one failing branch beside
// the others. tsfga stores `tupleToUserset` as an array and
// resolves every arm's tupleset inside a *single* union handler,
// behind `Promise.all` -- so one arm's condition error takes the
// siblings with it.

const uuidMap = new Map<string, string>([
  ["alice", "00000000-0000-4000-d400-000000000001"],
  ["f1", "00000000-0000-4000-d400-000000000002"],
  ["f2", "00000000-0000-4000-d400-000000000003"],
  ["o1", "00000000-0000-4000-d400-000000000004"],
  ["o2", "00000000-0000-4000-d400-000000000005"],
  ["d1", "00000000-0000-4000-d400-000000000006"],
  ["d2", "00000000-0000-4000-d400-000000000007"],
  ["d3", "00000000-0000-4000-d400-000000000008"],
  ["d4", "00000000-0000-4000-d400-000000000009"],
]);

function uuid(name: string): string {
  const id = uuidMap.get(name);
  if (!id) throw new Error(`No UUID for ${name}`);
  return id;
}

describe("a1: tuple-to-userset arms", () => {
  let db: Kysely<DB>;
  let storeId: string;
  let authorizationModelId: string;
  let tsfgaClient: TsfgaClient;
  let fixture: FixtureRecord;

  beforeAll(async () => {
    db = getDb();
    await beginTransaction(db);

    tsfgaClient = createTsfga(new KyselyTupleStore(db));
    fixture = recordFixture(tsfgaClient);

    await tsfgaClient.writeConditionDefinition({
      name: "valid_ip_a1",
      expression: 'user_ip == "192.168.0.1"',
      parameters: { user_ip: "string" },
    });

    await tsfgaClient.writeRelationConfig({
      objectType: "folder_a1",
      relation: "viewer",
      directlyAssignable: [{ type: "user_a1" }],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });
    await tsfgaClient.writeRelationConfig({
      objectType: "org_a1",
      relation: "viewer",
      directlyAssignable: [{ type: "user_a1" }],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });
    await tsfgaClient.writeRelationConfig({
      objectType: "doc_a1",
      relation: "parent",
      directlyAssignable: [{ type: "folder_a1", condition: "valid_ip_a1" }],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });
    await tsfgaClient.writeRelationConfig({
      objectType: "doc_a1",
      relation: "owner",
      directlyAssignable: [{ type: "org_a1" }],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });
    await tsfgaClient.writeRelationConfig({
      objectType: "doc_a1",
      relation: "two_arms",
      directlyAssignable: [],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: [
        { tupleset: "parent", computedUserset: "viewer" },
        { tupleset: "owner", computedUserset: "viewer" },
      ],
      excludedBy: null,
      intersection: null,
    });
    await tsfgaClient.writeRelationConfig({
      objectType: "doc_a1",
      relation: "arm_and_direct",
      directlyAssignable: [{ type: "user_a1" }],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: [{ tupleset: "parent", computedUserset: "viewer" }],
      excludedBy: null,
      intersection: null,
    });

    const tuples = [
      {
        objectType: "doc_a1",
        objectId: uuid("d1"),
        relation: "parent",
        subjectType: "folder_a1",
        subjectId: uuid("f1"),
        conditionName: "valid_ip_a1",
      },
      {
        objectType: "doc_a1",
        objectId: uuid("d1"),
        relation: "owner",
        subjectType: "org_a1",
        subjectId: uuid("o1"),
      },
      {
        objectType: "org_a1",
        objectId: uuid("o1"),
        relation: "viewer",
        subjectType: "user_a1",
        subjectId: uuid("alice"),
      },
      {
        objectType: "doc_a1",
        objectId: uuid("d2"),
        relation: "parent",
        subjectType: "folder_a1",
        subjectId: uuid("f1"),
        conditionName: "valid_ip_a1",
      },
      {
        objectType: "doc_a1",
        objectId: uuid("d2"),
        relation: "owner",
        subjectType: "org_a1",
        subjectId: uuid("o2"),
      },
      {
        objectType: "doc_a1",
        objectId: uuid("d3"),
        relation: "parent",
        subjectType: "folder_a1",
        subjectId: uuid("f1"),
        conditionName: "valid_ip_a1",
      },
      {
        objectType: "doc_a1",
        objectId: uuid("d3"),
        relation: "arm_and_direct",
        subjectType: "user_a1",
        subjectId: uuid("alice"),
      },
      {
        objectType: "doc_a1",
        objectId: uuid("d4"),
        relation: "parent",
        subjectType: "folder_a1",
        subjectId: uuid("f2"),
        conditionName: "valid_ip_a1",
        conditionContext: { user_ip: "192.168.0.1" },
      },
      {
        objectType: "doc_a1",
        objectId: uuid("d4"),
        relation: "owner",
        subjectType: "org_a1",
        subjectId: uuid("o1"),
      },
      {
        objectType: "folder_a1",
        objectId: uuid("f1"),
        relation: "viewer",
        subjectType: "user_a1",
        subjectId: uuid("alice"),
      },
    ];
    for (const tuple of tuples) {
      await tsfgaClient.addTuple(tuple);
    }

    storeId = await fgaCreateStore("ttu-arms");
    authorizationModelId = await fgaWriteModel(storeId, "./ttu-arms/model.dsl");
    await fgaWriteTuples(
      storeId,
      "./ttu-arms/tuples.yaml",
      authorizationModelId,
      uuidMap,
    );
  });

  afterAll(async () => {
    await rollbackTransaction(db);
    await destroyDb();
  });

  test("001: a broken TTU arm does not sink the arm beside it", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "doc_a1",
        objectId: uuid("d1"),
        relation: "two_arms",
        subjectType: "user_a1",
        subjectId: uuid("alice"),
      },
      true,
    );
  });

  test("a broken arm with no granting sibling refuses on both", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "doc_a1",
        objectId: uuid("d2"),
        relation: "two_arms",
        subjectType: "user_a1",
        subjectId: uuid("alice"),
      },
      "refused",
    );
  });

  test("a direct grant beside a broken TTU arm still grants", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "doc_a1",
        objectId: uuid("d3"),
        relation: "arm_and_direct",
        subjectType: "user_a1",
        subjectId: uuid("alice"),
      },
      true,
    );
  });

  test("both arms evaluable: the granting one wins", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "doc_a1",
        objectId: uuid("d4"),
        relation: "two_arms",
        subjectType: "user_a1",
        subjectId: uuid("alice"),
      },
      true,
    );
  });

  test("with the context supplied, the broken arm becomes live", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "doc_a1",
        objectId: uuid("d2"),
        relation: "two_arms",
        subjectType: "user_a1",
        subjectId: uuid("alice"),
        context: { user_ip: "192.168.0.1" },
      },
      true,
    );
  });

  test("the relation configs say what the model says", () => {
    expectConfigsMatchModel("./ttu-arms/model.dsl", fixture, {
      coverage: "complete",
    });
  });
});
