import { afterAll, beforeAll, describe, test } from "bun:test";
import {
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
  fgaWriteTuples,
} from "./helpers/openfga.ts";

/**
 * OpenFGA's DSL is a free algebra: `or`, `and` and `but not` over
 * arbitrary parenthesised sub-expressions. tsfga's `RelationConfig`
 * is a fixed record — one `excludedBy`, one flat `intersection`, a
 * union assembled from `impliedBy` / `computedUserset` /
 * `tupleToUserset` / direct assignment. Every shape the algebra
 * nests but the record cannot must be decomposed onto a helper
 * relation, and a decomposition that changes an answer is a bug.
 *
 * This fixture writes one relation per nesting shape and runs the
 * full a/b/c truth table through each, so a decomposition that is
 * off by one cell fails on that cell rather than on a summary.
 */

const uuidMap = new Map<string, string>([
  ["un", "00000000-0000-4000-d460-000000000001"],
  ["ua", "00000000-0000-4000-d460-000000000002"],
  ["ub", "00000000-0000-4000-d460-000000000003"],
  ["uc", "00000000-0000-4000-d460-000000000004"],
  ["uab", "00000000-0000-4000-d460-000000000005"],
  ["uac", "00000000-0000-4000-d460-000000000006"],
  ["ubc", "00000000-0000-4000-d460-000000000007"],
  ["uabc", "00000000-0000-4000-d460-000000000008"],
  ["ufv", "00000000-0000-4000-d460-000000000009"],
  ["ufe", "00000000-0000-4000-d460-00000000000a"],
  ["ud", "00000000-0000-4000-d460-00000000000b"],
  ["ugm", "00000000-0000-4000-d460-00000000000c"],
  ["uw", "00000000-0000-4000-d460-00000000000d"],
  ["doc1", "00000000-0000-4000-d460-000000000011"],
  ["doc2", "00000000-0000-4000-d460-000000000012"],
  ["doc3", "00000000-0000-4000-d460-000000000013"],
  ["folder1", "00000000-0000-4000-d460-000000000021"],
  ["group1", "00000000-0000-4000-d460-000000000031"],
]);

function uuid(name: string): string {
  const id = uuidMap.get(name);
  if (!id) throw new Error(`No UUID for ${name}`);
  return id;
}

/** A config with every optional arm off, so each test names only what it uses. */
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

/** The eight users of doc1's a/b/c truth table, in table order. */
const ABC_USERS = [
  "un",
  "ua",
  "ub",
  "uc",
  "uab",
  "uac",
  "ubc",
  "uabc",
] as const;

/**
 * `relation -> its column of the truth table`, one character per
 * user of `ABC_USERS`.
 */
const ABC_MATRIX: ReadonlyArray<readonly [string, string]> = [
  // a or b or viewer from parent or (c and a)
  ["u_mixed", "01101111"],
  // a and b and c
  ["i3", "00000001"],
  // (a or b) and c
  ["i_union", "00000111"],
  // a and (b or c)
  ["i_union2", "00001101"],
  // a but not (b or c)
  ["e_union", "01000000"],
  // a but not (b and c)
  ["e_inter", "01001100"],
  // (a or b) but not c
  ["e_union_base", "01101000"],
  // (a but not b) and c
  ["e_in_i", "00000100"],
  // (a and b) but not c
  ["i_in_e", "00001000"],
  // c or (a but not b) — an exclusion as a union arm
  ["u_excl", "01010111"],
];

