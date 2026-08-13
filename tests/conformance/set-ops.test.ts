import { afterAll, beforeAll, describe, test } from "bun:test";
import {
  type CheckRequest,
  createTsfga,
  type RelationConfig,
  type TsfgaClient,
} from "@tsfga/core";
import type { DB } from "@tsfga/kysely";
import { KyselyTupleStore } from "@tsfga/kysely";
import type { Kysely } from "kysely";
import {
  type CheckOutcome,
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
  fgaWriteTuples,
} from "./helpers/openfga.ts";

// A battery over the set operators: three-operand intersection,
// nested exclusion, exclusion whose subtrahend is a TTU, an
// intersection of two TTUs, intersection combined with exclusion in
// one relation, an exclusion as one arm of a union, wildcards on
// both sides of an exclusion, and cycles reaching an exclusion's
// subtrahend and an intersection operand.

const uuidMap = new Map<string, string>();
const names = [
  "alice",
  "bob",
  "t1",
  "t2",
  "tb",
  "g1",
  "g2",
  "p1",
  "p2",
  "fp",
  "fq",
  "fr",
  "x1",
  "x2",
  "x3",
  "x5",
  "x6",
  "x7",
  "x8",
  "x10",
  "x11",
  "x12",
  "x13",
];
for (const [i, name] of names.entries()) {
  uuidMap.set(
    name,
    `00000000-0000-4000-d400-0000000003${String(i).padStart(2, "0")}`,
  );
}

function uuid(name: string): string {
  const id = uuidMap.get(name);
  if (!id) throw new Error(`No UUID for ${name}`);
  return id;
}

const EMPTY = {
  directlyAssignable: [],
  impliedBy: null,
  computedUserset: null,
  tupleToUserset: null,
  excludedBy: null,
  intersection: null,
} satisfies Omit<RelationConfig, "objectType" | "relation">;

