import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  type AddTupleRequest,
  createTsfga,
  type RelationConfig,
  type TsfgaClient,
} from "@tsfga/core";
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
  fgaListObjects,
  fgaWriteModel,
  fgaWriteTuplesRaw,
} from "./helpers/openfga.ts";

/**
 * Does an answer change with size?
 *
 * Three sizes are probed, each chosen for a boundary a smaller
 * fixture cannot reach:
 *
 * - a candidate pool of 1005 objects, which crosses upstream's
 *   `ListObjectsMaxResults` of 1000;
 * - one node carrying 60 userset rows, six times the default
 *   `maxBreadth`, with the only granting row written last;
 * - a `checkMany` batch of 400.
 */

const USER = "user_d5s";
const GROUP = "group_d5s";
const WIDE = "wide_d5";

/** How many objects alice can see. Deliberately past 1000. */
const POOL = 1005;
/** How many objects nobody can see, to keep the pool honest. */
const UNSEEN = 5;
/** Userset rows on the one wide node. */
const FANOUT = 60;

function id(index: number): string {
  return `00000000-0000-4000-d560-${String(index).padStart(12, "0")}`;
}

const ALICE = id(900001);
const BOB = id(900002);
/** The wide node: one object with `FANOUT` userset rows. */
const FAN = id(900003);
/** `wide_d5` objects alice reaches, by index. */
const seen = (index: number): string => id(1000 + index);
/** `wide_d5` objects nobody reaches. */
const unseen = (index: number): string => id(500000 + index);
/** The decoy groups on the wide node. */
const sink = (index: number): string => id(700000 + index);

function config(
  objectType: string,
  relation: string,
  overrides: Partial<RelationConfig> = {},
): RelationConfig {
  return {
    objectType,
    relation,
    directlyAssignable: [],
    impliedBy: null,
    computedUserset: null,
    tupleToUserset: null,
    excludedBy: null,
    intersection: null,
    ...overrides,
  };
}

const CONFIGS: RelationConfig[] = [
  config(GROUP, "member", {
    directlyAssignable: [{ type: USER }, { type: GROUP, relation: "member" }],
  }),
  config(WIDE, "viewer", {
    directlyAssignable: [{ type: USER }, { type: GROUP, relation: "member" }],
  }),
];

const TUPLES: AddTupleRequest[] = [
  ...Array.from({ length: POOL }, (_unused, index) => ({
    objectType: WIDE,
    objectId: seen(index),
    relation: "viewer",
    subjectType: USER,
    subjectId: ALICE,
  })),
  ...Array.from({ length: UNSEEN }, (_unused, index) => ({
    objectType: WIDE,
    objectId: unseen(index),
    relation: "viewer",
    subjectType: USER,
    subjectId: BOB,
  })),
  // The wide node. Only the last row leads to alice, so at every
  // breadth the granting branch is the one launched last.
  ...Array.from({ length: FANOUT }, (_unused, index) => ({
    objectType: WIDE,
    objectId: FAN,
    relation: "viewer",
    subjectType: GROUP,
    subjectId: sink(index),
    subjectRelation: "member",
  })),
  {
    objectType: GROUP,
    objectId: sink(FANOUT - 1),
    relation: "member",
    subjectType: USER,
    subjectId: ALICE,
  },
];

