import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  createTsfga,
  type RelationConfig,
  type TsfgaClient,
  TsfgaError,
} from "@tsfga/core";
import { type DB, KyselyTupleStore } from "@tsfga/kysely";
import type { Kysely } from "kysely";
import {
  expectConfigsMatchModel,
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
  fgaListObjects,
  fgaWriteModel,
  fgaWriteTuples,
} from "./helpers/openfga.ts";

/**
 * `listObjects` when the grants are conditioned.
 *
 * The request carries one `context` for the whole call, but each
 * candidate evaluates its own rows against it, so a context can
 * satisfy one object's condition, falsify another's, and be
 * *unevaluable* against a third. The last case is the one worth
 * asking about: a per-candidate error has to be reconciled with an
 * answer that is a set.
 */

const uuidMap = new Map<string, string>([
  ["alice", "00000000-0000-4000-d430-000000000101"],
  ["carol", "00000000-0000-4000-d430-000000000102"],
  ["g1", "00000000-0000-4000-d430-000000000103"],
  ["f1", "00000000-0000-4000-d430-000000000104"],
  ["c_direct", "00000000-0000-4000-d430-000000000105"],
  ["c_cond", "00000000-0000-4000-d430-000000000106"],
  ["c_pub", "00000000-0000-4000-d430-000000000107"],
  ["c_grp", "00000000-0000-4000-d430-000000000108"],
  ["c_inh", "00000000-0000-4000-d430-000000000109"],
  ["c_block", "00000000-0000-4000-d430-00000000010a"],
  ["c_strict", "00000000-0000-4000-d430-00000000010b"],
]);

function uuid(name: string): string {
  const id = uuidMap.get(name);
  if (!id) throw new Error(`No UUID for ${name}`);
  return id;
}

const RELATION_CONFIGS: RelationConfig[] = [
  {
    objectType: "group_a4c",
    relation: "member",
    directlyAssignable: [{ type: "user_a4c", condition: "flag_a4" }],
    impliedBy: null,
    computedUserset: null,
    tupleToUserset: null,
    excludedBy: null,
    intersection: null,
  },
  {
    objectType: "folder_a4c",
    relation: "viewer",
    directlyAssignable: [{ type: "user_a4c" }],
    impliedBy: null,
    computedUserset: null,
    tupleToUserset: null,
    excludedBy: null,
    intersection: null,
  },
  {
    objectType: "doc_a4c",
    relation: "parent",
    directlyAssignable: [{ type: "folder_a4c", condition: "flag_a4" }],
    impliedBy: null,
    computedUserset: null,
    tupleToUserset: null,
    excludedBy: null,
    intersection: null,
  },
  {
    objectType: "doc_a4c",
    relation: "direct",
    directlyAssignable: [
      { type: "user_a4c" },
      { type: "user_a4c", condition: "flag_a4" },
    ],
    impliedBy: null,
    computedUserset: null,
    tupleToUserset: null,
    excludedBy: null,
    intersection: null,
  },
  {
    objectType: "doc_a4c",
    relation: "pub",
    directlyAssignable: [
      { type: "user_a4c", wildcard: true, condition: "flag_a4" },
    ],
    impliedBy: null,
    computedUserset: null,
    tupleToUserset: null,
    excludedBy: null,
    intersection: null,
  },
  {
    objectType: "doc_a4c",
    relation: "grp",
    directlyAssignable: [{ type: "group_a4c", relation: "member" }],
    impliedBy: null,
    computedUserset: null,
    tupleToUserset: null,
    excludedBy: null,
    intersection: null,
  },
  {
    objectType: "doc_a4c",
    relation: "inherited",
    directlyAssignable: [],
    impliedBy: null,
    computedUserset: null,
    tupleToUserset: [{ tupleset: "parent", computedUserset: "viewer" }],
    excludedBy: null,
    intersection: null,
  },
  {
    objectType: "doc_a4c",
    relation: "blocked",
    directlyAssignable: [{ type: "user_a4c", condition: "flag_a4" }],
    impliedBy: null,
    computedUserset: null,
    tupleToUserset: null,
    excludedBy: null,
    intersection: null,
  },
  {
    objectType: "doc_a4c",
    relation: "guarded",
    directlyAssignable: [],
    impliedBy: null,
    computedUserset: "direct",
    tupleToUserset: null,
    excludedBy: "blocked",
    intersection: null,
  },
  {
    objectType: "doc_a4c",
    relation: "strict",
    directlyAssignable: [{ type: "user_a4c", condition: "needs_x_a4" }],
    impliedBy: null,
    computedUserset: null,
    tupleToUserset: null,
    excludedBy: null,
    intersection: null,
  },
];

