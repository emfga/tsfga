import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { OpenFgaClient } from "@openfga/sdk";
import {
  type AddTupleRequest,
  type CheckRequest,
  createTsfga,
  type RelationConfig,
  type TsfgaClient,
  TsfgaError,
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
  fgaWriteModel,
  fgaWriteTuplesRaw,
} from "./helpers/openfga.ts";

/**
 * Contextual tuples, and the batch that shares a resolution scope.
 *
 * Two properties are worth asserting beyond "the tuple is seen".
 * First, a contextual tuple must be visible at every depth, not
 * only at the node the request names — tsfga overlays the store
 * rather than the root node, and a chain completed three hops down
 * is the shape that would catch a root-only overlay.
 *
 * Second, `checkMany` shares a config cache and a node memo across
 * the whole batch, so two requests naming the same node under
 * *different* context or different contextual tuples are exactly
 * the pair a memo keyed too coarsely would collapse. Both
 * orderings are asserted, since a memo populated by the first
 * request is what the second would read.
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

/** A tuple as OpenFGA spells it, condition included. */
function raw(t: AddTupleRequest) {
  return {
    user: t.subjectRelation
      ? `${t.subjectType}:${t.subjectId}#${t.subjectRelation}`
      : `${t.subjectType}:${t.subjectId}`,
    relation: t.relation,
    object: `${t.objectType}:${t.objectId}`,
    ...(t.conditionName
      ? {
          condition: {
            name: t.conditionName,
            ...(t.conditionContext ? { context: t.conditionContext } : {}),
          },
        }
      : {}),
  };
}