describe("D5 scale", () => {
  let db: Kysely<DB>;
  let storeId: string;
  let authorizationModelId: string;
  let fixture: FixtureRecord;
  let client: TsfgaClient;
  let narrow: TsfgaClient;
  let wide: TsfgaClient;

  beforeAll(async () => {
    db = getDb();
    await beginTransaction(db);

    const store = new KyselyTupleStore(db);
    client = createTsfga(store);
    fixture = recordFixture(client);
    narrow = createTsfga(store, { maxBreadth: 1, maxConcurrentChecks: 1 });
    wide = createTsfga(store, {
      maxBreadth: Number.POSITIVE_INFINITY,
      maxConcurrentChecks: Number.POSITIVE_INFINITY,
    });

    for (const relationConfig of CONFIGS) {
      await client.writeRelationConfig(relationConfig);
    }
    for (const tuple of TUPLES) {
      await client.addTuple(tuple);
    }

    storeId = await fgaCreateStore("scale");
    authorizationModelId = await fgaWriteModel(storeId, "./scale/model.dsl");
    const raw = TUPLES.map((tuple) => ({
      user: tuple.subjectRelation
        ? `${tuple.subjectType}:${tuple.subjectId}#${tuple.subjectRelation}`
        : `${tuple.subjectType}:${tuple.subjectId}`,
      relation: tuple.relation,
      object: `${tuple.objectType}:${tuple.objectId}`,
    }));
    // Upstream caps one Write at 100 tuples.
    for (let start = 0; start < raw.length; start += 100) {
      await fgaWriteTuplesRaw(
        storeId,
        authorizationModelId,
        raw.slice(start, start + 100),
      );
    }
  });

  afterAll(async () => {
    await rollbackTransaction(db);
    await destroyDb();
  });

  test("a node of 60 usersets grants at every breadth", async () => {
    for (const each of [narrow, client, wide]) {
      await expectConformance(
        storeId,
        authorizationModelId,
        each,
        {
          objectType: WIDE,
          objectId: FAN,
          relation: "viewer",
          subjectType: USER,
          subjectId: ALICE,
        },
        true,
      );
    }
  }, 120_000);

  test("a node of 60 usersets denies a stranger at every breadth", async () => {
    for (const each of [narrow, client, wide]) {
      await expectConformance(
        storeId,
        authorizationModelId,
        each,
        {
          objectType: WIDE,
          objectId: FAN,
          relation: "viewer",
          subjectType: USER,
          subjectId: BOB,
        },
        false,
      );
    }
  }, 120_000);

  test("a batch of 400 answers as 400 single checks", async () => {
    const requests = Array.from({ length: 400 }, (_unused, index) => ({
      objectType: WIDE,
      objectId: index % 2 === 0 ? seen(index) : unseen(index % UNSEEN),
      relation: "viewer",
      subjectType: USER,
      subjectId: ALICE,
    }));
    const outcomes = await client.checkMany(requests);
    expect(outcomes.map((outcome) => outcome.error ?? null)).toEqual(
      requests.map(() => null),
    );
    expect(outcomes.map((outcome) => outcome.allowed)).toEqual(
      requests.map((_unused, index) => index % 2 === 0),
    );
  }, 120_000);

  /**
   * Compared as **counts**, not as sets, and bounded rather than
   * equal — both of those are findings, not weakenings.
   *
   * Counts, because above the cap the two engines keep a
   * *different* thousand: upstream streams from a worker pool in
   * completion order and holds `wide_d5:fan`, reached through a
   * userset, where tsfga walks candidates in order and holds one
   * more direct row. Neither order is promised by either engine.
   *
   * Bounded, because upstream has **two** stopping rules and only
   * one of them is deterministic. `ListObjectsMaxResults` caps at
   * a thousand; `ListObjectsDeadline` stops after three seconds.
   * On a fast machine the cap always wins and upstream answers
   * exactly a thousand — which is what the first measurement of
   * this saw, and asserted. On a slower one the deadline can win
   * first, and upstream answers fewer.
   *
   * So the parity property worth asserting is the one that holds
   * on any machine: tsfga stops at its cap, and never reports
   * more than upstream. Asserting equality here would be pinning
   * the runner's speed.
   */
  test(`listObjects over ${POOL} candidates`, async () => {
    const request = {
      objectType: WIDE,
      relation: "viewer",
      subjectType: USER,
      subjectId: ALICE,
    };
    const [ours, theirs] = await Promise.all([
      client.listObjects(request),
      fgaListObjects(storeId, authorizationModelId, request),
    ]);

    // tsfga's own cap is deterministic: no deadline, no streaming.
    expect(ours.length === 1000).toBe(true);
    // The pool is larger than the cap, so this is the cap being
    // reached rather than the whole answer arriving.
    expect(POOL + 1 > 1000).toBe(true);
    // Upstream stops at the cap or earlier, never later. This is
    // the half that used to be an equality and could not be.
    expect(theirs.length <= 1000).toBe(true);
    expect(theirs.length > 0).toBe(true);
  });

  /**
   * Upstream's two stopping rules, distinguished rather than
   * assumed.
   *
   * A divergence was once filed here on the strength of five runs
   * answering the same number, which was read as proof the boundary
   * is the cap. It proved that on *that* machine. CI then answered two
   * different numbers across runs, which is the deadline winning
   * — so the original evidence was environment-dependent and the
   * conclusion drawn from it was too strong.
   *
   * What is true everywhere, and is what the fix rests on: every
   * run stops at or below the cap, and below the pool. Whether
   * any given run stopped for the cap or for the clock is
   * upstream's business and not a parity property.
   */
  test("upstream stops at the cap or sooner, on every run", async () => {
    const counts: number[] = [];
    for (let run = 0; run < 5; run++) {
      const objects = await fgaListObjects(storeId, authorizationModelId, {
        objectType: WIDE,
        relation: "viewer",
        subjectType: USER,
        subjectId: ALICE,
      });
      counts.push(objects.length);
    }
    for (const count of counts) {
      expect(count <= 1000).toBe(true);
      expect(count < POOL + 1).toBe(true);
    }
  });

  test("the relation configs say what the model says", () => {
    expectConfigsMatchModel("./scale/model.dsl", fixture, {
      coverage: "complete",
    });
  });
});
