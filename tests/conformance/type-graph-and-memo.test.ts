import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  type CheckRequest,
  createTsfga,
  type TsfgaClient,
  TsfgaError,
} from "@tsfga/core";
import type { DB } from "@tsfga/kysely";
import { KyselyTupleStore } from "@tsfga/kysely";
import type { Kysely } from "kysely";
import {
  type CheckOutcome,
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
import { fgaCheck, fgaCreateStore, fgaWriteModel } from "./helpers/openfga.ts";

/**
 * The reachability prune (`type-graph.ts`) and the memo's new
 * subject-relation level (`check.ts`), attacked together.
 *
 * The prune answers `false` before a rewrite is resolved, so every
 * way a subject can legitimately reach a node has to be an edge the
 * backwards walk collects: one arm of a union, a wildcard
 * restriction, a userset restriction, a tuple-to-userset whose
 * tupleset admits several types (one of which does not define the
 * computed relation at all), and a mutually recursive pair that
 * makes the walk truncate against itself.
 *
 * The memo is probed by asking one node about a bare subject and
 * about a userset subject inside a single `checkMany` batch, in
 * both orders: the two share every key level except the new one.
 */

const uuidMap = new Map<string, string>([
  ["alice", "00000000-0000-4000-d4a0-000000000011"],
  ["bob", "00000000-0000-4000-d4a0-000000000012"],
  ["eng", "00000000-0000-4000-d4a0-000000000013"],
  ["big", "00000000-0000-4000-d4a0-000000000014"],
  ["f1", "00000000-0000-4000-d4a0-000000000015"],
  ["f2", "00000000-0000-4000-d4a0-000000000016"],
  ["s1", "00000000-0000-4000-d4a0-000000000017"],
  ["doc1", "00000000-0000-4000-d4a0-000000000021"],
  ["doc2", "00000000-0000-4000-d4a0-000000000022"],
  ["doc3", "00000000-0000-4000-d4a0-000000000023"],
  ["doc4", "00000000-0000-4000-d4a0-000000000024"],
  ["doc5", "00000000-0000-4000-d4a0-000000000025"],
  ["doc6", "00000000-0000-4000-d4a0-000000000026"],
]);

function uuid(name: string): string {
  const id = uuidMap.get(name);
  if (!id) throw new Error(`No UUID for ${name}`);
  return id;
}

describe("Type Graph and Memo Conformance", () => {
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

    const plain = {
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    } as const;

    await tsfgaClient.writeRelationConfig({
      objectType: "group_b3g",
      relation: "member",
      directlyAssignable: [
        { type: "user_b3g" },
        { type: "group_b3g", relation: "member" },
      ],
      ...plain,
    });
    await tsfgaClient.writeRelationConfig({
      objectType: "folder_b3g",
      relation: "viewer",
      directlyAssignable: [{ type: "group_b3g", relation: "member" }],
      ...plain,
    });
    await tsfgaClient.writeRelationConfig({
      objectType: "folder_b3g",
      relation: "public",
      directlyAssignable: [{ type: "user_b3g", wildcard: true }],
      ...plain,
    });
    await tsfgaClient.writeRelationConfig({
      objectType: "shelf_b3g",
      relation: "viewer",
      directlyAssignable: [{ type: "user_b3g" }],
      ...plain,
    });
    await tsfgaClient.writeRelationConfig({
      objectType: "doc_b3g",
      relation: "parent",
      directlyAssignable: [{ type: "folder_b3g" }, { type: "shelf_b3g" }],
      ...plain,
    });
    await tsfgaClient.writeRelationConfig({
      objectType: "doc_b3g",
      relation: "arm_a",
      directlyAssignable: [{ type: "group_b3g", relation: "member" }],
      ...plain,
    });
    await tsfgaClient.writeRelationConfig({
      objectType: "doc_b3g",
      relation: "arm_b",
      directlyAssignable: [{ type: "user_b3g" }],
      ...plain,
    });
    await tsfgaClient.writeRelationConfig({
      objectType: "doc_b3g",
      relation: "either",
      directlyAssignable: [],
      ...plain,
      impliedBy: ["arm_a", "arm_b"],
    });
    await tsfgaClient.writeRelationConfig({
      objectType: "doc_b3g",
      relation: "from_parent",
      directlyAssignable: [],
      ...plain,
      tupleToUserset: [{ tupleset: "parent", computedUserset: "viewer" }],
    });
    await tsfgaClient.writeRelationConfig({
      objectType: "doc_b3g",
      relation: "anyone",
      directlyAssignable: [],
      ...plain,
      tupleToUserset: [{ tupleset: "parent", computedUserset: "public" }],
    });
    await tsfgaClient.writeRelationConfig({
      objectType: "doc_b3g",
      relation: "self_a",
      directlyAssignable: [
        { type: "user_b3g" },
        { type: "doc_b3g", relation: "self_b" },
      ],
      ...plain,
    });
    await tsfgaClient.writeRelationConfig({
      objectType: "doc_b3g",
      relation: "self_b",
      directlyAssignable: [{ type: "doc_b3g", relation: "self_a" }],
      ...plain,
    });

    const tuples = [
      {
        objectType: "group_b3g",
        objectId: uuid("eng"),
        relation: "member",
        subjectType: "user_b3g",
        subjectId: uuid("alice"),
      },
      {
        objectType: "group_b3g",
        objectId: uuid("big"),
        relation: "member",
        subjectType: "group_b3g",
        subjectId: uuid("eng"),
        subjectRelation: "member",
      },
      {
        objectType: "doc_b3g",
        objectId: uuid("doc1"),
        relation: "arm_a",
        subjectType: "group_b3g",
        subjectId: uuid("eng"),
        subjectRelation: "member",
      },
      {
        objectType: "doc_b3g",
        objectId: uuid("doc2"),
        relation: "arm_b",
        subjectType: "user_b3g",
        subjectId: uuid("bob"),
      },
      {
        objectType: "doc_b3g",
        objectId: uuid("doc3"),
        relation: "parent",
        subjectType: "folder_b3g",
        subjectId: uuid("f1"),
      },
      {
        objectType: "folder_b3g",
        objectId: uuid("f1"),
        relation: "viewer",
        subjectType: "group_b3g",
        subjectId: uuid("eng"),
        subjectRelation: "member",
      },
      {
        objectType: "doc_b3g",
        objectId: uuid("doc4"),
        relation: "parent",
        subjectType: "shelf_b3g",
        subjectId: uuid("s1"),
      },
      {
        objectType: "shelf_b3g",
        objectId: uuid("s1"),
        relation: "viewer",
        subjectType: "user_b3g",
        subjectId: uuid("bob"),
      },
      {
        objectType: "doc_b3g",
        objectId: uuid("doc5"),
        relation: "parent",
        subjectType: "folder_b3g",
        subjectId: uuid("f2"),
      },
      {
        objectType: "folder_b3g",
        objectId: uuid("f2"),
        relation: "public",
        subjectType: "user_b3g",
        subjectId: "*",
      },
      {
        objectType: "doc_b3g",
        objectId: uuid("doc6"),
        relation: "self_b",
        subjectType: "doc_b3g",
        subjectId: uuid("doc6"),
        subjectRelation: "self_a",
      },
      {
        objectType: "doc_b3g",
        objectId: uuid("doc6"),
        relation: "self_a",
        subjectType: "user_b3g",
        subjectId: uuid("alice"),
      },
    ];
    for (const tuple of tuples) await tsfgaClient.addTuple(tuple);

    storeId = await fgaCreateStore("type-graph-and-memo-conformance");
    authorizationModelId = await fgaWriteModel(
      storeId,
      "./type-graph-and-memo/model.dsl",
    );
    const { fgaWriteTuplesRaw } = await import("./helpers/openfga.ts");
    await fgaWriteTuplesRaw(
      storeId,
      authorizationModelId,
      tuples.map((t) => ({
        user: t.subjectRelation
          ? `${t.subjectType}:${t.subjectId}#${t.subjectRelation}`
          : `${t.subjectType}:${t.subjectId}`,
        relation: t.relation,
        object: `${t.objectType}:${t.objectId}`,
      })),
    );
  });

  afterAll(async () => {
    await rollbackTransaction(db);
    await destroyDb();
  });

  function check(overrides: Partial<CheckRequest>): CheckRequest {
    return {
      objectType: "doc_b3g",
      objectId: uuid("doc1"),
      relation: "either",
      subjectType: "user_b3g",
      subjectId: uuid("alice"),
      ...overrides,
    };
  }

  async function expectCheck(
    overrides: Partial<CheckRequest>,
    expected: CheckOutcome,
  ): Promise<void> {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      check(overrides),
      expected,
    );
  }

  // --- reachability through one arm of a union -------------------

  test("a subject reaching only the userset arm holds the union", async () => {
    await expectCheck({ objectId: uuid("doc1"), relation: "either" }, true);
  });

  test("a subject reaching only the direct arm holds the union", async () => {
    await expectCheck(
      { objectId: uuid("doc2"), relation: "either", subjectId: uuid("bob") },
      true,
    );
  });

  test("a subject reaching neither arm is denied", async () => {
    await expectCheck(
      { objectId: uuid("doc1"), relation: "either", subjectId: uuid("bob") },
      false,
    );
  });

  // --- reachability via a wildcard only --------------------------

  test("a relation reachable only through a wildcard grants", async () => {
    await expectCheck({ objectId: uuid("doc5"), relation: "anyone" }, true);
  });

  test("the same relation denies where no wildcard row exists", async () => {
    await expectCheck({ objectId: uuid("doc3"), relation: "anyone" }, false);
  });

  // --- reachability via a userset only ---------------------------

  test("a relation reachable only through a userset grants", async () => {
    await expectCheck({ objectId: uuid("doc1"), relation: "arm_a" }, true);
  });

  test("a nested userset still reaches", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "group_b3g",
        objectId: uuid("big"),
        relation: "member",
        subjectType: "user_b3g",
        subjectId: uuid("alice"),
      },
      true,
    );
  });

  // --- a TTU whose tupleset admits several types -----------------

  test("a TTU reaches through the folder branch", async () => {
    await expectCheck(
      { objectId: uuid("doc3"), relation: "from_parent" },
      true,
    );
  });

  test("a TTU reaches through the shelf branch", async () => {
    await expectCheck(
      {
        objectId: uuid("doc4"),
        relation: "from_parent",
        subjectId: uuid("bob"),
      },
      true,
    );
  });

  test("a TTU denies across branches", async () => {
    await expectCheck(
      { objectId: uuid("doc4"), relation: "from_parent" },
      false,
    );
  });

  // --- mutual recursion, which makes the walk truncate -----------

  test("a mutually recursive pair still grants", async () => {
    await expectCheck({ objectId: uuid("doc6"), relation: "self_a" }, true);
  });

  test("the other half of the pair grants too", async () => {
    await expectCheck({ objectId: uuid("doc6"), relation: "self_b" }, true);
  });

  test("the recursive pair denies a subject it never held", async () => {
    await expectCheck(
      {
        objectId: uuid("doc6"),
        relation: "self_a",
        subjectId: uuid("bob"),
      },
      false,
    );
  });

  // --- contextual tuples ------------------------------------------

  test("a contextual tuple grants through the userset arm", async () => {
    await expectCheck(
      {
        objectId: uuid("doc2"),
        relation: "arm_a",
        subjectId: uuid("alice"),
        contextualTuples: [
          {
            objectType: "doc_b3g",
            objectId: uuid("doc2"),
            relation: "arm_a",
            subjectType: "group_b3g",
            subjectId: uuid("eng"),
            subjectRelation: "member",
          },
        ],
      },
      true,
    );
  });

  test("a contextual tuple grants a TTU across a new parent", async () => {
    await expectCheck(
      {
        objectId: uuid("doc1"),
        relation: "from_parent",
        contextualTuples: [
          {
            objectType: "doc_b3g",
            objectId: uuid("doc1"),
            relation: "parent",
            subjectType: "folder_b3g",
            subjectId: uuid("f1"),
          },
        ],
      },
      true,
    );
  });

  // --- the memo's subject-relation level -------------------------

  test("a userset subject holds the relation its row names", async () => {
    await expectCheck(
      {
        objectId: uuid("doc1"),
        relation: "arm_a",
        subjectType: "group_b3g",
        subjectId: uuid("eng"),
        subjectRelation: "member",
      },
      true,
    );
  });

  test("the bare object of that userset does not", async () => {
    await expectCheck(
      {
        objectId: uuid("doc1"),
        relation: "arm_a",
        subjectType: "group_b3g",
        subjectId: uuid("eng"),
      },
      false,
    );
  });

  /**
   * Both questions in one batch, so both share a scope — and so a
   * memo that forgot the subject relation would answer the second
   * with the first's entry.
   */
  async function expectBatch(
    requests: readonly CheckRequest[],
    expected: readonly CheckOutcome[],
  ): Promise<void> {
    const [outcomes, upstream] = await Promise.all([
      tsfgaClient.checkMany(requests),
      Promise.all(
        requests.map((request) =>
          fgaCheck(storeId, authorizationModelId, {
            objectType: request.objectType,
            objectId: request.objectId,
            relation: request.relation,
            subjectType: request.subjectType,
            subjectId: request.subjectId,
            subjectRelation: request.subjectRelation,
            context: request.context,
          }),
        ),
      ),
    ]);
    const answers: CheckOutcome[] = outcomes.map((outcome) => {
      if (outcome.error !== undefined) {
        if (outcome.error instanceof TsfgaError) return "refused";
        throw outcome.error;
      }
      return outcome.allowed ?? false;
    });
    const upstreamAnswers: CheckOutcome[] = upstream.map((raw) => {
      if (raw === null) throw new Error("OpenFGA gave no answer");
      return typeof raw === "boolean" ? raw : "refused";
    });
    expect(answers).toEqual([...expected]);
    expect(upstreamAnswers).toEqual([...expected]);
  }

  const usersetSubject: CheckRequest = {
    objectType: "doc_b3g",
    objectId: uuid("doc1"),
    relation: "arm_a",
    subjectType: "group_b3g",
    subjectId: uuid("eng"),
    subjectRelation: "member",
  };
  const bareSubject: CheckRequest = {
    objectType: "doc_b3g",
    objectId: uuid("doc1"),
    relation: "arm_a",
    subjectType: "group_b3g",
    subjectId: uuid("eng"),
  };

  test("one batch, userset subject first", async () => {
    await expectBatch([usersetSubject, bareSubject], [true, false]);
  });

  test("one batch, bare subject first", async () => {
    await expectBatch([bareSubject, usersetSubject], [false, true]);
  });

  test("one batch, both orders repeated", async () => {
    await expectBatch(
      [bareSubject, usersetSubject, bareSubject, usersetSubject],
      [false, true, false, true],
    );
  });

  test("one batch mixing a user subject with both group forms", async () => {
    await expectBatch(
      [
        { ...bareSubject, subjectType: "user_b3g", subjectId: uuid("alice") },
        usersetSubject,
        bareSubject,
      ],
      [true, true, false],
    );
  });

  /**
   * Many cold walks starting at once in one scope. `expanding` is
   * one set shared by every traversal, so a walk that overlapped
   * another would truncate at its own root and publish an empty
   * source set — pruning every subject away from a relation that
   * grants. Every relation in the model is asked about here,
   * including both halves of the mutually recursive pair.
   */
  test("one batch touching every relation at once", async () => {
    const requests: CheckRequest[] = [
      check({ objectId: uuid("doc1"), relation: "arm_a" }),
      check({ objectId: uuid("doc1"), relation: "either" }),
      check({ objectId: uuid("doc2"), relation: "arm_b" }),
      check({ objectId: uuid("doc3"), relation: "from_parent" }),
      check({ objectId: uuid("doc5"), relation: "anyone" }),
      check({ objectId: uuid("doc6"), relation: "self_a" }),
      check({ objectId: uuid("doc6"), relation: "self_b" }),
      {
        objectType: "group_b3g",
        objectId: uuid("big"),
        relation: "member",
        subjectType: "user_b3g",
        subjectId: uuid("alice"),
      },
      {
        objectType: "folder_b3g",
        objectId: uuid("f1"),
        relation: "viewer",
        subjectType: "user_b3g",
        subjectId: uuid("alice"),
      },
      {
        objectType: "shelf_b3g",
        objectId: uuid("s1"),
        relation: "viewer",
        subjectType: "user_b3g",
        subjectId: uuid("alice"),
      },
      usersetSubject,
      bareSubject,
    ];
    await expectBatch(requests, [
      true,
      true,
      false,
      true,
      true,
      true,
      true,
      true,
      true,
      false,
      true,
      false,
    ]);
  });

  // --- listObjects with each subject form ------------------------

  test("listObjects for the userset subject", async () => {
    await expectListObjectsConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "doc_b3g",
        relation: "arm_a",
        subjectType: "group_b3g",
        subjectId: uuid("eng"),
        subjectRelation: "member",
      },
      [uuid("doc1")],
    );
  });

  test("listObjects for the bare subject", async () => {
    await expectListObjectsConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "doc_b3g",
        relation: "arm_a",
        subjectType: "group_b3g",
        subjectId: uuid("eng"),
      },
      [],
    );
  });

  test("configs match the model", () => {
    expectConfigsMatchModel("./type-graph-and-memo/model.dsl", fixture, {
      coverage: "complete",
    });
  });
});
