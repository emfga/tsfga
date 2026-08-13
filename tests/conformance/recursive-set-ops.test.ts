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
  expectPinnedDivergence,
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
 * A looping *recursive* relation in every set position.
 *
 * `cycles.test.ts` builds its loop from two alternating relations
 * (`member -> owner -> member`) precisely to avoid the recursive
 * shapes, because upstream serves those with dedicated resolvers
 * that walk the reachable set iteratively and return a definitive
 * `false` where the ordinary resolver would report a cycle. That
 * difference is the divergence `packages/core/README.md` records
 * under "recursive relations", and until now nothing asserted it.
 *
 * It is asserted here on both recursive shapes upstream has a
 * resolver for — a relation assignable to a userset of itself, and
 * a TTU that recurses on its own relation — and in every position
 * where a cycle could matter. Only the subtract side of a `but
 * not` diverges: everywhere else a cycled `false` and a plain
 * `false` behave alike.
 */

function id(n: number): string {
  return `00000000-0000-4000-d470-${String(n).padStart(12, "0")}`;
}
const ALICE = id(999999);

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

describe("Recursive Loop Conformance", () => {
  let db: Kysely<DB>;
  let storeId: string;
  let modelId: string;
  let tsfgaClient: TsfgaClient;
  let fixture: FixtureRecord;

  beforeAll(async () => {
    db = getDb();
    await beginTransaction(db);
    tsfgaClient = createTsfga(new KyselyTupleStore(db));
    fixture = recordFixture(tsfgaClient);

    const configs: RelationConfig[] = [
      cfg("rgroup_a8", "member", {
        directlyAssignable: [
          { type: "user_a8" },
          { type: "rgroup_a8", relation: "member" },
        ],
      }),
      cfg("rfolder_a8", "parent", {
        directlyAssignable: [{ type: "rfolder_a8" }],
      }),
      cfg("rfolder_a8", "viewer", {
        directlyAssignable: [{ type: "user_a8" }],
        tupleToUserset: [{ tupleset: "parent", computedUserset: "viewer" }],
      }),
      cfg("rdoc_a8", "base", { directlyAssignable: [{ type: "user_a8" }] }),
      cfg("rdoc_a8", "loopset", {
        directlyAssignable: [{ type: "rgroup_a8", relation: "member" }],
      }),
      cfg("rdoc_a8", "loopttu", {
        directlyAssignable: [{ type: "rfolder_a8", relation: "viewer" }],
      }),
      cfg("rdoc_a8", "subtract_userset", {
        computedUserset: "base",
        excludedBy: "loopset",
      }),
      cfg("rdoc_a8", "subtract_ttu", {
        computedUserset: "base",
        excludedBy: "loopttu",
      }),
      cfg("rdoc_a8", "union_userset", { impliedBy: ["base", "loopset"] }),
      cfg("rdoc_a8", "intersect_userset", {
        intersection: [
          { type: "computedUserset", relation: "base" },
          { type: "computedUserset", relation: "loopset" },
        ],
      }),
    ];
    for (const c of configs) await tsfgaClient.writeRelationConfig(c);

    const rows: AddTupleRequest[] = [
      // A two-node userset loop with no user anywhere in it.
      {
        objectType: "rgroup_a8",
        objectId: id(1),
        relation: "member",
        subjectType: "rgroup_a8",
        subjectId: id(2),
        subjectRelation: "member",
      },
      {
        objectType: "rgroup_a8",
        objectId: id(2),
        relation: "member",
        subjectType: "rgroup_a8",
        subjectId: id(1),
        subjectRelation: "member",
      },
      // The same loop for the TTU shape.
      {
        objectType: "rfolder_a8",
        objectId: id(3),
        relation: "parent",
        subjectType: "rfolder_a8",
        subjectId: id(4),
      },
      {
        objectType: "rfolder_a8",
        objectId: id(4),
        relation: "parent",
        subjectType: "rfolder_a8",
        subjectId: id(3),
      },
      // A loop that also has a way out: g5 <-> g6, and g6 grants.
      {
        objectType: "rgroup_a8",
        objectId: id(5),
        relation: "member",
        subjectType: "rgroup_a8",
        subjectId: id(6),
        subjectRelation: "member",
      },
      {
        objectType: "rgroup_a8",
        objectId: id(6),
        relation: "member",
        subjectType: "rgroup_a8",
        subjectId: id(5),
        subjectRelation: "member",
      },
      {
        objectType: "rgroup_a8",
        objectId: id(6),
        relation: "member",
        subjectType: "user_a8",
        subjectId: ALICE,
      },
      // The same, for the TTU shape.
      {
        objectType: "rfolder_a8",
        objectId: id(7),
        relation: "parent",
        subjectType: "rfolder_a8",
        subjectId: id(8),
      },
      {
        objectType: "rfolder_a8",
        objectId: id(8),
        relation: "parent",
        subjectType: "rfolder_a8",
        subjectId: id(7),
      },
      {
        objectType: "rfolder_a8",
        objectId: id(8),
        relation: "viewer",
        subjectType: "user_a8",
        subjectId: ALICE,
      },
      // The doc under test: it grants `base`, and both loop
      // relations point into the loops that go nowhere.
      {
        objectType: "rdoc_a8",
        objectId: id(10),
        relation: "base",
        subjectType: "user_a8",
        subjectId: ALICE,
      },
      {
        objectType: "rdoc_a8",
        objectId: id(10),
        relation: "loopset",
        subjectType: "rgroup_a8",
        subjectId: id(1),
        subjectRelation: "member",
      },
      {
        objectType: "rdoc_a8",
        objectId: id(10),
        relation: "loopttu",
        subjectType: "rfolder_a8",
        subjectId: id(3),
        subjectRelation: "viewer",
      },
    ];
    for (const row of rows) await tsfgaClient.addTuple(row);

    storeId = await fgaCreateStore("recursive-set-ops-conformance");
    modelId = await fgaWriteModel(storeId, "./recursive-set-ops/model.dsl");
    await fgaWriteTuplesRaw(
      storeId,
      modelId,
      rows.map((r) => ({
        user: r.subjectRelation
          ? `${r.subjectType}:${r.subjectId}#${r.subjectRelation}`
          : `${r.subjectType}:${r.subjectId}`,
        relation: r.relation,
        object: `${r.objectType}:${r.objectId}`,
      })),
    );
  });

  afterAll(async () => {
    await rollbackTransaction(db);
    await destroyDb();
  });

  const doc = (relation: string, objectId = id(10)) => ({
    objectType: "rdoc_a8",
    objectId,
    relation,
    subjectType: "user_a8",
    subjectId: ALICE,
  });

  test("a userset loop that goes nowhere denies", async () => {
    await expectConformance(
      storeId,
      modelId,
      tsfgaClient,
      doc("loopset"),
      false,
    );
  });

  test("a TTU loop that goes nowhere denies", async () => {
    await expectConformance(
      storeId,
      modelId,
      tsfgaClient,
      doc("loopttu"),
      false,
    );
  });

  test("a loop with a way out still grants (userset)", async () => {
    await expectConformance(
      storeId,
      modelId,
      tsfgaClient,
      {
        objectType: "rgroup_a8",
        objectId: id(5),
        relation: "member",
        subjectType: "user_a8",
        subjectId: ALICE,
      },
      true,
    );
  });

  test("a loop with a way out still grants (TTU)", async () => {
    await expectConformance(
      storeId,
      modelId,
      tsfgaClient,
      {
        objectType: "rfolder_a8",
        objectId: id(7),
        relation: "viewer",
        subjectType: "user_a8",
        subjectId: ALICE,
      },
      true,
    );
  });

  test("a union beside a looping recursive relation grants", async () => {
    await expectConformance(
      storeId,
      modelId,
      tsfgaClient,
      doc("union_userset"),
      true,
    );
  });

  test("an intersection with a looping operand denies", async () => {
    await expectConformance(
      storeId,
      modelId,
      tsfgaClient,
      doc("intersect_userset"),
      false,
    );
  });

  /**
   * The one position where the resolver choice is observable:
   * upstream's recursive resolver reports a definitive `false` on
   * the subtract side, so the exclusion does not fire and the base
   * grant survives. tsfga reports a cycle there, and a cycle on
   * the subtract side denies.
   */
  test("a looping recursive userset on the subtract side", async () => {
    await expectPinnedDivergence(
      storeId,
      modelId,
      tsfgaClient,
      doc("subtract_userset"),
      { openfga: true, tsfga: false },
    );
  });

  test("a looping recursive TTU on the subtract side", async () => {
    await expectPinnedDivergence(
      storeId,
      modelId,
      tsfgaClient,
      doc("subtract_ttu"),
      { openfga: true, tsfga: false },
    );
  });

  test("the relation configs say what the model says", () => {
    expectConfigsMatchModel("./recursive-set-ops/model.dsl", fixture, {
      coverage: "complete",
    });
  });
});
