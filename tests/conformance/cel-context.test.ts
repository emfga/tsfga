import { afterAll, beforeAll, describe, test } from "bun:test";
import {
  type AddTupleRequest,
  createTsfga,
  type TsfgaClient,
} from "@tsfga/core";
import type { DB } from "@tsfga/kysely";
import { KyselyTupleStore } from "@tsfga/kysely";
import type { Kysely } from "kysely";
import {
  type CheckOutcome,
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
  fgaWriteTuplesRaw,
} from "./helpers/openfga.ts";

/**
 * Conditions in their working context rather than in isolation: a
 * different condition on every edge kind of one path, several of
 * them evaluated in one check, the tuple's own context shadowing
 * the request's, an ill-typed value arriving at depth rather than
 * at the root, and two rows of one read raising together.
 *
 * The path is three hops with a condition on each:
 *
 *   doc:d1 --parent(g3)--> folder:f1
 *     folder:f1 --viewer(g2)--> group:eng#member
 *       group:eng --member(g1)--> user:alice
 *
 * so `doc:d1#viewer@user:alice` reads a TTU tupleset row, a
 * userset row and a direct row, and every one of the three has to
 * evaluate before the grant exists. That also makes the request
 * context carry three parameters at once, which is where a
 * shadowing or an ordering bug would show.
 *
 * The last section is about the request context itself rather than
 * about any edge: OpenFGA validates every string in a check's
 * `context` for Unicode control characters and refuses the request
 * when one is present. tsfga applies that rule to a *tuple's*
 * context — `validateTupleWrite` — and nowhere else.
 */

const uuidMap = new Map<string, string>([
  ["alice", "00000000-0000-4000-d510-000000000041"],
  ["eng", "00000000-0000-4000-d510-000000000042"],
  ["ops", "00000000-0000-4000-d510-000000000043"],
  ["f1", "00000000-0000-4000-d510-000000000044"],
  ["f2", "00000000-0000-4000-d510-000000000045"],
  ["f3", "00000000-0000-4000-d510-000000000046"],
  ["d1", "00000000-0000-4000-d510-000000000047"],
  ["d2", "00000000-0000-4000-d510-000000000048"],
  ["d3", "00000000-0000-4000-d510-000000000049"],
  ["d4", "00000000-0000-4000-d510-00000000004a"],
]);

function uuid(name: string): string {
  const id = uuidMap.get(name);
  if (!id) throw new Error(`No UUID for ${name}`);
  return id;
}

const TUPLES: readonly AddTupleRequest[] = [
  {
    objectType: "group_c5",
    objectId: uuid("eng"),
    relation: "member",
    subjectType: "user_c5",
    subjectId: uuid("alice"),
    conditionName: "g1_c5",
  },
  {
    objectType: "group_c5",
    objectId: uuid("ops"),
    relation: "member",
    subjectType: "user_c5",
    subjectId: uuid("alice"),
    conditionName: "g1_c5",
  },
  // f1 — the plain three-hop path.
  {
    objectType: "folder_c5",
    objectId: uuid("f1"),
    relation: "viewer",
    subjectType: "group_c5",
    subjectId: uuid("eng"),
    subjectRelation: "member",
    conditionName: "g2_c5",
  },
  // f2 — two conditioned userset rows on one read, so both raise
  // together when `m` is absent.
  {
    objectType: "folder_c5",
    objectId: uuid("f2"),
    relation: "viewer",
    subjectType: "group_c5",
    subjectId: uuid("eng"),
    subjectRelation: "member",
    conditionName: "g2_c5",
  },
  {
    objectType: "folder_c5",
    objectId: uuid("f2"),
    relation: "viewer",
    subjectType: "group_c5",
    subjectId: uuid("ops"),
    subjectRelation: "member",
    conditionName: "g2_c5",
  },
  // f3 — one conditioned row beside one unconditioned one.
  {
    objectType: "folder_c5",
    objectId: uuid("f3"),
    relation: "viewer",
    subjectType: "group_c5",
    subjectId: uuid("eng"),
    subjectRelation: "member",
    conditionName: "g2_c5",
  },
  {
    objectType: "folder_c5",
    objectId: uuid("f3"),
    relation: "viewer",
    subjectType: "group_c5",
    subjectId: uuid("ops"),
    subjectRelation: "member",
  },
  {
    objectType: "doc_c5",
    objectId: uuid("d1"),
    relation: "parent",
    subjectType: "folder_c5",
    subjectId: uuid("f1"),
    conditionName: "g3_c5",
  },
  {
    objectType: "doc_c5",
    objectId: uuid("d2"),
    relation: "parent",
    subjectType: "folder_c5",
    subjectId: uuid("f2"),
    conditionName: "g3_c5",
  },
  {
    objectType: "doc_c5",
    objectId: uuid("d3"),
    relation: "parent",
    subjectType: "folder_c5",
    subjectId: uuid("f3"),
    conditionName: "g3_c5",
  },
  // d4 — the tuple's own context shadows the request's on the
  // shallowest edge.
  {
    objectType: "doc_c5",
    objectId: uuid("d4"),
    relation: "parent",
    subjectType: "folder_c5",
    subjectId: uuid("f1"),
    conditionName: "g3_c5",
    conditionContext: { k: 5 },
  },
  {
    objectType: "doc_c5",
    objectId: uuid("d1"),
    relation: "ctl",
    subjectType: "user_c5",
    subjectId: uuid("alice"),
    conditionName: "ctl_c5",
  },
];

