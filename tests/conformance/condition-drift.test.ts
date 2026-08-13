import { afterAll, beforeAll, describe, test } from "bun:test";
import {
  type AddTupleRequest,
  type ConditionDefinition,
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
 * A tuple's condition versus the restriction that admits it,
 * ported from OpenFGA's ABAC corpus
 * (`assets/tests/abac_tests.yaml`, v1.18.2):
 *
 * - `pci_` — `prior_conditions_ignored`, stage 1: the restriction
 *   names a *different* condition than the stored row carries, so
 *   the row is inadmissible and is dropped without being
 *   evaluated. It must answer `false` for every context, including
 *   one the row's own condition would have satisfied.
 * - `pcd_` — `prior_conditions_ignored`, stage 2: same condition
 *   *name*, redefined expression. The stored definition wins, so
 *   the answer moves with the definition rather than with the row.
 * - `wwc_` — `wildcard_with_condition`: a bare `user:*` row under a
 *   `user:* with cond` restriction is inadmissible, while a
 *   conditioned one is gated by the condition.
 * - `flt_` — `handles_floats`: `double` coercion at the edges.
 *
 * Rows the restriction no longer admits can only exist by having
 * been written under an earlier model, so `pci_` and `wwc_` write
 * theirs first and narrow afterwards.
 */

const NAMES = ["1", "2", "anne", "jon"] as const;

const uuidMap = new Map<string, string>(
  NAMES.map((name, index) => [
    name,
    `00000000-0000-4000-d44a-${String(index + 1).padStart(12, "0")}`,
  ]),
);

function uuid(name: string): string {
  const id = uuidMap.get(name);
  if (!id) throw new Error(`No UUID for ${name}`);
  return id;
}

const USER = "user_a5";
const ANY_USER = { type: USER, wildcard: true } as const;

const CONDITIONS: ConditionDefinition[] = [
  { name: "oldcondition_a5", expression: "x > 200", parameters: { x: "int" } },
  { name: "newcondition_a5", expression: "x > 200", parameters: { x: "int" } },
  {
    name: "condfloat_a5",
    expression: "x > 0.0",
    parameters: { x: "double" },
  },
  {
    name: "ts_less_than_a5",
    expression: 'ts < timestamp("2023-10-11T10:00:00.000Z")',
    parameters: { ts: "timestamp" },
  },
];

function cfg(
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

function split(ref: string): [string, string] {
  const colon = ref.indexOf(":");
  if (colon < 0) throw new Error(`Not a typed ref: ${ref}`);
  return [ref.slice(0, colon), ref.slice(colon + 1)];
}

function t(
  object: string,
  relation: string,
  user: string,
  conditionName: string | null = null,
): AddTupleRequest {
  const [objectType, objectName] = split(object);
  const [subjectType, subjectRest] = split(user);
  const subjectName = subjectRest;
  return {
    objectType,
    objectId: uuid(objectName),
    relation,
    subjectType,
    subjectId: subjectName === "*" ? "*" : uuid(subjectName),
    subjectRelation: null,
    conditionName,
  };
}

const STAGE0: RelationConfig[] = [
  cfg("pci_document_a5", "viewer", {
    directlyAssignable: [{ type: USER, condition: "oldcondition_a5" }],
  }),
  cfg("pcd_document_a5", "viewer", {
    directlyAssignable: [{ type: USER, condition: "oldcondition_a5" }],
  }),
  cfg("wwc_group_a5", "member", {
    directlyAssignable: [{ type: USER }, ANY_USER],
  }),
  cfg("flt_document_a5", "viewer", {
    directlyAssignable: [{ type: USER, condition: "condfloat_a5" }],
  }),
];

const STAGE1: RelationConfig[] = [
  cfg("pci_document_a5", "viewer", {
    directlyAssignable: [{ type: USER, condition: "newcondition_a5" }],
  }),
  cfg("wwc_group_a5", "member", {
    directlyAssignable: [
      { type: USER },
      { type: USER, wildcard: true, condition: "ts_less_than_a5" },
    ],
  }),
];

const STAGE0_TUPLES: AddTupleRequest[] = [
  t("pci_document_a5:1", "viewer", "user_a5:jon", "oldcondition_a5"),
  t("pcd_document_a5:1", "viewer", "user_a5:jon", "oldcondition_a5"),
  t("wwc_group_a5:1", "member", "user_a5:*"),
  t("flt_document_a5:1", "viewer", "user_a5:jon", "condfloat_a5"),
];

const STAGE1_TUPLES: AddTupleRequest[] = [
  t("wwc_group_a5:2", "member", "user_a5:*", "ts_less_than_a5"),
];

function asFga(tuple: AddTupleRequest) {
  return {
    user: `${tuple.subjectType}:${tuple.subjectId}`,
    relation: tuple.relation,
    object: `${tuple.objectType}:${tuple.objectId}`,
    ...(tuple.conditionName
      ? { condition: { name: tuple.conditionName } }
      : {}),
  };
}

describe("A5 condition drift against its restriction (upstream corpus)", () => {
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

    for (const condition of CONDITIONS) {
      await tsfgaClient.writeConditionDefinition(condition);
    }
    for (const config of STAGE0) {
      await tsfgaClient.writeRelationConfig(config);
    }
    for (const tuple of STAGE0_TUPLES) {
      await tsfgaClient.addTuple(tuple);
    }
    for (const config of STAGE1) {
      await tsfgaClient.writeRelationConfig(config);
    }
    for (const tuple of STAGE1_TUPLES) {
      await tsfgaClient.addTuple(tuple);
    }

    storeId = await fgaCreateStore("condition-drift");
    const stage0ModelId = await fgaWriteModel(
      storeId,
      "./condition-drift/model-stage0.dsl",
    );
    await fgaWriteTuplesRaw(storeId, stage0ModelId, STAGE0_TUPLES.map(asFga));
    authorizationModelId = await fgaWriteModel(
      storeId,
      "./condition-drift/model.dsl",
    );
    await fgaWriteTuplesRaw(
      storeId,
      authorizationModelId,
      STAGE1_TUPLES.map(asFga),
    );
  });

  afterAll(async () => {
    await rollbackTransaction(db);
    await destroyDb();
  });

  function checks(
    label: string,
    rows: ReadonlyArray<
      [string, string, string, Record<string, unknown>, CheckOutcome]
    >,
  ): void {
    for (const [object, relation, subject, context, expected] of rows) {
      test(`${label}: ${subject} ${relation} ${object} ${JSON.stringify(context)} is ${expected}`, async () => {
        const [objectType, objectName] = split(object);
        const [subjectType, subjectName] = split(subject);
        await expectConformance(
          storeId,
          authorizationModelId,
          tsfgaClient,
          {
            objectType,
            objectId: uuid(objectName),
            relation,
            subjectType,
            subjectId: uuid(subjectName),
            context,
          },
          expected,
        );
      });
    }
  }

  checks("prior_conditions_ignored (renamed condition)", [
    ["pci_document_a5:1", "viewer", "user_a5:jon", { x: 101 }, false],
    ["pci_document_a5:1", "viewer", "user_a5:jon", { x: 201 }, false],
  ]);

  checks("prior_conditions_ignored (redefined expression)", [
    ["pcd_document_a5:1", "viewer", "user_a5:jon", { x: 101 }, false],
    ["pcd_document_a5:1", "viewer", "user_a5:jon", { x: 201 }, true],
  ]);

  checks("wildcard_with_condition", [
    [
      "wwc_group_a5:1",
      "member",
      "user_a5:anne",
      { ts: "2023-10-11T09:00:00.000Z" },
      false,
    ],
    [
      "wwc_group_a5:2",
      "member",
      "user_a5:anne",
      { ts: "2023-10-11T09:00:00.000Z" },
      true,
    ],
    [
      "wwc_group_a5:2",
      "member",
      "user_a5:anne",
      { ts: "2023-10-11T11:00:00.000Z" },
      false,
    ],
  ]);

  checks("handles_floats", [
    [
      "flt_document_a5:1",
      "viewer",
      "user_a5:jon",
      { x: 1.7976931348623157 },
      true,
    ],
    [
      "flt_document_a5:1",
      "viewer",
      "user_a5:jon",
      { x: -1.7976931348623157 },
      false,
    ],
    [
      "flt_document_a5:1",
      "viewer",
      "user_a5:jon",
      { x: "1.79769313486231570814527423731704356798070e+309" },
      "refused",
    ],
    [
      "flt_document_a5:1",
      "viewer",
      "user_a5:jon",
      { x: "-1.79769313486231570814527423731704356798070e+309" },
      "refused",
    ],
  ]);

  test("the relation configs say what the model says", () => {
    expectConfigsMatchModel("./condition-drift/model.dsl", fixture, {
      coverage: "complete",
    });
  });
});
