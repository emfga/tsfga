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

// A single node (document:1#viewer) fanning out to 12 userset
// branches — wider than the default maxBreadth of 10 — so the
// conformance suite exercises the bounded pull-model combinator's
// queued-branch path against real OpenFGA, not just in-window
// launches. Grants are placed both inside the launch window
// (team1) and past it (team12), and the miss case must traverse
// all 12 branches.
//
// Ref: https://github.com/openfga/openfga/blob/81c6202153a853d90589565884a56942c3fd07be/pkg/server/config/config.go#L26
// (DefaultResolveNodeBreadthLimit = 10 — same default as tsfga)

const TEAM_COUNT = 12;

const uuidMap = new Map<string, string>([
  ["anne", "00000000-0000-4000-c500-000000000001"],
  ["bob", "00000000-0000-4000-c500-000000000002"],
  ["carl", "00000000-0000-4000-c500-000000000003"],
  ["1", "00000000-0000-4000-c500-000000000004"],
]);
for (let i = 1; i <= TEAM_COUNT; i++) {
  const suffix = (16 + i).toString(16).padStart(2, "0");
  uuidMap.set(`team${i}`, `00000000-0000-4000-c500-0000000000${suffix}`);
}

function uuid(name: string): string {
  const id = uuidMap.get(name);
  if (!id) throw new Error(`No UUID for ${name}`);
  return id;
}

describe("Wide Union Conformance", () => {
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
    await tsfgaClient.writeRelationConfig({
      objectType: "team",
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
      relation: "viewer",
      directlyAssignable: ["team#member"],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });

    // === Tuples: 12 userset branches on one node ===
    for (let i = 1; i <= TEAM_COUNT; i++) {
      await tsfgaClient.addTuple({
        objectType: "document",
        objectId: uuid("1"),
        relation: "viewer",
        subjectType: "team",
        subjectId: uuid(`team${i}`),
        subjectRelation: "member",
      });
    }
    // anne only in the last team (queued past the default launch
    // window); bob only in the first (in-window).
    await tsfgaClient.addTuple({
      objectType: "team",
      objectId: uuid(`team${TEAM_COUNT}`),
      relation: "member",
      subjectType: "user",
      subjectId: uuid("anne"),
    });
    await tsfgaClient.addTuple({
      objectType: "team",
      objectId: uuid("team1"),
      relation: "member",
      subjectType: "user",
      subjectId: uuid("bob"),
    });

    // Setup OpenFGA
    storeId = await fgaCreateStore("wide-union-conformance");
    authorizationModelId = await fgaWriteModel(
      storeId,
      "./wide-union/model.dsl",
    );
    await fgaWriteTuples(
      storeId,
      "./wide-union/tuples.yaml",
      authorizationModelId,
      uuidMap,
    );
  });

  afterAll(async () => {
    await rollbackTransaction(db);
    await destroyDb();
  });

  test("1: grant found in a branch queued past the window", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "document",
        objectId: uuid("1"),
        relation: "viewer",
        subjectType: "user",
        subjectId: uuid("anne"),
      },
      true,
    );
  });

  test("2: grant found in an in-window branch", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "document",
        objectId: uuid("1"),
        relation: "viewer",
        subjectType: "user",
        subjectId: uuid("bob"),
      },
      true,
    );
  });

  test("3: miss traverses all branches", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "document",
        objectId: uuid("1"),
        relation: "viewer",
        subjectType: "user",
        subjectId: uuid("carl"),
      },
      false,
    );
  });

  test("the relation configs say what the model says", () => {
    expectConfigsMatchModel("./wide-union/model.dsl", fixture, {
      coverage: "complete",
    });
  });
});
