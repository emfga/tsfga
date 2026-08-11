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

// A 30-relation rewrite ladder on a single object, deeper than the
// default resolution limit of 25, with an exclusion at lvl15 and an
// intersection at lvl20.
//
// OpenFGA increments resolution depth only when it *dispatches* to
// another object — userset and tuple-to-userset expansion. Rewrites
// of the same object (computed userset, `but not`, `and`) cost no
// depth: `checkComputedUserset` calls `ResolveCheck` directly with
// the comment "No dispatch here, as we don't want to increase
// resolution depth", and set operations are built on the unchanged
// request. So this ladder resolves on OpenFGA at the default limit
// however long it is.
//
// tsfga used to charge one depth per rewrite and so threw
// DepthExceededError here — this fixture is the regression test for
// that divergence.
//
// Ref: https://github.com/openfga/openfga/blob/560d5d3dd46b5adda9ecfb29efeb4f4f70c96327/internal/graph/check.go#L856
// Ref: https://github.com/openfga/openfga/blob/560d5d3dd46b5adda9ecfb29efeb4f4f70c96327/internal/graph/check.go#L415

const DEPTH = 30;
const EXCLUSION_AT = 15;
const INTERSECTION_AT = 20;

const uuidMap = new Map<string, string>([
  ["anne", "00000000-0000-4000-c600-000000000001"],
  ["bob", "00000000-0000-4000-c600-000000000002"],
  ["carl", "00000000-0000-4000-c600-000000000003"],
  ["dave", "00000000-0000-4000-c600-000000000004"],
  ["1", "00000000-0000-4000-c600-000000000005"],
]);

function uuid(name: string): string {
  const id = uuidMap.get(name);
  if (!id) throw new Error(`No UUID for ${name}`);
  return id;
}

describe("Deep Rewrite Ladder Conformance", () => {
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

    // === Relation configs: the ladder ===
    for (let i = 0; i < DEPTH; i++) {
      const isIntersection = i === INTERSECTION_AT;
      await tsfgaClient.writeRelationConfig({
        objectType: "document",
        relation: `lvl${i}`,
        // Purely computed in the model: no direct assignment at
        // all, so these rungs issue no tuple read.
        directlyAssignable: [],
        impliedBy: null,
        computedUserset: isIntersection ? null : `lvl${i + 1}`,
        tupleToUserset: null,
        excludedBy: i === EXCLUSION_AT ? "blocked" : null,
        intersection: isIntersection
          ? [
              { type: "computedUserset", relation: `lvl${i + 1}` },
              { type: "computedUserset", relation: "allowed" },
            ]
          : null,
      });
    }
    for (const relation of [`lvl${DEPTH}`, "blocked", "allowed"]) {
      await tsfgaClient.writeRelationConfig({
        objectType: "document",
        relation,
        directlyAssignable: ["user"],
        impliedBy: null,
        computedUserset: null,
        tupleToUserset: null,
        excludedBy: null,
        intersection: null,
      });
    }

    // === Tuples ===
    // anne reaches the bottom, is permitted and is not blocked.
    // bob is identical but blocked at lvl15.
    // carl is identical but fails the intersection at lvl20.
    // dave has nothing.
    for (const [subject, relations] of [
      ["anne", [`lvl${DEPTH}`, "allowed"]],
      ["bob", [`lvl${DEPTH}`, "allowed", "blocked"]],
      ["carl", [`lvl${DEPTH}`]],
    ] as const) {
      for (const relation of relations) {
        await tsfgaClient.addTuple({
          objectType: "document",
          objectId: uuid("1"),
          relation,
          subjectType: "user",
          subjectId: uuid(subject),
        });
      }
    }

    // Setup OpenFGA
    storeId = await fgaCreateStore("deep-rewrite-conformance");
    authorizationModelId = await fgaWriteModel(
      storeId,
      "./deep-rewrite/model.dsl",
    );
    await fgaWriteTuples(
      storeId,
      "./deep-rewrite/tuples.yaml",
      authorizationModelId,
      uuidMap,
    );
  });

  afterAll(async () => {
    await rollbackTransaction(db);
    await destroyDb();
  });

  test("1: 30 rewrites resolve at the default depth limit", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "document",
        objectId: uuid("1"),
        relation: "lvl0",
        subjectType: "user",
        subjectId: uuid("anne"),
      },
      true,
    );
  });

  test("2: exclusion partway up the ladder denies", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "document",
        objectId: uuid("1"),
        relation: "lvl0",
        subjectType: "user",
        subjectId: uuid("bob"),
      },
      false,
    );
  });

  test("3: intersection partway up the ladder denies", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "document",
        objectId: uuid("1"),
        relation: "lvl0",
        subjectType: "user",
        subjectId: uuid("carl"),
      },
      false,
    );
  });

  test("4: subject with no tuples at all is denied", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "document",
        objectId: uuid("1"),
        relation: "lvl0",
        subjectType: "user",
        subjectId: uuid("dave"),
      },
      false,
    );
  });

  test("5: an intermediate rung resolves the same way", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "document",
        objectId: uuid("1"),
        relation: `lvl${EXCLUSION_AT}`,
        subjectType: "user",
        subjectId: uuid("anne"),
      },
      true,
    );
  });

  test("the relation configs say what the model says", () => {
    expectConfigsMatchModel("./deep-rewrite/model.dsl", fixture, {
      coverage: "complete",
    });
  });
});