describe("CEL conditions in context", () => {
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

    for (const [name, parameter, expression] of [
      ["g1_c5", "n", "n > 0"],
      ["g2_c5", "m", "m > 0"],
      ["g3_c5", "k", "k > 0"],
    ] as const) {
      await tsfgaClient.writeConditionDefinition({
        name,
        expression,
        parameters: { [parameter]: "int" },
      });
    }
    await tsfgaClient.writeConditionDefinition({
      name: "ctl_c5",
      expression: "s.size() == 3",
      parameters: { s: "string" },
    });

    await tsfgaClient.writeRelationConfig({
      objectType: "group_c5",
      relation: "member",
      directlyAssignable: [{ type: "user_c5", condition: "g1_c5" }],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });
    await tsfgaClient.writeRelationConfig({
      objectType: "folder_c5",
      relation: "viewer",
      directlyAssignable: [
        { type: "group_c5", relation: "member" },
        { type: "group_c5", relation: "member", condition: "g2_c5" },
      ],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });
    await tsfgaClient.writeRelationConfig({
      objectType: "doc_c5",
      relation: "parent",
      directlyAssignable: [{ type: "folder_c5", condition: "g3_c5" }],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });
    await tsfgaClient.writeRelationConfig({
      objectType: "doc_c5",
      relation: "viewer",
      directlyAssignable: [],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: [{ tupleset: "parent", computedUserset: "viewer" }],
      excludedBy: null,
      intersection: null,
    });
    await tsfgaClient.writeRelationConfig({
      objectType: "doc_c5",
      relation: "ctl",
      directlyAssignable: [{ type: "user_c5", condition: "ctl_c5" }],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });

    for (const tuple of TUPLES) await tsfgaClient.addTuple(tuple);

    storeId = await fgaCreateStore("cel-context");
    modelId = await fgaWriteModel(storeId, "./cel-context/model.dsl");
    await fgaWriteTuplesRaw(
      storeId,
      modelId,
      TUPLES.map((tuple) => ({
        user: tuple.subjectRelation
          ? `${tuple.subjectType}:${tuple.subjectId}#${tuple.subjectRelation}`
          : `${tuple.subjectType}:${tuple.subjectId}`,
        relation: tuple.relation,
        object: `${tuple.objectType}:${tuple.objectId}`,
        ...(tuple.conditionName
          ? {
              condition: {
                name: tuple.conditionName,
                ...(tuple.conditionContext
                  ? { context: tuple.conditionContext }
                  : {}),
              },
            }
          : {}),
      })),
    );
  });

  afterAll(async () => {
    await rollbackTransaction(db);
    await destroyDb();
  });

  const view = (
    doc: string,
    context: Record<string, unknown>,
    expected: CheckOutcome,
  ) =>
    expectConformance(
      storeId,
      modelId,
      tsfgaClient,
      {
        objectType: "doc_c5",
        objectId: uuid(doc),
        relation: "viewer",
        subjectType: "user_c5",
        subjectId: uuid("alice"),
        context,
      },
      expected,
    );

  const ctl = (context: Record<string, unknown>, expected: CheckOutcome) =>
    expectConformance(
      storeId,
      modelId,
      tsfgaClient,
      {
        objectType: "doc_c5",
        objectId: uuid("d1"),
        relation: "ctl",
        subjectType: "user_c5",
        subjectId: uuid("alice"),
        context,
      },
      expected,
    );

  describe("a condition on every edge of one path", () => {
    test("all three satisfied grants", async () => {
      await view("d1", { n: 1, m: 1, k: 1 }, true);
    });

    test("the direct row's condition denies", async () => {
      await view("d1", { n: 0, m: 1, k: 1 }, false);
    });

    test("the userset row's condition denies", async () => {
      await view("d1", { n: 1, m: 0, k: 1 }, false);
    });

    test("the tupleset row's condition denies", async () => {
      await view("d1", { n: 1, m: 1, k: 0 }, false);
    });

    test("a parameter missing at the deepest edge refuses", async () => {
      await view("d1", { m: 1, k: 1 }, "refused");
    });

    test("a parameter missing at the middle edge refuses", async () => {
      await view("d1", { n: 1, k: 1 }, "refused");
    });

    test("a parameter missing at the shallowest edge refuses", async () => {
      await view("d1", { n: 1, m: 1 }, "refused");
    });

    test("an ill-typed value at the deepest edge refuses", async () => {
      await view("d1", { n: "abc", m: 1, k: 1 }, "refused");
    });

    test("an ill-typed value at the shallowest edge refuses", async () => {
      await view("d1", { n: 1, m: 1, k: "abc" }, "refused");
    });

    test("an ill-typed value the path never reads is ignored", async () => {
      // `k` is read first and denies, so `n` is never coerced.
      await view("d1", { n: "abc", m: 1, k: 0 }, false);
    });
  });

  describe("the tuple's context shadows the request's", () => {
    test("the tuple's k wins over the request's", async () => {
      await view("d4", { n: 1, m: 1, k: 0 }, true);
    });

    test("and still wins when the request omits it", async () => {
      await view("d4", { n: 1, m: 1 }, true);
    });

    test("the edges the tuple says nothing about still read the request", async () => {
      await view("d4", { n: 0, m: 1 }, false);
    });
  });

  describe("two rows of one read", () => {
    test("both raising refuses", async () => {
      await view("d2", { n: 1, k: 1 }, "refused");
    });

    test("both raising for different reasons refuses", async () => {
      await view("d2", { n: 1, m: "abc", k: 1 }, "refused");
    });

    test("one raising beside one granting grants", async () => {
      await view("d3", { n: 1, k: 1 }, true);
    });

    test("one raising beside one whose subtree denies still denies", async () => {
      // The conditioned row on f3 raises for a missing `m`; the
      // unconditioned one carries no condition, so it counts as an
      // evaluated row and suppresses the error — even though the
      // dispatch beneath it then denies on `n`. Both engines
      // answer `false` rather than refusing, which is the rule
      // stated per *read* rather than per node.
      await view("d3", { n: 0, k: 1 }, false);
    });
  });

  /**
   * OpenFGA validates a check's request context the same way it
   * validates a tuple's: `ValidateContext` walks every string and
   * refuses a Unicode control character, reporting
   * `invalid context: context value "…" contains forbidden
   * characters`. tsfga runs that rule only over a tuple's context.
   *
   * The direction is granting — tsfga answers a request upstream
   * declines — and the answer is `true` for anything the condition
   * happens to be satisfied by.
   */
  describe("control characters in a check's request context", () => {
    test("a newline", async () => {
      await ctl({ s: "a\nb" }, "refused");
    });

    test("a tab", async () => {
      await ctl({ s: "a\tb" }, "refused");
    });

    test("a carriage return", async () => {
      await ctl({ s: "a\rb" }, "refused");
    });

    test("a NUL", async () => {
      await ctl({ s: "a b" }, "refused");
    });

    test("DEL", async () => {
      await ctl({ s: "ab" }, "refused");
    });

    test("a C1 control character", async () => {
      await ctl({ s: "ab" }, "refused");
    });

    test("a control character nested in a list", async () => {
      await expectConformance(
        storeId,
        modelId,
        tsfgaClient,
        {
          objectType: "doc_c5",
          objectId: uuid("d1"),
          relation: "viewer",
          subjectType: "user_c5",
          subjectId: uuid("alice"),
          context: { n: 1, m: 1, k: 1, stray: ["a\nb"] },
        },
        "refused",
      );
    });

    test("a string with no control character is answered by both", async () => {
      await ctl({ s: "a b" }, true);
    });

    test("a non-breaking space is not a control character", async () => {
      await ctl({ s: "a b" }, true);
    });

    test("a zero-width space is not a control character", async () => {
      await ctl({ s: "a​b" }, true);
    });
  });

  test("the relation configs say what the model says", () => {
    expectConfigsMatchModel("./cel-context/model.dsl", fixture, {
      coverage: "complete",
    });
  });
});