describe("Contextual Tuple Conformance", () => {
  let db: Kysely<DB>;
  let storeId: string;
  let modelId: string;
  let tsfgaClient: TsfgaClient;
  let fixture: FixtureRecord;

  const sdk = () =>
    new OpenFgaClient({ apiUrl: process.env.FGA_API_URL, storeId });

  beforeAll(async () => {
    db = getDb();
    await beginTransaction(db);
    tsfgaClient = createTsfga(new KyselyTupleStore(db));
    fixture = recordFixture(tsfgaClient);

    await tsfgaClient.writeConditionDefinition({
      name: "ok_a8",
      expression: "x > 5",
      parameters: { x: "int" },
    });

    for (const c of [
      cfg("cgroup_a8", "member", { directlyAssignable: [{ type: "user_a8" }] }),
      cfg("cdoc_a8", "parent", { directlyAssignable: [{ type: "cdoc_a8" }] }),
      cfg("cdoc_a8", "viewer", {
        directlyAssignable: [
          { type: "user_a8" },
          { type: "cgroup_a8", relation: "member" },
        ],
        tupleToUserset: [{ tupleset: "parent", computedUserset: "viewer" }],
      }),
      cfg("kdoc_a8", "viewer", {
        directlyAssignable: [{ type: "user_a8", condition: "ok_a8" }],
      }),
    ]) {
      await tsfgaClient.writeRelationConfig(c);
    }

    // A 4-link parent chain with no grant anywhere on it, and a
    // stored grant on a doc the chain does not reach.
    const rows: AddTupleRequest[] = [];
    for (let i = 0; i < 4; i++) {
      rows.push({
        objectType: "cdoc_a8",
        objectId: id(i),
        relation: "parent",
        subjectType: "cdoc_a8",
        subjectId: id(i + 1),
      });
    }
    rows.push({
      objectType: "cdoc_a8",
      objectId: id(9),
      relation: "viewer",
      subjectType: "user_a8",
      subjectId: ALICE,
    });
    rows.push({
      objectType: "kdoc_a8",
      objectId: id(40),
      relation: "viewer",
      subjectType: "user_a8",
      subjectId: ALICE,
      conditionName: "ok_a8",
    });
    for (const row of rows) await tsfgaClient.addTuple(row);

    storeId = await fgaCreateStore("contextual-depth-conformance");
    modelId = await fgaWriteModel(storeId, "./contextual-depth/model.dsl");
    await fgaWriteTuplesRaw(storeId, modelId, rows.map(raw));
  });

  afterAll(async () => {
    await rollbackTransaction(db);
    await destroyDb();
  });

  const root: CheckRequest = {
    objectType: "cdoc_a8",
    objectId: id(0),
    relation: "viewer",
    subjectType: "user_a8",
    subjectId: ALICE,
  };

  describe("a contextual grant is visible at every depth", () => {
    for (const depth of [0, 1, 2, 3, 4]) {
      test(`${depth} hops from the request`, async () => {
        await expectConformance(
          storeId,
          modelId,
          tsfgaClient,
          {
            ...root,
            contextualTuples: [
              {
                objectType: "cdoc_a8",
                objectId: id(depth),
                relation: "viewer",
                subjectType: "user_a8",
                subjectId: ALICE,
              },
            ],
          },
          true,
        );
      });
    }
  });

  test("a contextual tuple can extend the chain onto a stored grant", async () => {
    await expectConformance(
      storeId,
      modelId,
      tsfgaClient,
      {
        ...root,
        contextualTuples: [
          {
            objectType: "cdoc_a8",
            objectId: id(4),
            relation: "parent",
            subjectType: "cdoc_a8",
            subjectId: id(9),
          },
        ],
      },
      true,
    );
  });

  test("a contextual userset and its contextual member", async () => {
    await expectConformance(
      storeId,
      modelId,
      tsfgaClient,
      {
        ...root,
        contextualTuples: [
          {
            objectType: "cdoc_a8",
            objectId: id(0),
            relation: "viewer",
            subjectType: "cgroup_a8",
            subjectId: id(50),
            subjectRelation: "member",
          },
          {
            objectType: "cgroup_a8",
            objectId: id(50),
            relation: "member",
            subjectType: "user_a8",
            subjectId: ALICE,
          },
        ],
      },
      true,
    );
  });

  test("a contextual duplicate of a stored tuple still grants once", async () => {
    const stored: AddTupleRequest = {
      objectType: "cdoc_a8",
      objectId: id(9),
      relation: "viewer",
      subjectType: "user_a8",
      subjectId: ALICE,
    };
    await expectConformance(
      storeId,
      modelId,
      tsfgaClient,
      { ...stored, contextualTuples: [stored] },
      true,
    );
  });

  describe("a contextual tuple carrying a condition", () => {
    const conditional = (x: number): CheckRequest => ({
      objectType: "kdoc_a8",
      objectId: id(41),
      relation: "viewer",
      subjectType: "user_a8",
      subjectId: ALICE,
      context: { x },
      contextualTuples: [
        {
          objectType: "kdoc_a8",
          objectId: id(41),
          relation: "viewer",
          subjectType: "user_a8",
          subjectId: ALICE,
          conditionName: "ok_a8",
        },
      ],
    });

    test("granted when the request context satisfies it", async () => {
      await expectConformance(
        storeId,
        modelId,
        tsfgaClient,
        conditional(10),
        true,
      );
    });

    test("denied when it does not", async () => {
      await expectConformance(
        storeId,
        modelId,
        tsfgaClient,
        conditional(1),
        false,
      );
    });
  });

  describe("contextual tuples the model does not admit", () => {
    test("unconditional where the model requires a condition", async () => {
      await expectConformance(
        storeId,
        modelId,
        tsfgaClient,
        {
          objectType: "kdoc_a8",
          objectId: id(42),
          relation: "viewer",
          subjectType: "user_a8",
          subjectId: ALICE,
          contextualTuples: [
            {
              objectType: "kdoc_a8",
              objectId: id(42),
              relation: "viewer",
              subjectType: "user_a8",
              subjectId: ALICE,
            },
          ],
        },
        "refused",
      );
    });

    test("a subject type the relation does not admit", async () => {
      await expectConformance(
        storeId,
        modelId,
        tsfgaClient,
        {
          ...root,
          objectId: id(30),
          contextualTuples: [
            {
              objectType: "cdoc_a8",
              objectId: id(30),
              relation: "viewer",
              subjectType: "cdoc_a8",
              subjectId: id(31),
            },
          ],
        },
        "refused",
      );
    });

    test("a relation the model does not define", async () => {
      await expectConformance(
        storeId,
        modelId,
        tsfgaClient,
        {
          ...root,
          objectId: id(32),
          contextualTuples: [
            {
              objectType: "cdoc_a8",
              objectId: id(32),
              relation: "nosuch",
              subjectType: "user_a8",
              subjectId: ALICE,
            },
          ],
        },
        "refused",
      );
    });

    test("a condition name the model does not define", async () => {
      await expectConformance(
        storeId,
        modelId,
        tsfgaClient,
        {
          objectType: "kdoc_a8",
          objectId: id(43),
          relation: "viewer",
          subjectType: "user_a8",
          subjectId: ALICE,
          context: { x: 10 },
          contextualTuples: [
            {
              objectType: "kdoc_a8",
              objectId: id(43),
              relation: "viewer",
              subjectType: "user_a8",
              subjectId: ALICE,
              conditionName: "nope_a8",
            },
          ],
        },
        "refused",
      );
    });
  });

  describe("checkMany shares a scope without sharing answers", () => {
    async function expectBatch(
      requests: CheckRequest[],
      expected: boolean[],
    ): Promise<void> {
      const [outcomes, batch] = await Promise.all([
        tsfgaClient.checkMany(requests),
        sdk().batchCheck(
          {
            checks: requests.map((r, i) => ({
              user: `${r.subjectType}:${r.subjectId}`,
              relation: r.relation,
              object: `${r.objectType}:${r.objectId}`,
              correlationId: `c${i}`,
              context: r.context,
              contextualTuples: r.contextualTuples
                ? { tuple_keys: r.contextualTuples.map(raw) }
                : undefined,
            })),
          },
          { authorizationModelId: modelId },
        ),
      ]);

      const mine = outcomes.map((o) => o.allowed);
      const theirs = requests.map((_, i) => {
        const row = batch.result.find((r) => r.correlationId === `c${i}`);
        if (!row) throw new Error(`no batch result for c${i}`);
        return row.allowed;
      });
      expect(mine).toEqual(theirs);
      expect(mine).toEqual(expected);
    }

    const conditional = (x: number): CheckRequest => ({
      objectType: "kdoc_a8",
      objectId: id(40),
      relation: "viewer",
      subjectType: "user_a8",
      subjectId: ALICE,
      context: { x },
    });

    test("the same node under different request context", async () => {
      await expectBatch(
        [conditional(10), conditional(1), conditional(10)],
        [true, false, true],
      );
    });

    const granting: AddTupleRequest = {
      objectType: "cdoc_a8",
      objectId: id(4),
      relation: "viewer",
      subjectType: "user_a8",
      subjectId: ALICE,
    };

    test("the same node with and without a contextual grant", async () => {
      await expectBatch(
        [
          { ...root, contextualTuples: [granting] },
          { ...root },
          { ...root, contextualTuples: [granting] },
        ],
        [true, false, true],
      );
    });

    test("and in the other order", async () => {
      await expectBatch(
        [{ ...root }, { ...root, contextualTuples: [granting] }],
        [false, true],
      );
    });

    test("a failing request does not take the batch with it", async () => {
      const outcomes = await tsfgaClient.checkMany([
        { ...root, objectId: id(9) },
        { ...root, relation: "nosuch" },
        { ...root },
      ]);
      expect(outcomes.map((o) => o.allowed)).toEqual([true, false, false]);
      expect(outcomes[0]?.error).toBeUndefined();
      expect(outcomes[1]?.error).toBeInstanceOf(TsfgaError);
      expect(outcomes[2]?.error).toBeUndefined();

      const batch = await sdk().batchCheck(
        {
          checks: [
            {
              user: `user_a8:${ALICE}`,
              relation: "viewer",
              object: `cdoc_a8:${id(9)}`,
              correlationId: "c0",
            },
            {
              user: `user_a8:${ALICE}`,
              relation: "nosuch",
              object: `cdoc_a8:${id(0)}`,
              correlationId: "c1",
            },
            {
              user: `user_a8:${ALICE}`,
              relation: "viewer",
              object: `cdoc_a8:${id(0)}`,
              correlationId: "c2",
            },
          ],
        },
        { authorizationModelId: modelId },
      );
      const byId = new Map(batch.result.map((r) => [r.correlationId, r]));
      expect(byId.get("c0")?.allowed).toBe(true);
      expect(byId.get("c1")?.allowed).toBe(false);
      expect(byId.get("c1")?.error).toBeTruthy();
      expect(byId.get("c2")?.allowed).toBe(false);
    });
  });

  test("the relation configs say what the model says", () => {
    expectConfigsMatchModel("./contextual-depth/model.dsl", fixture, {
      coverage: "complete",
    });
  });
});