describe("listObjects condition parity", () => {
  let db: Kysely<DB>;
  let storeId: string;
  let authorizationModelId: string;
  let tsfgaClient: TsfgaClient;
  let fixture: FixtureRecord;

  beforeAll(async () => {
    db = getDb();
    await beginTransaction(db);

    tsfgaClient = createTsfga(new KyselyTupleStore(db));
    fixture = recordFixture(tsfgaClient);

    await tsfgaClient.writeConditionDefinition({
      name: "flag_a4",
      expression: "flag == true",
      parameters: { flag: "bool" },
    });
    await tsfgaClient.writeConditionDefinition({
      name: "needs_x_a4",
      expression: "x > 5",
      parameters: { x: "int" },
    });

    for (const config of RELATION_CONFIGS) {
      await tsfgaClient.writeRelationConfig(config);
    }

    const tuples: Array<{
      objectType: string;
      objectId: string;
      relation: string;
      subjectType: string;
      subjectId: string;
      subjectRelation?: string | null;
      conditionName?: string | null;
    }> = [
      {
        objectType: "doc_a4c",
        objectId: uuid("c_direct"),
        relation: "direct",
        subjectType: "user_a4c",
        subjectId: uuid("alice"),
      },
      {
        objectType: "doc_a4c",
        objectId: uuid("c_cond"),
        relation: "direct",
        subjectType: "user_a4c",
        subjectId: uuid("alice"),
        conditionName: "flag_a4",
      },
      {
        objectType: "doc_a4c",
        objectId: uuid("c_pub"),
        relation: "pub",
        subjectType: "user_a4c",
        subjectId: "*",
        conditionName: "flag_a4",
      },
      {
        objectType: "group_a4c",
        objectId: uuid("g1"),
        relation: "member",
        subjectType: "user_a4c",
        subjectId: uuid("alice"),
        conditionName: "flag_a4",
      },
      {
        objectType: "doc_a4c",
        objectId: uuid("c_grp"),
        relation: "grp",
        subjectType: "group_a4c",
        subjectId: uuid("g1"),
        subjectRelation: "member",
      },
      {
        objectType: "folder_a4c",
        objectId: uuid("f1"),
        relation: "viewer",
        subjectType: "user_a4c",
        subjectId: uuid("alice"),
      },
      {
        objectType: "doc_a4c",
        objectId: uuid("c_inh"),
        relation: "parent",
        subjectType: "folder_a4c",
        subjectId: uuid("f1"),
        conditionName: "flag_a4",
      },
      {
        objectType: "doc_a4c",
        objectId: uuid("c_block"),
        relation: "direct",
        subjectType: "user_a4c",
        subjectId: uuid("alice"),
      },
      {
        objectType: "doc_a4c",
        objectId: uuid("c_block"),
        relation: "blocked",
        subjectType: "user_a4c",
        subjectId: uuid("alice"),
        conditionName: "flag_a4",
      },
      {
        objectType: "doc_a4c",
        objectId: uuid("c_strict"),
        relation: "strict",
        subjectType: "user_a4c",
        subjectId: uuid("alice"),
        conditionName: "needs_x_a4",
      },
    ];
    for (const tuple of tuples) {
      await tsfgaClient.addTuple(tuple);
    }

    storeId = await fgaCreateStore("list-objects-conditions-conformance");
    authorizationModelId = await fgaWriteModel(
      storeId,
      "./list-objects-conditions/model.dsl",
    );
    await fgaWriteTuples(
      storeId,
      "./list-objects-conditions/tuples.yaml",
      authorizationModelId,
      uuidMap,
    );
  });

  afterAll(async () => {
    await rollbackTransaction(db);
    await destroyDb();
  });

  async function expectObjects(
    relation: string,
    subject: string,
    context: Record<string, unknown> | undefined,
    expected: string[],
  ): Promise<void> {
    await expectListObjectsConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "doc_a4c",
        relation,
        subjectType: "user_a4c",
        subjectId: uuid(subject),
        context,
      },
      expected.map(uuid),
    );
  }

  describe("context satisfies or falsifies the condition", () => {
    test("a satisfied condition adds the object", async () => {
      await expectObjects("direct", "alice", { flag: true }, [
        "c_direct",
        "c_cond",
        "c_block",
      ]);
    });

    test("a falsified condition drops it", async () => {
      await expectObjects("direct", "alice", { flag: false }, [
        "c_direct",
        "c_block",
      ]);
    });

    test("a conditioned wildcard", async () => {
      await expectObjects("pub", "carol", { flag: true }, ["c_pub"]);
      await expectObjects("pub", "carol", { flag: false }, []);
    });

    test("a conditioned userset edge", async () => {
      await expectObjects("grp", "alice", { flag: true }, ["c_grp"]);
      await expectObjects("grp", "alice", { flag: false }, []);
    });

    test("a conditioned tupleset edge", async () => {
      await expectObjects("inherited", "alice", { flag: true }, ["c_inh"]);
      await expectObjects("inherited", "alice", { flag: false }, []);
    });

    test("a conditioned exclusion arm", async () => {
      // The block only bites when its own condition holds.
      await expectObjects("guarded", "alice", { flag: true }, [
        "c_direct",
        "c_cond",
      ]);
      await expectObjects("guarded", "alice", { flag: false }, [
        "c_direct",
        "c_block",
      ]);
    });

    test("an int condition, either way", async () => {
      await expectObjects("strict", "alice", { x: 10 }, ["c_strict"]);
      await expectObjects("strict", "alice", { x: 1 }, []);
    });
  });

  describe("a context that cannot be evaluated", () => {
    /** What each engine does with the same listObjects call. */
    async function outcomes(
      relation: string,
      context: Record<string, unknown> | undefined,
    ): Promise<{ tsfga: string; openfga: string }> {
      const params = {
        objectType: "doc_a4c",
        relation,
        subjectType: "user_a4c",
        subjectId: uuid("alice"),
        context,
      };
      const tsfga = await tsfgaClient
        .listObjects(params)
        .then((objects) => `answered:${[...objects].sort().join(",")}`)
        .catch((error: unknown) => {
          if (error instanceof TsfgaError) return "refused";
          throw error;
        });
      const openfga = await fgaListObjects(storeId, authorizationModelId, {
        ...params,
      })
        .then((objects) => `answered:${[...objects].sort().join(",")}`)
        .catch(() => "refused");
      return { tsfga, openfga };
    }

    test("every candidate row is unevaluable", async () => {
      const { tsfga, openfga } = await outcomes("strict", undefined);
      expect(tsfga).toBe(openfga);
    });

    /**
     * `c_direct` grants unconditionally and `c_cond` needs a
     * parameter the request never supplies. One object is an
     * answer and one is an error, in the same call.
     */
    test("one candidate is unevaluable, one is not", async () => {
      const { tsfga, openfga } = await outcomes("direct", undefined);
      expect(tsfga).toBe(openfga);
    });

    test("an unevaluable row on the excluded side", async () => {
      const { tsfga, openfga } = await outcomes("guarded", undefined);
      expect(tsfga).toBe(openfga);
    });
  });

  test("the relation configs say what the model says", () => {
    expectConfigsMatchModel("./list-objects-conditions/model.dsl", fixture, {
      coverage: "complete",
    });
  });
});
