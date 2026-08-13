import { afterAll, beforeAll, describe, test } from "bun:test";
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
  expectListObjectsConformance,
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
  fgaWriteTuplesRaw,
} from "./helpers/openfga.ts";

/**
 * One node with 120 userset arms, twelve times tsfga's default
 * `maxBreadth` and OpenFGA's default
 * `OPENFGA_RESOLVE_NODE_BREADTH_LIMIT`.
 *
 * The granting arm is deliberately last in insertion order, so a
 * breadth window that stopped after its first batch would answer
 * `false`. The same checks run at `maxBreadth: 1` and
 * `maxBreadth: Infinity`: breadth bounds concurrency, and on a
 * model with no cycle reaching an intersection operand it must not
 * bound the answer.
 */

const ARMS = 120;

function id(n: number): string {
  return `00000000-0000-4000-d470-${String(n).padStart(12, "0")}`;
}
const ALICE = id(999999);
const GRANTING_DOC = id(100);
const EMPTY_DOC = id(101);

const cfg = (
  objectType: string,
  relation: string,
  extra: Partial<RelationConfig>,
): RelationConfig => ({
  objectType,
  relation,
  directlyAssignable: [],
  impliedBy: null,
  computedUserset: null,
  tupleToUserset: null,
  excludedBy: null,
  intersection: null,
  ...extra,
});

describe("Wide Fanout Conformance", () => {
  let db: Kysely<DB>;
  let storeId: string;
  let modelId: string;
  let tsfgaClient: TsfgaClient;
  let narrowClient: TsfgaClient;
  let unboundedClient: TsfgaClient;
  let fixture: FixtureRecord;

  beforeAll(async () => {
    db = getDb();
    await beginTransaction(db);
    const store = new KyselyTupleStore(db);
    tsfgaClient = createTsfga(store);
    narrowClient = createTsfga(store, { maxBreadth: 1 });
    unboundedClient = createTsfga(store, {
      maxBreadth: Number.POSITIVE_INFINITY,
    });
    fixture = recordFixture(tsfgaClient);

    for (const c of [
      cfg("wgroup_a8", "member", { directlyAssignable: [{ type: "user_a8" }] }),
      cfg("wdoc_a8", "viewer", {
        directlyAssignable: [
          { type: "user_a8" },
          { type: "wgroup_a8", relation: "member" },
        ],
      }),
    ]) {
      await tsfgaClient.writeRelationConfig(c);
    }

    const rows: AddTupleRequest[] = [];
    // The granting doc: 120 arms, the member sitting on the last.
    for (let g = 0; g < ARMS; g++) {
      rows.push({
        objectType: "wdoc_a8",
        objectId: GRANTING_DOC,
        relation: "viewer",
        subjectType: "wgroup_a8",
        subjectId: id(200 + g),
        subjectRelation: "member",
      });
    }
    rows.push({
      objectType: "wgroup_a8",
      objectId: id(200 + ARMS - 1),
      relation: "member",
      subjectType: "user_a8",
      subjectId: ALICE,
    });
    // A second doc, just as wide, with a disjoint set of groups
    // that hold nobody.
    for (let g = 0; g < ARMS; g++) {
      rows.push({
        objectType: "wdoc_a8",
        objectId: EMPTY_DOC,
        relation: "viewer",
        subjectType: "wgroup_a8",
        subjectId: id(400 + g),
        subjectRelation: "member",
      });
    }

    for (const row of rows) await tsfgaClient.addTuple(row);

    storeId = await fgaCreateStore("fanout-conformance");
    modelId = await fgaWriteModel(storeId, "./fanout/model.dsl");
    const fga = rows.map((r) => ({
      user: r.subjectRelation
        ? `${r.subjectType}:${r.subjectId}#${r.subjectRelation}`
        : `${r.subjectType}:${r.subjectId}`,
      relation: r.relation,
      object: `${r.objectType}:${r.objectId}`,
    }));
    for (let i = 0; i < fga.length; i += 50) {
      await fgaWriteTuplesRaw(storeId, modelId, fga.slice(i, i + 50));
    }
  });

  afterAll(async () => {
    await rollbackTransaction(db);
    await destroyDb();
  });

  const check = (objectId: string) => ({
    objectType: "wdoc_a8",
    objectId,
    relation: "viewer",
    subjectType: "user_a8",
    subjectId: ALICE,
  });

  for (const [label, client] of [
    ["default breadth", () => tsfgaClient],
    ["maxBreadth 1", () => narrowClient],
    ["unbounded breadth", () => unboundedClient],
  ] as const) {
    describe(label, () => {
      test("the 120th arm still grants", async () => {
        await expectConformance(
          storeId,
          modelId,
          client(),
          check(GRANTING_DOC),
          true,
        );
      });

      test("120 arms that hold nobody deny", async () => {
        await expectConformance(
          storeId,
          modelId,
          client(),
          check(EMPTY_DOC),
          false,
        );
      });
    });
  }

  test("listObjects over the wide node", async () => {
    await expectListObjectsConformance(
      storeId,
      modelId,
      tsfgaClient,
      {
        objectType: "wdoc_a8",
        relation: "viewer",
        subjectType: "user_a8",
        subjectId: ALICE,
      },
      [GRANTING_DOC],
    );
  });

  test("the relation configs say what the model says", () => {
    expectConfigsMatchModel("./fanout/model.dsl", fixture, {
      coverage: "complete",
    });
  });
});