describe("Nested DSL algebra conformance", () => {
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

    await tsfgaClient.writeConditionDefinition({
      name: "weekday_only_a7",
      expression: 'day == "monday"',
      parameters: { day: "string" },
    });

    await tsfgaClient.writeRelationConfig(
      config("group_a7", "member", {
        directlyAssignable: [{ type: "user_a7" }],
      }),
    );
    await tsfgaClient.writeRelationConfig(
      config("folder_a7", "viewer", {
        directlyAssignable: [{ type: "user_a7" }],
      }),
    );
    await tsfgaClient.writeRelationConfig(
      config("folder_a7", "editor", {
        directlyAssignable: [{ type: "user_a7" }],
      }),
    );
    // `viewer or editor` — a plain union of two computed arms.
    await tsfgaClient.writeRelationConfig(
      config("folder_a7", "reader", { impliedBy: ["viewer", "editor"] }),
    );

    await tsfgaClient.writeRelationConfig(
      config("doc_a7", "parent", {
        directlyAssignable: [{ type: "folder_a7" }],
      }),
    );
    for (const relation of ["a", "b", "c"]) {
      await tsfgaClient.writeRelationConfig(
        config("doc_a7", relation, {
          directlyAssignable: [{ type: "user_a7" }],
        }),
      );
    }

    // Helper relations: the sub-expressions the record has no slot
    // for. Each exists only in tsfga and is declared as such below.
    await tsfgaClient.writeRelationConfig(
      config("doc_a7", "h_c_and_a", {
        intersection: [
          { type: "computedUserset", relation: "c" },
          { type: "computedUserset", relation: "a" },
        ],
      }),
    );
    await tsfgaClient.writeRelationConfig(
      config("doc_a7", "h_a_or_b", { impliedBy: ["a", "b"] }),
    );
    await tsfgaClient.writeRelationConfig(
      config("doc_a7", "h_b_or_c", { impliedBy: ["b", "c"] }),
    );
    await tsfgaClient.writeRelationConfig(
      config("doc_a7", "h_b_and_c", {
        intersection: [
          { type: "computedUserset", relation: "b" },
          { type: "computedUserset", relation: "c" },
        ],
      }),
    );
    await tsfgaClient.writeRelationConfig(
      config("doc_a7", "h_a_not_b", { impliedBy: ["a"], excludedBy: "b" }),
    );

    // a or b or viewer from parent or (c and a)
    await tsfgaClient.writeRelationConfig(
      config("doc_a7", "u_mixed", {
        impliedBy: ["a", "b", "h_c_and_a"],
        tupleToUserset: [{ tupleset: "parent", computedUserset: "viewer" }],
      }),
    );
    // a and b and c
    await tsfgaClient.writeRelationConfig(
      config("doc_a7", "i3", {
        intersection: [
          { type: "computedUserset", relation: "a" },
          { type: "computedUserset", relation: "b" },
          { type: "computedUserset", relation: "c" },
        ],
      }),
    );
    // (a or b) and c
    await tsfgaClient.writeRelationConfig(
      config("doc_a7", "i_union", {
        intersection: [
          { type: "computedUserset", relation: "h_a_or_b" },
          { type: "computedUserset", relation: "c" },
        ],
      }),
    );
    // a and (b or c)
    await tsfgaClient.writeRelationConfig(
      config("doc_a7", "i_union2", {
        intersection: [
          { type: "computedUserset", relation: "a" },
          { type: "computedUserset", relation: "h_b_or_c" },
        ],
      }),
    );
    // a but not (b or c)
    await tsfgaClient.writeRelationConfig(
      config("doc_a7", "e_union", {
        impliedBy: ["a"],
        excludedBy: "h_b_or_c",
      }),
    );
    // a but not (b and c)
    await tsfgaClient.writeRelationConfig(
      config("doc_a7", "e_inter", {
        impliedBy: ["a"],
        excludedBy: "h_b_and_c",
      }),
    );
    // (a or b) but not c
    await tsfgaClient.writeRelationConfig(
      config("doc_a7", "e_union_base", {
        impliedBy: ["a", "b"],
        excludedBy: "c",
      }),
    );
    // (a but not b) and c
    await tsfgaClient.writeRelationConfig(
      config("doc_a7", "e_in_i", {
        intersection: [
          { type: "computedUserset", relation: "h_a_not_b" },
          { type: "computedUserset", relation: "c" },
        ],
      }),
    );
    // (a and b) but not c
    await tsfgaClient.writeRelationConfig(
      config("doc_a7", "i_in_e", {
        intersection: [
          { type: "computedUserset", relation: "a" },
          { type: "computedUserset", relation: "b" },
        ],
        excludedBy: "c",
      }),
    );
    // c or (a but not b)
    await tsfgaClient.writeRelationConfig(
      config("doc_a7", "u_excl", { impliedBy: ["c", "h_a_not_b"] }),
    );
    // reader from parent — a TTU whose computed relation is a union
    await tsfgaClient.writeRelationConfig(
      config("doc_a7", "ttu_union", {
        tupleToUserset: [{ tupleset: "parent", computedUserset: "reader" }],
      }),
    );
    // [user_a7] or a
    await tsfgaClient.writeRelationConfig(
      config("doc_a7", "direct_or", {
        directlyAssignable: [{ type: "user_a7" }],
        impliedBy: ["a"],
      }),
    );
    // [user_a7] and viewer from parent
    await tsfgaClient.writeRelationConfig(
      config("doc_a7", "direct_and", {
        directlyAssignable: [{ type: "user_a7" }],
        intersection: [
          { type: "direct" },
          {
            type: "tupleToUserset",
            tupleset: "parent",
            computedUserset: "viewer",
          },
        ],
      }),
    );
    // [user_a7] but not b
    await tsfgaClient.writeRelationConfig(
      config("doc_a7", "direct_not", {
        directlyAssignable: [{ type: "user_a7" }],
        excludedBy: "b",
      }),
    );
    // every restriction shape on one relation
    await tsfgaClient.writeRelationConfig(
      config("doc_a7", "all_refs", {
        directlyAssignable: [
          { type: "user_a7" },
          { type: "user_a7", wildcard: true },
          { type: "group_a7", relation: "member" },
          { type: "user_a7", condition: "weekday_only_a7" },
        ],
      }),
    );

    const add = (
      objectType: string,
      objectId: string,
      relation: string,
      subjectType: string,
      subjectId: string,
      subjectRelation?: string,
      conditionName?: string,
    ) =>
      tsfgaClient.addTuple({
        objectType,
        objectId,
        relation,
        subjectType,
        subjectId,
        subjectRelation: subjectRelation ?? null,
        conditionName: conditionName ?? null,
      });

    for (const [relation, holders] of [
      ["a", ["ua", "uab", "uac", "uabc"]],
      ["b", ["ub", "uab", "ubc", "uabc"]],
      ["c", ["uc", "uac", "ubc", "uabc"]],
    ] as const) {
      for (const holder of holders) {
        await add("doc_a7", uuid("doc1"), relation, "user_a7", uuid(holder));
      }
    }

    await add("doc_a7", uuid("doc1"), "parent", "folder_a7", uuid("folder1"));
    await add("folder_a7", uuid("folder1"), "viewer", "user_a7", uuid("ufv"));
    await add("folder_a7", uuid("folder1"), "editor", "user_a7", uuid("ufe"));

    await add("doc_a7", uuid("doc1"), "direct_or", "user_a7", uuid("ud"));
    await add("doc_a7", uuid("doc1"), "direct_and", "user_a7", uuid("ud"));
    await add("doc_a7", uuid("doc1"), "direct_and", "user_a7", uuid("ufv"));
    await add("doc_a7", uuid("doc1"), "direct_not", "user_a7", uuid("ud"));
    await add("doc_a7", uuid("doc1"), "direct_not", "user_a7", uuid("ub"));

    await add("group_a7", uuid("group1"), "member", "user_a7", uuid("ugm"));
    await add("doc_a7", uuid("doc2"), "all_refs", "user_a7", uuid("ud"));
    await add(
      "doc_a7",
      uuid("doc2"),
      "all_refs",
      "group_a7",
      uuid("group1"),
      "member",
    );
    await add(
      "doc_a7",
      uuid("doc2"),
      "all_refs",
      "user_a7",
      uuid("uw"),
      undefined,
      "weekday_only_a7",
    );
    await add("doc_a7", uuid("doc3"), "all_refs", "user_a7", "*");

    storeId = await fgaCreateStore("nested-algebra");
    authorizationModelId = await fgaWriteModel(
      storeId,
      "./nested-algebra/model.dsl",
    );
    await fgaWriteTuples(
      storeId,
      "./nested-algebra/tuples.yaml",
      authorizationModelId,
      uuidMap,
    );
  });

  afterAll(async () => {
    await rollbackTransaction(db);
    await destroyDb();
  });

  /** One check on doc1 for `user`, both engines. */
  function checkDoc(
    doc: string,
    relation: string,
    user: string,
    expected: boolean,
    context?: Record<string, unknown>,
  ): Promise<void> {
    return expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "doc_a7",
        objectId: uuid(doc),
        relation,
        subjectType: "user_a7",
        subjectId: uuid(user),
        context,
      },
      expected,
    );
  }

  for (const [relation, column] of ABC_MATRIX) {
    for (const [index, user] of ABC_USERS.entries()) {
      const expected = column[index] === "1";
      test(`${relation}: ${user} is ${expected}`, async () => {
        await checkDoc("doc1", relation, user, expected);
      });
    }
  }

  // The union arm that reaches another object: u_mixed's
  // `viewer from parent`.
  test("u_mixed: the TTU arm grants (ufv)", async () => {
    await checkDoc("doc1", "u_mixed", "ufv", true);
  });
  test("u_mixed: a folder editor is not a folder viewer (ufe)", async () => {
    await checkDoc("doc1", "u_mixed", "ufe", false);
  });

  // A union arm that is itself a TTU whose computed relation is a
  // union.
  test("ttu_union: folder viewer reaches it", async () => {
    await checkDoc("doc1", "ttu_union", "ufv", true);
  });
  test("ttu_union: folder editor reaches it", async () => {
    await checkDoc("doc1", "ttu_union", "ufe", true);
  });
  test("ttu_union: an unrelated user does not", async () => {
    await checkDoc("doc1", "ttu_union", "un", false);
  });

  // Direct assignment combined with each operator.
  test("direct_or: the direct assignee", async () => {
    await checkDoc("doc1", "direct_or", "ud", true);
  });
  test("direct_or: the computed arm", async () => {
    await checkDoc("doc1", "direct_or", "ua", true);
  });
  test("direct_or: neither", async () => {
    await checkDoc("doc1", "direct_or", "ub", false);
  });
  test("direct_and: direct only is not enough", async () => {
    await checkDoc("doc1", "direct_and", "ud", false);
  });
  test("direct_and: direct plus the TTU operand", async () => {
    await checkDoc("doc1", "direct_and", "ufv", true);
  });
  test("direct_and: the TTU operand alone is not enough", async () => {
    await checkDoc("doc1", "direct_and", "ufe", false);
  });
  test("direct_not: direct and not excluded", async () => {
    await checkDoc("doc1", "direct_not", "ud", true);
  });
  test("direct_not: direct but excluded", async () => {
    await checkDoc("doc1", "direct_not", "ub", false);
  });
  test("direct_not: not assigned at all", async () => {
    await checkDoc("doc1", "direct_not", "ua", false);
  });

  // [user, user:*, group#member, user with cond] on one relation.
  test("all_refs: the bare direct assignee", async () => {
    await checkDoc("doc2", "all_refs", "ud", true);
  });
  test("all_refs: through the userset ref", async () => {
    await checkDoc("doc2", "all_refs", "ugm", true);
  });
  test("all_refs: the conditioned ref, condition true", async () => {
    await checkDoc("doc2", "all_refs", "uw", true, { day: "monday" });
  });
  test("all_refs: the conditioned ref, condition false", async () => {
    await checkDoc("doc2", "all_refs", "uw", false, { day: "tuesday" });
  });
  test("all_refs: nobody else on doc2", async () => {
    await checkDoc("doc2", "all_refs", "un", false, { day: "monday" });
  });
  test("all_refs: the wildcard ref on doc3", async () => {
    await checkDoc("doc3", "all_refs", "un", true, { day: "monday" });
  });

  // A decomposition adds relations to the object type, so the
  // candidate pool a listObjects walks is a different set than the
  // model's. It must still reach the same objects.
  function listObjects(
    relation: string,
    user: string,
    expected: readonly string[],
    context?: Record<string, unknown>,
  ): Promise<void> {
    return expectListObjectsConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "doc_a7",
        relation,
        subjectType: "user_a7",
        subjectId: uuid(user),
        context,
      },
      expected,
    );
  }

  test("listObjects over an intersection inside an exclusion", async () => {
    await listObjects("i_in_e", "uab", [uuid("doc1")]);
  });
  test("listObjects over an exclusion inside an intersection", async () => {
    await listObjects("e_in_i", "uac", [uuid("doc1")]);
  });
  test("listObjects over a union of mixed kinds", async () => {
    await listObjects("u_mixed", "ufv", [uuid("doc1")]);
  });
  test("listObjects finds nobody where the decomposition denies", async () => {
    await listObjects("i_in_e", "uabc", []);
  });
  test("listObjects over every restriction shape", async () => {
    await listObjects("all_refs", "un", [uuid("doc3")], { day: "monday" });
  });

  test("the relation configs say what the model says", () => {
    expectConfigsMatchModel("./nested-algebra/model.dsl", fixture, {
      coverage: "complete",
      tsfgaOnlyHelpers: [
        "doc_a7.h_c_and_a",
        "doc_a7.h_a_or_b",
        "doc_a7.h_b_or_c",
        "doc_a7.h_b_and_c",
        "doc_a7.h_a_not_b",
      ],
    });
  });
});
