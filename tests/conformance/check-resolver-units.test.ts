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
  expectWriteConformance,
  type FixtureRecord,
  recordFixture,
} from "./helpers/conformance.ts";
import {
  beginTransaction,
  destroyDb,
  getDb,
  rollbackTransaction,
} from "./helpers/db.ts";
import { fgaCreateStore, fgaWriteModel } from "./helpers/openfga.ts";

/**
 * Four shapes from `internal/graph/check_test.go` that the
 * integration corpus in `tests/` does not contain.
 *
 * These are unit tests upstream, asserted against the resolver
 * directly, which is why they cover seams the case matrices do
 * not: each one is a model where an arm of an exclusion **errors**
 * or **cycles**, and the assertion is that the check answers
 * `false` rather than raising.
 *
 * - `TestNonStratifiableCheckQueries/example_1` and `example_2`
 *   (`:843-923`). A relation excludes a relation that is defined
 *   in terms of it. The model is non-stratifiable and upstream
 *   still stores it and still answers; `require.False` on both.
 *   `example_2` puts a computed userset between the two, so the
 *   cycle is one hop longer than the exclusion.
 * - `TestResolveCheckDeterministic/exclusion_resolves_-`
 *   `deterministically_1` and `_2` (`:925-1020`). Upstream runs
 *   each 2 000 times and requires the same falsey answer with no
 *   error every time; its own comments state the rule:
 *   *"subtract branch resolves to {allowed: true} even though the
 *   base branch results in an error"* and *"base should resolve to
 *   {allowed: false} even though the subtract branch results in an
 *   error"*. The error is a condition with no context for its `x`
 *   parameter, so neither arm can be evaluated on its own — the
 *   answer comes from the other arm short-circuiting first.
 *
 * The two determinism cases are the sharp ones, because they are
 * the exclusion counterpart of the rule pinned on a union: an error on one arm is discarded when the other arm
 * decides the node. Asserted here in both directions, base and
 * subtract, since only one of the two can be got right by
 * accident.
 */

const JON = "00000000-0000-4000-d540-000000000201";
const MARIA = "00000000-0000-4000-d540-000000000202";
const DOC = "00000000-0000-4000-d540-000000000210";

const plain = {
  impliedBy: null,
  computedUserset: null,
  tupleToUserset: null,
  excludedBy: null,
  intersection: null,
} as const;

function config(
  objectType: string,
  relation: string,
  overrides: Partial<RelationConfig> = {},
): RelationConfig {
  return {
    objectType,
    relation,
    directlyAssignable: [],
    ...plain,
    ...overrides,
  };
}

describe("Resolver unit shapes from internal/graph", () => {
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
      name: "cond_d3u",
      expression: "x < 100",
      parameters: { x: "int" },
    });

    for (const relationConfig of [
      config("doca_d3u", "restricted", {
        directlyAssignable: [
          { type: "user_d3u" },
          { type: "doca_d3u", relation: "viewer" },
        ],
      }),
      config("doca_d3u", "viewer", {
        directlyAssignable: [{ type: "user_d3u" }],
        excludedBy: "restricted",
      }),
      config("docb_d3u", "restrictedb", {
        directlyAssignable: [
          { type: "user_d3u" },
          { type: "docb_d3u", relation: "viewer" },
        ],
      }),
      config("docb_d3u", "restricteda", { computedUserset: "restrictedb" }),
      config("docb_d3u", "viewer", {
        directlyAssignable: [{ type: "user_d3u" }],
        excludedBy: "restricteda",
      }),
      config("docc_d3u", "admin", {
        directlyAssignable: [{ type: "user_d3u", wildcard: true }],
      }),
      config("docc_d3u", "viewer", {
        directlyAssignable: [{ type: "user_d3u", condition: "cond_d3u" }],
        excludedBy: "admin",
      }),
      config("docd_d3u", "admin", {
        directlyAssignable: [{ type: "user_d3u", condition: "cond_d3u" }],
      }),
      config("docd_d3u", "viewer", {
        directlyAssignable: [{ type: "user_d3u" }],
        excludedBy: "admin",
      }),
    ]) {
      await tsfgaClient.writeRelationConfig(relationConfig);
    }

    storeId = await fgaCreateStore("check-resolver-units");
    authorizationModelId = await fgaWriteModel(
      storeId,
      "./check-resolver-units/model.dsl",
    );

    const writes = [
      // example_1
      {
        objectType: "doca_d3u",
        objectId: DOC,
        relation: "viewer",
        subjectType: "user_d3u",
        subjectId: JON,
      },
      {
        objectType: "doca_d3u",
        objectId: DOC,
        relation: "restricted",
        subjectType: "doca_d3u",
        subjectId: DOC,
        subjectRelation: "viewer",
      },
      // example_2
      {
        objectType: "docb_d3u",
        objectId: DOC,
        relation: "viewer",
        subjectType: "user_d3u",
        subjectId: JON,
      },
      {
        objectType: "docb_d3u",
        objectId: DOC,
        relation: "restrictedb",
        subjectType: "docb_d3u",
        subjectId: DOC,
        subjectRelation: "viewer",
      },
      // exclusion_resolves_deterministically_1
      {
        objectType: "docc_d3u",
        objectId: DOC,
        relation: "admin",
        subjectType: "user_d3u",
        subjectId: "*",
      },
      {
        objectType: "docc_d3u",
        objectId: DOC,
        relation: "viewer",
        subjectType: "user_d3u",
        subjectId: MARIA,
        conditionName: "cond_d3u",
      },
      // exclusion_resolves_deterministically_2
      {
        objectType: "docd_d3u",
        objectId: DOC,
        relation: "admin",
        subjectType: "user_d3u",
        subjectId: MARIA,
        conditionName: "cond_d3u",
      },
    ];
    for (const tuple of writes) {
      await expectWriteConformance(
        storeId,
        authorizationModelId,
        tsfgaClient,
        tuple,
        "accepted",
      );
    }
  });

  afterAll(async () => {
    await rollbackTransaction(db);
    await destroyDb();
  });

  test("non-stratifiable example_1: viewer but not restricted", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "doca_d3u",
        objectId: DOC,
        relation: "viewer",
        subjectType: "user_d3u",
        subjectId: JON,
      },
      false,
    );
  });

  test("non-stratifiable example_2: one rewrite further out", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "docb_d3u",
        objectId: DOC,
        relation: "viewer",
        subjectType: "user_d3u",
        subjectId: JON,
      },
      false,
    );
  });

  test("exclusion determinism 1: subtract decides over an erroring base", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "docc_d3u",
        objectId: DOC,
        relation: "viewer",
        subjectType: "user_d3u",
        subjectId: MARIA,
      },
      false,
    );
  });

  test("exclusion determinism 2: base decides over an erroring subtract", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "docd_d3u",
        objectId: DOC,
        relation: "viewer",
        subjectType: "user_d3u",
        subjectId: MARIA,
      },
      false,
    );
  });

  test("control: the same conditions answered with context", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "docd_d3u",
        objectId: DOC,
        relation: "viewer",
        subjectType: "user_d3u",
        subjectId: MARIA,
        context: { x: 2 },
      },
      false,
    );
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "docc_d3u",
        objectId: DOC,
        relation: "viewer",
        subjectType: "user_d3u",
        subjectId: MARIA,
        context: { x: 2 },
      },
      false,
    );
  });

  test("the relation configs say what the model says", () => {
    expectConfigsMatchModel("./check-resolver-units/model.dsl", fixture, {
      coverage: "complete",
    });
  });
});
