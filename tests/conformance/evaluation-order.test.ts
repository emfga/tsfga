import { afterAll, beforeAll, describe, test } from "bun:test";
import {
  type AddTupleRequest,
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
 * Evaluation order, where an errored branch and a deciding branch
 * are siblings.
 *
 * A condition whose parameter the request does not supply is a
 * refusal on both engines when it is the only row, and must lose
 * to a sibling that decides. Which sibling *lands first* is what
 * the concurrency limits change, so every cell runs at breadth 1,
 * at the default, and unbounded: an answer that moves between
 * them is a limit deciding a boolean, which is the bug this file
 * exists to find.
 *
 * The wide object `dw` puts the deciding row thirteenth of
 * thirteen, past the default breadth of 10, so at the default it
 * is not even launched until twelve errors are already in hand.
 */

const USER = "user_d5o";
const GROUP = "group_d5o";
const DOC = "doc_d5o";
const CONDITION = "need_ctx_d5";

const ALICE = "00000000-0000-4000-d560-000000030001";
const G_OK = "00000000-0000-4000-d560-000000030002";
const G_BAD = "00000000-0000-4000-d560-000000030003";
const DM = "00000000-0000-4000-d560-000000030004";
const DE = "00000000-0000-4000-d560-000000030005";
const DW = "00000000-0000-4000-d560-000000030006";
const DBLOCK = "00000000-0000-4000-d560-000000030007";

/** The twelve groups whose rows on `dw` can only error. */
const WIDE = Array.from(
  { length: 12 },
  (_unused, index) =>
    `00000000-0000-4000-d560-0000000310${String(index).padStart(2, "0")}`,
);

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

const CONFIGS: RelationConfig[] = [
  config(GROUP, "member", { directlyAssignable: [{ type: USER }] }),
  config(DOC, "ok", {
    directlyAssignable: [{ type: GROUP, relation: "member" }],
  }),
  config(DOC, "mix", {
    directlyAssignable: [
      { type: GROUP, relation: "member" },
      { type: GROUP, relation: "member", condition: CONDITION },
    ],
  }),
  config(DOC, "blocker", { directlyAssignable: [{ type: USER }] }),
  config(DOC, "guarded", { computedUserset: "mix", excludedBy: "blocker" }),
  config(DOC, "both", {
    intersection: [
      { type: "computedUserset", relation: "mix" },
      { type: "computedUserset", relation: "ok" },
    ],
  }),
];

/** `group#member` on `object`, optionally under the condition. */
function usersetRow(
  object: string,
  relation: string,
  group: string,
  conditioned: boolean,
): AddTupleRequest {
  return {
    objectType: DOC,
    objectId: object,
    relation,
    subjectType: GROUP,
    subjectId: group,
    subjectRelation: "member",
    ...(conditioned ? { conditionName: CONDITION } : {}),
  };
}

const TUPLES: AddTupleRequest[] = [
  {
    objectType: GROUP,
    objectId: G_OK,
    relation: "member",
    subjectType: USER,
    subjectId: ALICE,
  },
  {
    objectType: GROUP,
    objectId: G_BAD,
    relation: "member",
    subjectType: USER,
    subjectId: ALICE,
  },
  ...WIDE.map((group) => ({
    objectType: GROUP,
    objectId: group,
    relation: "member",
    subjectType: USER,
    subjectId: ALICE,
  })),

  // dm: one row that errors, one that grants, in that order.
  usersetRow(DM, "mix", G_BAD, true),
  usersetRow(DM, "mix", G_OK, false),
  usersetRow(DM, "ok", G_OK, false),

  // de: only the row that errors.
  usersetRow(DE, "mix", G_BAD, true),

  // dw: twelve rows that error, then one that grants.
  ...WIDE.map((group) => usersetRow(DW, "mix", group, true)),
  usersetRow(DW, "mix", G_OK, false),

  // db: the row that errors, plus a block on the subject.
  usersetRow(DBLOCK, "mix", G_BAD, true),
  {
    objectType: DOC,
    objectId: DBLOCK,
    relation: "blocker",
    subjectType: USER,
    subjectId: ALICE,
  },
];

interface Case {
  readonly name: string;
  readonly request: CheckRequest;
  readonly expected: CheckOutcome;
}

function ask(
  object: string,
  label: string,
  relation: string,
  expected: CheckOutcome,
  context?: Record<string, unknown>,
): Case {
  return {
    name: `${relation} on ${label}${context ? " with the parameter" : ""}`,
    request: {
      objectType: DOC,
      objectId: object,
      relation,
      subjectType: USER,
      subjectId: ALICE,
      ...(context ? { context } : {}),
    },
    expected,
  };
}

const SUPPLIED = { required: "yes" };
const WRONG = { required: "no" };

const CASES: Case[] = [
  // A sibling that grants beats a sibling whose condition cannot
  // be evaluated, in the same read.
  ask(DM, "dm", "mix", true),
  ask(DW, "dw", "mix", true),
  // Alone, the unevaluable row refuses.
  ask(DE, "de", "mix", "refused"),
  // Supplying the parameter removes the error everywhere.
  ask(DE, "de", "mix", true, SUPPLIED),
  ask(DM, "dm", "mix", true, SUPPLIED),
  ask(DW, "dw", "mix", true, SUPPLIED),
  // A parameter that evaluates false is a denial, not an error.
  ask(DE, "de", "mix", false, WRONG),
  ask(DM, "dm", "mix", true, WRONG),
  ask(DW, "dw", "mix", true, WRONG),

  // Exclusion over the same shapes.
  ask(DM, "dm", "guarded", true),
  ask(DE, "de", "guarded", "refused"),
  ask(DE, "de", "guarded", false, WRONG),
  // A granted exclusion branch denies even though the base errored.
  ask(DBLOCK, "db", "guarded", false),
  ask(DW, "dw", "guarded", true),

  // Intersection over the same shapes.
  ask(DM, "dm", "both", true),
  // `ok` is definitively false, which must short-circuit past the
  // errored `mix` operand rather than propagate it.
  ask(DE, "de", "both", false),
  ask(DW, "dw", "both", false),
  ask(DE, "de", "both", false, SUPPLIED),
];

describe("D5 evaluation order under an errored sibling", () => {
  let db: Kysely<DB>;
  let storeId: string;
  let authorizationModelId: string;
  let fixture: FixtureRecord;
  let narrow: TsfgaClient;
  let standard: TsfgaClient;
  let wide: TsfgaClient;

  beforeAll(async () => {
    db = getDb();
    await beginTransaction(db);

    const store = new KyselyTupleStore(db);
    standard = createTsfga(store);
    fixture = recordFixture(standard);
    narrow = createTsfga(store, { maxBreadth: 1, maxConcurrentChecks: 1 });
    wide = createTsfga(store, {
      maxBreadth: Number.POSITIVE_INFINITY,
      maxConcurrentChecks: Number.POSITIVE_INFINITY,
    });

    await standard.writeConditionDefinition({
      name: CONDITION,
      expression: 'required == "yes"',
      parameters: { required: "string" },
    });
    for (const relationConfig of CONFIGS) {
      await standard.writeRelationConfig(relationConfig);
    }
    for (const tuple of TUPLES) {
      await standard.addTuple(tuple);
    }

    storeId = await fgaCreateStore("evaluation-order");
    authorizationModelId = await fgaWriteModel(
      storeId,
      "./evaluation-order/model.dsl",
    );
    await fgaWriteTuplesRaw(
      storeId,
      authorizationModelId,
      TUPLES.map((tuple) => ({
        user: tuple.subjectRelation
          ? `${tuple.subjectType}:${tuple.subjectId}#${tuple.subjectRelation}`
          : `${tuple.subjectType}:${tuple.subjectId}`,
        relation: tuple.relation,
        object: `${tuple.objectType}:${tuple.objectId}`,
        ...(tuple.conditionName
          ? { condition: { name: tuple.conditionName } }
          : {}),
      })),
    );
  });

  afterAll(async () => {
    await rollbackTransaction(db);
    await destroyDb();
  });

  for (const testCase of CASES) {
    test(`${testCase.name} is ${testCase.expected}`, async () => {
      for (const client of [narrow, standard, wide]) {
        await expectConformance(
          storeId,
          authorizationModelId,
          client,
          testCase.request,
          testCase.expected,
        );
      }
    });
  }

  test("the relation configs say what the model says", () => {
    expectConfigsMatchModel("./evaluation-order/model.dsl", fixture, {
      coverage: "complete",
    });
  });
});