describe("a1: set operators", () => {
  let db: Kysely<DB>;
  let storeId: string;
  let authorizationModelId: string;
  let tsfgaClient: TsfgaClient;
  let fixture: FixtureRecord;

  async function check(
    request: CheckRequest,
    expected: CheckOutcome,
  ): Promise<void> {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      request,
      expected,
    );
  }

  function on(object: string, relation: string, subject: string): CheckRequest {
    return {
      objectType: "doc_a1",
      objectId: uuid(object),
      relation,
      subjectType: "user_a1",
      subjectId: uuid(subject),
    };
  }

  beforeAll(async () => {
    db = getDb();
    await beginTransaction(db);

    tsfgaClient = createTsfga(new KyselyTupleStore(db));
    fixture = recordFixture(tsfgaClient);

    const configs: RelationConfig[] = [
      {
        ...EMPTY,
        objectType: "team_a1",
        relation: "member",
        directlyAssignable: [
          { type: "user_a1" },
          { type: "user_a1", wildcard: true },
          { type: "team_a1", relation: "member" },
        ],
      },
      {
        ...EMPTY,
        objectType: "group_a1",
        relation: "member",
        directlyAssignable: [
          { type: "user_a1" },
          { type: "group_a1", relation: "member" },
        ],
      },
      {
        ...EMPTY,
        objectType: "pair_a1",
        relation: "member",
        directlyAssignable: [
          { type: "user_a1" },
          { type: "pair_a1", relation: "owner" },
        ],
      },
      {
        ...EMPTY,
        objectType: "pair_a1",
        relation: "owner",
        directlyAssignable: [
          { type: "user_a1" },
          { type: "pair_a1", relation: "member" },
        ],
      },
      {
        ...EMPTY,
        objectType: "folder_a1",
        relation: "viewer",
        directlyAssignable: [
          { type: "user_a1" },
          { type: "user_a1", wildcard: true },
        ],
      },
      {
        ...EMPTY,
        objectType: "folder_a1",
        relation: "blocked",
        directlyAssignable: [
          { type: "user_a1" },
          { type: "user_a1", wildcard: true },
        ],
      },
      {
        ...EMPTY,
        objectType: "doc_a1",
        relation: "parent",
        directlyAssignable: [{ type: "folder_a1" }],
      },
      {
        ...EMPTY,
        objectType: "doc_a1",
        relation: "owner",
        directlyAssignable: [{ type: "team_a1" }],
      },
      {
        ...EMPTY,
        objectType: "doc_a1",
        relation: "a",
        directlyAssignable: [{ type: "user_a1" }],
      },
      {
        ...EMPTY,
        objectType: "doc_a1",
        relation: "b",
        directlyAssignable: [{ type: "user_a1" }],
      },
      {
        ...EMPTY,
        objectType: "doc_a1",
        relation: "c",
        directlyAssignable: [{ type: "user_a1" }],
      },
      {
        ...EMPTY,
        objectType: "doc_a1",
        relation: "cyc",
        directlyAssignable: [{ type: "group_a1", relation: "member" }],
      },
      {
        ...EMPTY,
        objectType: "doc_a1",
        relation: "cyc2",
        directlyAssignable: [{ type: "pair_a1", relation: "member" }],
      },
      {
        ...EMPTY,
        objectType: "doc_a1",
        relation: "wild_blocked",
        directlyAssignable: [{ type: "user_a1", wildcard: true }],
      },
      {
        ...EMPTY,
        objectType: "doc_a1",
        relation: "three_way",
        intersection: [
          { type: "computedUserset", relation: "a" },
          { type: "computedUserset", relation: "b" },
          { type: "computedUserset", relation: "c" },
        ],
      },
      {
        ...EMPTY,
        objectType: "doc_a1",
        relation: "sub_of_sub",
        computedUserset: "b",
        excludedBy: "c",
      },
      {
        ...EMPTY,
        objectType: "doc_a1",
        relation: "nested_sub",
        computedUserset: "a",
        excludedBy: "sub_of_sub",
      },
      // tsfga's `excludedBy` names a relation, so the DSL's
      // `but not blocked from parent` is decomposed onto a helper.
      {
        ...EMPTY,
        objectType: "doc_a1",
        relation: "blocked_from_parent",
        tupleToUserset: [{ tupleset: "parent", computedUserset: "blocked" }],
      },
      {
        ...EMPTY,
        objectType: "doc_a1",
        relation: "ttu_sub",
        computedUserset: "a",
        excludedBy: "blocked_from_parent",
      },
      {
        ...EMPTY,
        objectType: "doc_a1",
        relation: "int_ttu",
        intersection: [
          {
            type: "tupleToUserset",
            tupleset: "parent",
            computedUserset: "viewer",
          },
          {
            type: "tupleToUserset",
            tupleset: "owner",
            computedUserset: "member",
          },
        ],
      },
      {
        ...EMPTY,
        objectType: "doc_a1",
        relation: "int_and_excl",
        intersection: [
          { type: "computedUserset", relation: "a" },
          { type: "computedUserset", relation: "b" },
        ],
        excludedBy: "c",
      },
      {
        ...EMPTY,
        objectType: "doc_a1",
        relation: "union_with_excl",
        impliedBy: ["a", "sub_of_sub"],
      },
      {
        ...EMPTY,
        objectType: "doc_a1",
        relation: "wide",
        impliedBy: ["a", "b", "c", "sub_of_sub"],
      },
      {
        ...EMPTY,
        objectType: "doc_a1",
        relation: "cyc_excluded",
        computedUserset: "a",
        excludedBy: "cyc",
      },
      {
        ...EMPTY,
        objectType: "doc_a1",
        relation: "cyc_int",
        intersection: [
          { type: "computedUserset", relation: "a" },
          { type: "computedUserset", relation: "cyc" },
        ],
      },
      {
        ...EMPTY,
        objectType: "doc_a1",
        relation: "cyc2_excluded",
        computedUserset: "a",
        excludedBy: "cyc2",
      },
      {
        ...EMPTY,
        objectType: "doc_a1",
        relation: "cyc2_int",
        intersection: [
          { type: "computedUserset", relation: "a" },
          { type: "computedUserset", relation: "cyc2" },
        ],
      },
      {
        ...EMPTY,
        objectType: "doc_a1",
        relation: "wild_excluded",
        computedUserset: "a",
        excludedBy: "wild_blocked",
      },
    ];
    for (const config of configs) {
      await tsfgaClient.writeRelationConfig(config);
    }

    const tuples = [
      ["team_a1", "t1", "member", "team_a1", "t2", "member"],
      ["team_a1", "t2", "member", "user_a1", "*", null],
      ["team_a1", "tb", "member", "user_a1", "alice", null],
      ["group_a1", "g1", "member", "group_a1", "g2", "member"],
      ["group_a1", "g2", "member", "group_a1", "g1", "member"],
      ["pair_a1", "p1", "member", "pair_a1", "p2", "owner"],
      ["pair_a1", "p2", "owner", "pair_a1", "p1", "member"],
      ["folder_a1", "fp", "viewer", "user_a1", "*", null],
      ["folder_a1", "fq", "blocked", "user_a1", "*", null],
      ["folder_a1", "fr", "viewer", "user_a1", "alice", null],
      ["doc_a1", "x1", "a", "user_a1", "alice", null],
      ["doc_a1", "x1", "b", "user_a1", "alice", null],
      ["doc_a1", "x1", "c", "user_a1", "alice", null],
      ["doc_a1", "x2", "a", "user_a1", "alice", null],
      ["doc_a1", "x2", "b", "user_a1", "alice", null],
      ["doc_a1", "x3", "a", "user_a1", "alice", null],
      ["doc_a1", "x3", "b", "user_a1", "alice", null],
      ["doc_a1", "x3", "c", "user_a1", "alice", null],
      ["doc_a1", "x5", "a", "user_a1", "alice", null],
      ["doc_a1", "x5", "parent", "folder_a1", "fq", null],
      ["doc_a1", "x6", "a", "user_a1", "alice", null],
      ["doc_a1", "x6", "parent", "folder_a1", "fr", null],
      ["doc_a1", "x7", "parent", "folder_a1", "fr", null],
      ["doc_a1", "x7", "owner", "team_a1", "t1", null],
      ["doc_a1", "x8", "parent", "folder_a1", "fp", null],
      ["doc_a1", "x8", "owner", "team_a1", "tb", null],
      ["doc_a1", "x10", "a", "user_a1", "alice", null],
      ["doc_a1", "x10", "cyc", "group_a1", "g1", "member"],
      ["doc_a1", "x10", "cyc2", "pair_a1", "p1", "member"],
      ["doc_a1", "x11", "a", "user_a1", "alice", null],
      ["doc_a1", "x11", "wild_blocked", "user_a1", "*", null],
      ["doc_a1", "x12", "b", "user_a1", "alice", null],
      ["doc_a1", "x13", "c", "user_a1", "alice", null],
    ] as const;
    for (const [
      objectType,
      object,
      relation,
      subjectType,
      subject,
      subjectRelation,
    ] of tuples) {
      await tsfgaClient.addTuple({
        objectType,
        objectId: uuid(object),
        relation,
        subjectType,
        subjectId: subject === "*" ? "*" : uuid(subject),
        subjectRelation,
      });
    }

    storeId = await fgaCreateStore("set-ops");
    authorizationModelId = await fgaWriteModel(storeId, "./set-ops/model.dsl");
    await fgaWriteTuples(
      storeId,
      "./set-ops/tuples.yaml",
      authorizationModelId,
      uuidMap,
    );
  });

  afterAll(async () => {
    await rollbackTransaction(db);
    await destroyDb();
  });

  test("a three-operand intersection grants only when all hold", async () => {
    await check(on("x1", "three_way", "alice"), true);
    await check(on("x2", "three_way", "alice"), false);
    await check(on("x1", "three_way", "bob"), false);
  });

  test("an exclusion nested inside an exclusion", async () => {
    // x3: b and c both hold, so `b but not c` is false, so
    // `a but not (b but not c)` is a.
    await check(on("x3", "sub_of_sub", "alice"), false);
    await check(on("x3", "nested_sub", "alice"), true);
    // x2: b holds, c does not, so the inner exclusion holds and
    // subtracts the outer base away.
    await check(on("x2", "sub_of_sub", "alice"), true);
    await check(on("x2", "nested_sub", "alice"), false);
    // x12: the outer base is false, so nothing is granted.
    await check(on("x12", "nested_sub", "alice"), false);
  });

  test("an exclusion whose subtrahend is a tuple-to-userset", async () => {
    await check(on("x5", "ttu_sub", "alice"), false);
    await check(on("x6", "ttu_sub", "alice"), true);
  });

  test("an intersection of two tuple-to-usersets", async () => {
    await check(on("x7", "int_ttu", "alice"), true);
    await check(on("x7", "int_ttu", "bob"), false);
    await check(on("x8", "int_ttu", "alice"), true);
    await check(on("x8", "int_ttu", "bob"), false);
  });

  test("intersection and exclusion in one relation", async () => {
    await check(on("x2", "int_and_excl", "alice"), true);
    await check(on("x1", "int_and_excl", "alice"), false);
    await check(on("x12", "int_and_excl", "alice"), false);
  });

  test("an exclusion as one arm of a union", async () => {
    await check(on("x12", "union_with_excl", "alice"), true);
    await check(on("x13", "union_with_excl", "alice"), false);
    await check(on("x13", "wide", "alice"), true);
    await check(on("x12", "wide", "alice"), true);
    await check(on("x2", "wide", "bob"), false);
  });

  test("a wildcard on the subtract side denies everyone", async () => {
    await check(on("x11", "wild_excluded", "alice"), false);
    await check(on("x11", "wild_excluded", "bob"), false);
  });

  test("a wildcard reached through a userset hop", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "team_a1",
        objectId: uuid("t1"),
        relation: "member",
        subjectType: "user_a1",
        subjectId: uuid("bob"),
      },
      true,
    );
  });

  test("a cycle reaching an exclusion's subtrahend denies", async () => {
    await check(on("x10", "cyc2", "alice"), false);
    await check(on("x10", "cyc2_excluded", "alice"), false);
  });

  test("a cycle reaching an intersection operand denies", async () => {
    await check(on("x10", "cyc_int", "alice"), false);
    await check(on("x10", "cyc2_int", "alice"), false);
  });

  // A self-recursive userset (`member: [user, group#member]`) is
  // one of the shapes upstream resolves with its recursive
  // resolver, which walks the reachable set iteratively and so
  // reports a definitive `false` where tsfga reports a cycle. Only
  // the subtract side of a `but not` can tell the two apart. See
  // "Known divergence: recursive relations" in
  // packages/core/README.md.
  test("a self-recursive cycle on the subtract side: pinned", async () => {
    await check(on("x10", "cyc", "alice"), false);
    await expectPinnedDivergence(
      storeId,
      authorizationModelId,
      tsfgaClient,
      on("x10", "cyc_excluded", "alice"),
      { openfga: true, tsfga: false },
    );
  });

  test("the relation configs say what the model says", () => {
    expectConfigsMatchModel("./set-ops/model.dsl", fixture, {
      coverage: "complete",
      tsfgaOnlyHelpers: ["doc_a1.blocked_from_parent"],
    });
  });
});
