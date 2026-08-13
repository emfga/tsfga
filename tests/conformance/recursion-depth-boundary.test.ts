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
 * Where recursion stops resolving, on every recursive shape the
 * library supports.
 *
 * `depth-boundary.test.ts` pins the offset on one shape — a plain
 * TTU chain — and the README explains why it exists. This sweeps
 * the family, because the offset is a property of *which* resolver
 * upstream picks, and upstream picks a different one per shape:
 *
 *   TTU recursion            offset (tsfga stops one hop earlier)
 *   userset recursion        offset
 *   TTU + an extra rewrite   offset
 *   userset + an extra arm   offset
 *   mutual recursion         no offset — the two agree exactly
 *   TTU with a terminal
 *     userset hop            no offset
 *
 * Mutual recursion is the interesting negative: upstream's
 * recursive resolvers key on a relation recursing on *itself*, so
 * `adoc#viewer -> bdoc#viewer -> adoc#viewer` falls through to the
 * ordinary resolver and both engines exhaust at the same hop. It
 * is asserted with `expectConformance` for that reason — if a
 * future parity fix raises tsfga's reach by a constant, this row
 * goes red, which is exactly the failure a constant correction
 * would deserve.
 *
 * Rewrite ladders and diamonds are here too: neither spends the
 * budget upstream, and neither does here.
 */

const N = 100;
const LADDER = 40;

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

