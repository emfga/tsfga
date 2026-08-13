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
  expectPinnedListObjectsDivergence,
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
 * What the depth budget does to `listObjects`, and what it does to
 * the set operators.
 *
 * The two halves answer the same question in opposite directions.
 * On `check`, an operand past the budget makes *both* engines
 * decline the whole request, in every set position — that half
 * passes. On `listObjects` they part company: upstream walks the
 * relation backwards from the subject and reports everything it
 * reaches, including objects whose forward `check` it would refuse
 * as too complex; tsfga checks each candidate forward, so a
 * candidate further from the grant than the budget allows is
 * simply absent from the answer.
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

/** The ids of a chain, root first. */
function chain(from: number, to: number): string[] {
  const ids: string[] = [];
  for (let i = from; i <= to; i++) ids.push(id(i));
  return ids;
}

describe("ListObjects Depth Conformance", () => {
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

    const configs: RelationConfig[] = [];
    for (const type of ["sdoc_a8", "tdoc_a8"]) {
      configs.push(
        cfg(type, "parent", { directlyAssignable: [{ type }] }),
        cfg(type, "viewer", {
          directlyAssignable: [{ type: "user_a8" }],
          tupleToUserset: [{ tupleset: "parent", computedUserset: "viewer" }],
        }),
      );
    }
    configs.push(
      cfg("sgroup_a8", "member", {
        directlyAssignable: [
          { type: "user_a8" },
          { type: "sgroup_a8", relation: "member" },
        ],
      }),
      cfg("xdoc_a8", "parent", { directlyAssignable: [{ type: "xdoc_a8" }] }),
      cfg("xdoc_a8", "base", { directlyAssignable: [{ type: "user_a8" }] }),
      cfg("xdoc_a8", "deep", {
        directlyAssignable: [{ type: "user_a8" }],
        tupleToUserset: [{ tupleset: "parent", computedUserset: "deep" }],
      }),
      cfg("xdoc_a8", "allow_not_deep", {
        computedUserset: "base",
        excludedBy: "deep",
      }),
      cfg("xdoc_a8", "allow_or_deep", { impliedBy: ["base", "deep"] }),
      cfg("xdoc_a8", "allow_and_deep", {
        intersection: [
          { type: "computedUserset", relation: "base" },
          { type: "computedUserset", relation: "deep" },
        ],
      }),
    );
    for (const c of configs) await tsfgaClient.writeRelationConfig(c);

    const rows: AddTupleRequest[] = [];
    const parentChain = (
      type: string,
      relation: string,
      a: number,
      b: number,
    ) => {
      for (let i = a; i < b; i++) {
        rows.push({
          objectType: type,
          objectId: id(i),
          relation,
          subjectType: type,
          subjectId: id(i + 1),
        });
      }
    };
    const grant = (type: string, relation: string, n: number) => {
      rows.push({
        objectType: type,
        objectId: id(n),
        relation,
        subjectType: "user_a8",
        subjectId: ALICE,
      });
    };

    // sdoc: one 10-hop chain, inside both budgets end to end.
    parentChain("sdoc_a8", "parent", 1000, 1010);
    grant("sdoc_a8", "viewer", 1010);

    // tdoc: the same 10-hop chain, plus a 40-hop one whose root is
    // past both check budgets.
    parentChain("tdoc_a8", "parent", 1000, 1010);
    grant("tdoc_a8", "viewer", 1010);
    parentChain("tdoc_a8", "parent", 2000, 2040);
    grant("tdoc_a8", "viewer", 2040);

    // sgroup: the same shape, recursing through a userset.
    for (let i = 3000; i < 3040; i++) {
      rows.push({
        objectType: "sgroup_a8",
        objectId: id(i),
        relation: "member",
        subjectType: "sgroup_a8",
        subjectId: id(i + 1),
        subjectRelation: "member",
      });
    }
    grant("sgroup_a8", "member", 3040);

    // xdoc: `base` grants at the root, `deep` needs 40 hops.
    grant("xdoc_a8", "base", 4000);
    parentChain("xdoc_a8", "parent", 4000, 4040);
    grant("xdoc_a8", "deep", 4040);

    for (const row of rows) await tsfgaClient.addTuple(row);

    storeId = await fgaCreateStore("list-objects-depth-budget-conformance");
    modelId = await fgaWriteModel(
      storeId,
      "./list-objects-depth-budget/model.dsl",
    );
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

  test("listObjects over a chain inside the budget", async () => {
    await expectListObjectsConformance(
      storeId,
      modelId,
      tsfgaClient,
      {
        objectType: "sdoc_a8",
        relation: "viewer",
        subjectType: "user_a8",
        subjectId: ALICE,
      },
      chain(1000, 1010),
    );
  });

  /**
   * The 40-hop chain is longer than tsfga's forward budget, so the
   * objects at its root are out of reach: `t2000` is 40 dispatches
   * from the grant and `check` refuses it, exactly as upstream's
   * own `Check` refuses it. What tsfga keeps is everything within
   * the budget of the grant — the whole 10-hop chain, and the last
   * 25 links of the 40-hop one.
   *
   * Upstream reports all 52 because ListObjects does not go
   * through `Check` there: it reverse-expands from the subject over
   * a job queue, so the chain costs it no depth at all.
   *
   * Pinned rather than left failing: the shortfall is the missing
   * reverse walk, which is the same machinery the depth-boundary
   * divergence names, and a divergence nothing asserts is
   * indistinguishable from one nobody has noticed.
   */
  test("listObjects reaches past the check budget (TTU)", async () => {
    await expectPinnedListObjectsDivergence(
      storeId,
      modelId,
      tsfgaClient,
      {
        objectType: "tdoc_a8",
        relation: "viewer",
        subjectType: "user_a8",
        subjectId: ALICE,
      },
      {
        openfga: [...chain(1000, 1010), ...chain(2000, 2040)],
        tsfga: [...chain(1000, 1010), ...chain(2016, 2040)],
      },
    );
  });

  /**
   * The same shortfall one hop at a time through usersets rather
   * than through a tupleset. There is no shallow chain on this
   * type, so the pin is purely the tail of the 40-hop one.
   */
  test("listObjects reaches past the check budget (userset)", async () => {
    await expectPinnedListObjectsDivergence(
      storeId,
      modelId,
      tsfgaClient,
      {
        objectType: "sgroup_a8",
        relation: "member",
        subjectType: "user_a8",
        subjectId: ALICE,
      },
      { openfga: chain(3000, 3040), tsfga: chain(3016, 3040) },
    );
  });

  describe("a check operand past the budget", () => {
    const root = (relation: string) => ({
      objectType: "xdoc_a8",
      objectId: id(4000),
      relation,
      subjectType: "user_a8",
      subjectId: ALICE,
    });

    test("the shallow operand alone answers", async () => {
      await expectConformance(
        storeId,
        modelId,
        tsfgaClient,
        root("base"),
        true,
      );
    });

    test("the deep operand alone is refused by both", async () => {
      await expectConformance(
        storeId,
        modelId,
        tsfgaClient,
        root("deep"),
        "refused",
      );
    });

    test("a union whose other branch grants answers on both", async () => {
      await expectConformance(
        storeId,
        modelId,
        tsfgaClient,
        root("allow_or_deep"),
        true,
      );
    });

    test("an exclusion whose subtract side is too deep is refused", async () => {
      await expectConformance(
        storeId,
        modelId,
        tsfgaClient,
        root("allow_not_deep"),
        "refused",
      );
    });

    test("an intersection with a too-deep operand is refused", async () => {
      await expectConformance(
        storeId,
        modelId,
        tsfgaClient,
        root("allow_and_deep"),
        "refused",
      );
    });
  });

  test("the relation configs say what the model says", () => {
    expectConfigsMatchModel("./list-objects-depth-budget/model.dsl", fixture, {
      coverage: "complete",
    });
  });
});
