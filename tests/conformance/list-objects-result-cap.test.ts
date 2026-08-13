import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createTsfga, type TsfgaClient } from "@tsfga/core";
import type { DB } from "@tsfga/kysely";
import { KyselyTupleStore } from "@tsfga/kysely";
import type { Kysely } from "kysely";
import {
  expectConfigsMatchModel,
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
  fgaListObjects,
  fgaWriteModel,
  fgaWriteTuplesRaw,
} from "./helpers/openfga.ts";

/**
 * `listObjects`'s **result cap**, which tsfga does not have.
 *
 * `DefaultListObjectsMaxResults = 1000`
 * (`pkg/server/config/config.go:28`) is the number of objects
 * `ListObjectsQuery.Execute` will emit before it stops the
 * producers and returns what it has — see `maxResults` at
 * `pkg/server/commands/list_objects.go:511` and the bounded
 * collection below it. It is a cap on the *answer*, not a page
 * size: there is no cursor, and a caller who asks for a type with
 * more matches than that is told about a thousand of them and
 * nothing about the rest.
 *
 * tsfga's `listObjects` walks the whole candidate pool and returns
 * every object that checks, so the two engines return different
 * sets the moment a subject reaches more than a thousand objects.
 * Both answers are internally consistent — this is not a wrong
 * check — but they are not the same answer, and a consumer that
 * sized a page against upstream's behaviour gets a different shape
 * from tsfga.
 *
 * Written as one direct relation on purpose. Nothing here is about
 * rewrites; the smallest model that reaches the cap is the one
 * that isolates the cap.
 */

const ALICE = "00000000-0000-4000-d540-000000000301";

/** Comfortably past 1 000, and small enough to write in one go. */
const OBJECT_COUNT = 1100;

/** Upstream's `DefaultListObjectsMaxResults`. */
const MAX_RESULTS = 1000;

/** OpenFGA refuses a write of more than 40-odd tuple keys. */
const CHUNK = 40;

function objectId(index: number): string {
  return `00000000-0000-4000-d540-${String(index).padStart(12, "0")}`;
}

const OBJECT_IDS = Array.from({ length: OBJECT_COUNT }, (_, index) =>
  objectId(index + 1000),
);

const KNOWN = new Set(OBJECT_IDS);

describe("listObjects result-cap conformance", () => {
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

    await tsfgaClient.writeRelationConfig({
      objectType: "doc_d3l",
      relation: "viewer",
      directlyAssignable: [{ type: "user_d3l" }],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });

    storeId = await fgaCreateStore("list-objects-result-cap");
    authorizationModelId = await fgaWriteModel(
      storeId,
      "./list-objects-result-cap/model.dsl",
    );

    for (const id of OBJECT_IDS) {
      await tsfgaClient.addTuple({
        objectType: "doc_d3l",
        objectId: id,
        relation: "viewer",
        subjectType: "user_d3l",
        subjectId: ALICE,
      });
    }
    for (let start = 0; start < OBJECT_IDS.length; start += CHUNK) {
      await fgaWriteTuplesRaw(
        storeId,
        authorizationModelId,
        OBJECT_IDS.slice(start, start + CHUNK).map((id) => ({
          user: `user_d3l:${ALICE}`,
          relation: "viewer",
          object: `doc_d3l:${id}`,
        })),
      );
    }
  });

  afterAll(async () => {
    await rollbackTransaction(db);
    await destroyDb();
  });

  test("control: a check on one of the objects agrees", async () => {
    expect(
      await tsfgaClient.check({
        objectType: "doc_d3l",
        objectId: OBJECT_IDS[0] ?? "",
        relation: "viewer",
        subjectType: "user_d3l",
        subjectId: ALICE,
      }),
    ).toBe(true);
  });

  test("upstream caps listObjects at 1000 objects", async () => {
    const upstream = await fgaListObjects(storeId, authorizationModelId, {
      objectType: "doc_d3l",
      relation: "viewer",
      subjectType: "user_d3l",
      subjectId: ALICE,
    });
    expect(upstream).toHaveLength(MAX_RESULTS);
    // Every object upstream reported is a real grant. The cap is
    // a cap, not a wrong answer.
    expect(upstream.every((id) => KNOWN.has(id))).toBe(true);

    // Compared by **count**, not element by element. Which
    // thousand upstream keeps is whatever its worker pool
    // completed first, so an exact set comparison would be flaky
    // the moment tsfga also truncates — the divergence under test
    // is the size of the answer.
    const tsfgaObjects = await tsfgaClient.listObjects({
      objectType: "doc_d3l",
      relation: "viewer",
      subjectType: "user_d3l",
      subjectId: ALICE,
    });
    expect(tsfgaObjects.every((id) => KNOWN.has(id))).toBe(true);
    expect(tsfgaObjects).toHaveLength(MAX_RESULTS);
  });

  test("the relation configs say what the model says", () => {
    expectConfigsMatchModel("./list-objects-result-cap/model.dsl", fixture, {
      coverage: "complete",
    });
  });
});