describe("Recursion Depth Conformance", () => {
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
      cfg("doc_a8", "parent", { directlyAssignable: [{ type: "doc_a8" }] }),
      cfg("doc_a8", "viewer", {
        directlyAssignable: [{ type: "user_a8" }],
        tupleToUserset: [{ tupleset: "parent", computedUserset: "viewer" }],
      }),
      cfg("group_a8", "member", {
        directlyAssignable: [
          { type: "user_a8" },
          { type: "group_a8", relation: "member" },
        ],
      }),
      cfg("adoc_a8", "bparent", { directlyAssignable: [{ type: "bdoc_a8" }] }),
      cfg("adoc_a8", "viewer", {
        directlyAssignable: [{ type: "user_a8" }],
        tupleToUserset: [{ tupleset: "bparent", computedUserset: "viewer" }],
      }),
      cfg("bdoc_a8", "aparent", { directlyAssignable: [{ type: "adoc_a8" }] }),
      cfg("bdoc_a8", "viewer", {
        directlyAssignable: [{ type: "user_a8" }],
        tupleToUserset: [{ tupleset: "aparent", computedUserset: "viewer" }],
      }),
      cfg("ddoc_a8", "parent", { directlyAssignable: [{ type: "ddoc_a8" }] }),
      cfg("ddoc_a8", "shortcut", { directlyAssignable: [{ type: "ddoc_a8" }] }),
      cfg("ddoc_a8", "viewer", {
        directlyAssignable: [{ type: "user_a8" }],
        tupleToUserset: [
          { tupleset: "parent", computedUserset: "viewer" },
          { tupleset: "shortcut", computedUserset: "viewer" },
        ],
      }),
      cfg("mgroup_a8", "member", { directlyAssignable: [{ type: "user_a8" }] }),
      cfg("mdoc_a8", "parent", { directlyAssignable: [{ type: "mdoc_a8" }] }),
      cfg("mdoc_a8", "viewer", {
        directlyAssignable: [
          { type: "user_a8" },
          { type: "mgroup_a8", relation: "member" },
        ],
        tupleToUserset: [{ tupleset: "parent", computedUserset: "viewer" }],
      }),
      cfg("ndoc_a8", "parent", { directlyAssignable: [{ type: "ndoc_a8" }] }),
      cfg("ndoc_a8", "owner", { directlyAssignable: [{ type: "user_a8" }] }),
      cfg("ndoc_a8", "viewer", {
        directlyAssignable: [{ type: "user_a8" }],
        impliedBy: ["owner"],
        tupleToUserset: [{ tupleset: "parent", computedUserset: "viewer" }],
      }),
      cfg("ogroup_a8", "admin", { directlyAssignable: [{ type: "user_a8" }] }),
      cfg("ogroup_a8", "member", {
        directlyAssignable: [
          { type: "user_a8" },
          { type: "ogroup_a8", relation: "member" },
        ],
        impliedBy: ["admin"],
      }),
      cfg("ldoc_a8", "r0", { directlyAssignable: [{ type: "user_a8" }] }),
    ];
    for (let i = 1; i <= LADDER; i++) {
      configs.push(cfg("ldoc_a8", `r${i}`, { computedUserset: `r${i - 1}` }));
    }
    for (const c of configs) await tsfgaClient.writeRelationConfig(c);

    const rows: AddTupleRequest[] = [];

    /** A `type`-chain of `N` hops with the grant at the far end. */
    const ttuChain = (type: string, tupleset: string) => {
      for (let i = 0; i < N; i++) {
        rows.push({
          objectType: type,
          objectId: id(i),
          relation: tupleset,
          subjectType: type,
          subjectId: id(i + 1),
        });
      }
    };

    ttuChain("doc_a8", "parent");
    rows.push({
      objectType: "doc_a8",
      objectId: id(N),
      relation: "viewer",
      subjectType: "user_a8",
      subjectId: ALICE,
    });

    for (const type of ["group_a8", "ogroup_a8"]) {
      for (let i = 0; i < N; i++) {
        rows.push({
          objectType: type,
          objectId: id(i),
          relation: "member",
          subjectType: type,
          subjectId: id(i + 1),
          subjectRelation: "member",
        });
      }
      rows.push({
        objectType: type,
        objectId: id(N),
        relation: "member",
        subjectType: "user_a8",
        subjectId: ALICE,
      });
    }

    // Mutual recursion: even ids are adoc, odd ids are bdoc.
    for (let i = 0; i < N; i++) {
      const even = i % 2 === 0;
      rows.push({
        objectType: even ? "adoc_a8" : "bdoc_a8",
        objectId: id(i),
        relation: even ? "bparent" : "aparent",
        subjectType: even ? "bdoc_a8" : "adoc_a8",
        subjectId: id(i + 1),
      });
    }
    rows.push({
      objectType: N % 2 === 0 ? "adoc_a8" : "bdoc_a8",
      objectId: id(N),
      relation: "viewer",
      subjectType: "user_a8",
      subjectId: ALICE,
    });

    ttuChain("mdoc_a8", "parent");
    rows.push({
      objectType: "mdoc_a8",
      objectId: id(N),
      relation: "viewer",
      subjectType: "mgroup_a8",
      subjectId: id(700),
      subjectRelation: "member",
    });
    rows.push({
      objectType: "mgroup_a8",
      objectId: id(700),
      relation: "member",
      subjectType: "user_a8",
      subjectId: ALICE,
    });

    ttuChain("ndoc_a8", "parent");
    rows.push({
      objectType: "ndoc_a8",
      objectId: id(N),
      relation: "viewer",
      subjectType: "user_a8",
      subjectId: ALICE,
    });

    // Diamond: a 41-hop parent path and a 2-hop shortcut path to
    // one leaf. The long path is past both budgets; the short one
    // is not.
    for (let i = 0; i < 40; i++) {
      rows.push({
        objectType: "ddoc_a8",
        objectId: id(i),
        relation: "parent",
        subjectType: "ddoc_a8",
        subjectId: id(i + 1),
      });
    }
    rows.push({
      objectType: "ddoc_a8",
      objectId: id(40),
      relation: "parent",
      subjectType: "ddoc_a8",
      subjectId: id(500),
    });
    rows.push({
      objectType: "ddoc_a8",
      objectId: id(0),
      relation: "shortcut",
      subjectType: "ddoc_a8",
      subjectId: id(501),
    });
    rows.push({
      objectType: "ddoc_a8",
      objectId: id(501),
      relation: "shortcut",
      subjectType: "ddoc_a8",
      subjectId: id(500),
    });
    rows.push({
      objectType: "ddoc_a8",
      objectId: id(500),
      relation: "viewer",
      subjectType: "user_a8",
      subjectId: ALICE,
    });

    rows.push({
      objectType: "ldoc_a8",
      objectId: id(600),
      relation: "r0",
      subjectType: "user_a8",
      subjectId: ALICE,
    });

    for (const row of rows) await tsfgaClient.addTuple(row);

    storeId = await fgaCreateStore("recursion-depth-boundary-conformance");
    modelId = await fgaWriteModel(
      storeId,
      "./recursion-depth-boundary/model.dsl",
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

  /** The check `hops` hops from the far end of a chain. */
  const at = (objectType: string, relation: string, hops: number) => ({
    objectType,
    objectId: id(N - hops),
    relation,
    subjectType: "user_a8",
    subjectId: ALICE,
  });

  const agree = (
    params: Parameters<typeof expectConformance>[3],
    e: boolean | "refused",
  ) => expectConformance(storeId, modelId, tsfgaClient, params, e);

  const diverge = (
    params: Parameters<typeof expectConformance>[3],
    openfga: boolean | "refused",
    tsfga: boolean | "refused",
  ) =>
    expectPinnedDivergence(storeId, modelId, tsfgaClient, params, {
      openfga,
      tsfga,
    });

  describe("TTU recursion", () => {
    test("one hop", () => agree(at("doc_a8", "viewer", 1), true));
    test("ten hops", () => agree(at("doc_a8", "viewer", 10), true));
    test("inside both budgets at 24", () =>
      agree(at("doc_a8", "viewer", 24), true));
    test("at 25 the documented offset shows", () =>
      diverge(at("doc_a8", "viewer", 25), true, "refused"));
    test("at 26 both refuse", () =>
      agree(at("doc_a8", "viewer", 26), "refused"));
    test("at 50 both refuse", () =>
      agree(at("doc_a8", "viewer", 50), "refused"));
    test("at 100 both refuse", () =>
      agree(at("doc_a8", "viewer", 100), "refused"));
  });

  describe("userset recursion", () => {
    test("inside both budgets at 24", () =>
      agree(at("group_a8", "member", 24), true));
    test("at 25 the same offset shows", () =>
      diverge(at("group_a8", "member", 25), true, "refused"));
    test("at 26 both refuse", () =>
      agree(at("group_a8", "member", 26), "refused"));
  });

  describe("userset recursion with an extra rewrite arm", () => {
    test("inside both budgets at 24", () =>
      agree(at("ogroup_a8", "member", 24), true));
    test("at 25 the offset survives the extra arm", () =>
      diverge(at("ogroup_a8", "member", 25), true, "refused"));
    test("at 26 both refuse", () =>
      agree(at("ogroup_a8", "member", 26), "refused"));
  });

  describe("TTU recursion with an extra rewrite arm", () => {
    test("inside both budgets at 24", () =>
      agree(at("ndoc_a8", "viewer", 24), true));
    test("at 25 the offset survives the extra arm", () =>
      diverge(at("ndoc_a8", "viewer", 25), true, "refused"));
    test("at 26 both refuse", () =>
      agree(at("ndoc_a8", "viewer", 26), "refused"));
  });

  describe("mutual recursion across two types", () => {
    test("inside both budgets at 24", () =>
      agree(at("adoc_a8", "viewer", 24), true));
    // No offset: upstream has no resolver for a relation that
    // recurses through another type, so it dispatches for the
    // terminal hop exactly as tsfga does.
    test("at 25 both refuse — no offset here", () =>
      agree(at("bdoc_a8", "viewer", 25), "refused"));
    test("at 26 both refuse", () =>
      agree(at("adoc_a8", "viewer", 26), "refused"));
  });

  describe("TTU chain ending in a userset hop", () => {
    test("23 TTU hops plus the userset hop, both answer", () =>
      agree(at("mdoc_a8", "viewer", 23), true));
    // 24 TTU hops + 1 userset hop is 25 dispatches on both sides.
    test("24 TTU hops plus the userset hop, both refuse", () =>
      agree(at("mdoc_a8", "viewer", 24), "refused"));
  });

  test("a short path saves a diamond whose long path is past the budget", () =>
    agree(
      {
        objectType: "ddoc_a8",
        objectId: id(0),
        relation: "viewer",
        subjectType: "user_a8",
        subjectId: ALICE,
      },
      true,
    ));

  describe("a rewrite ladder costs no depth", () => {
    for (const level of [1, 24, 25, 26, LADDER]) {
      test(`r${level}`, () =>
        agree(
          {
            objectType: "ldoc_a8",
            objectId: id(600),
            relation: `r${level}`,
            subjectType: "user_a8",
            subjectId: ALICE,
          },
          true,
        ));
    }
  });

  test("the relation configs say what the model says", () => {
    expectConfigsMatchModel("./recursion-depth-boundary/model.dsl", fixture, {
      coverage: "complete",
    });
  });
});
