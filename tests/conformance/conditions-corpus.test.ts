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
 * Conditions on every edge kind, ported from OpenFGA's ABAC
 * corpus (`assets/tests/abac_tests.yaml`, v1.18.2). One type
 * namespace per upstream case:
 *
 * - `dci_`   — `direct_relations_with_condition_through_intersection`
 * - `swc_`   — `simple_userset_with_and_without_condition_in_child`
 * - `stm_`   — `simple_ttu_with_multiple_conditions`
 * - `facet_` — `condition_bound_to_correct_type_restriction_facet`
 * - `tmp_`   — `ttu_mixed_parents_public_wildcard`
 *
 * Upstream's `errorCode: 2000` rows are transcribed as
 * `"refused"`: a context that does not carry a declared parameter
 * is a request neither engine answers.
 */

const NAMES = [
  "1",
  "2",
  "3",
  "a",
  "public",
  "withoutcond",
  "eng",
  "jon",
  "bob",
  "alice",
  "anne",
  "charlie",
  "daemon",
  "elle",
  "with-xcond",
  "with-ycond",
] as const;

const uuidMap = new Map<string, string>(
  NAMES.map((name, index) => [
    name,
    `00000000-0000-4000-d445-${String(index + 1).padStart(12, "0")}`,
  ]),
);

function uuid(name: string): string {
  const id = uuidMap.get(name);
  if (!id) throw new Error(`No UUID for ${name}`);
  return id;
}

const USER = "user_a5";

const EARLY = { ts: "2023-10-11T09:00:00.000Z" };
const LATE = { ts: "2023-10-11T11:00:00.000Z" };

const CONDITIONS: ConditionDefinition[] = [
  { name: "condx_a5", expression: "x < 100", parameters: { x: "int" } },
  { name: "condy_a5", expression: "y < 50", parameters: { y: "int" } },
  { name: "xcond_a5", expression: "x == 10", parameters: { x: "int" } },
  { name: "ycond_a5", expression: "y == 10", parameters: { y: "int" } },
  { name: "is_ok_a5", expression: "ok", parameters: { ok: "bool" } },
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
  const hash = subjectRest.indexOf("#");
  const subjectName = hash < 0 ? subjectRest : subjectRest.slice(0, hash);
  return {
    objectType,
    objectId: uuid(objectName),
    relation,
    subjectType,
    subjectId: subjectName === "*" ? "*" : uuid(subjectName),
    subjectRelation: hash < 0 ? null : subjectRest.slice(hash + 1),
    conditionName,
  };
}

const CONFIGS: RelationConfig[] = [
  cfg("dci_document_a5", "allowed", {
    directlyAssignable: [{ type: USER, condition: "condx_a5" }],
  }),
  cfg("dci_document_a5", "viewer", {
    directlyAssignable: [{ type: USER, condition: "condy_a5" }],
    intersection: [
      { type: "direct" },
      { type: "computedUserset", relation: "allowed" },
    ],
  }),

  cfg("swc_folder_a5", "viewer", {
    directlyAssignable: [{ type: USER, condition: "xcond_a5" }, { type: USER }],
  }),
  cfg("swc_document_a5", "viewer", {
    directlyAssignable: [{ type: "swc_folder_a5", relation: "viewer" }],
  }),

  cfg("stm_folder_a5", "viewer", {
    directlyAssignable: [
      { type: USER, condition: "xcond_a5" },
      { type: USER, condition: "ycond_a5" },
    ],
  }),
  cfg("stm_document_a5", "parent", {
    directlyAssignable: [{ type: "stm_folder_a5" }],
  }),
  cfg("stm_document_a5", "viewer", {
    tupleToUserset: [{ tupleset: "parent", computedUserset: "viewer" }],
  }),

  cfg("facet_group_a5", "member", { directlyAssignable: [{ type: USER }] }),
  cfg("facet_document_a5", "concrete_cond", {
    directlyAssignable: [
      { type: USER, condition: "is_ok_a5" },
      { type: USER, wildcard: true },
    ],
  }),
  cfg("facet_document_a5", "wildcard_cond", {
    directlyAssignable: [
      { type: USER },
      { type: USER, wildcard: true, condition: "is_ok_a5" },
    ],
  }),
  cfg("facet_document_a5", "userset_cond", {
    directlyAssignable: [
      { type: USER },
      {
        type: "facet_group_a5",
        relation: "member",
        condition: "is_ok_a5",
      },
    ],
  }),

  cfg("tmp_group1_a5", "member", {
    directlyAssignable: [
      { type: USER, condition: "ts_less_than_a5" },
      { type: USER, wildcard: true, condition: "ts_less_than_a5" },
    ],
  }),
  cfg("tmp_group2_a5", "member", { directlyAssignable: [{ type: USER }] }),
  cfg("tmp_folder_a5", "viewer", {
    directlyAssignable: [
      { type: USER },
      { type: "tmp_group1_a5", relation: "member" },
      { type: "tmp_group2_a5", relation: "member" },
    ],
  }),
  cfg("tmp_document_a5", "parent", {
    directlyAssignable: [{ type: "tmp_folder_a5" }],
  }),
  cfg("tmp_document_a5", "viewer", {
    tupleToUserset: [{ tupleset: "parent", computedUserset: "viewer" }],
  }),
];

const TUPLES: AddTupleRequest[] = [
  t("dci_document_a5:1", "viewer", "user_a5:jon", "condy_a5"),
  t("dci_document_a5:1", "allowed", "user_a5:jon", "condx_a5"),

  t("swc_document_a5:1", "viewer", "swc_folder_a5:a#viewer"),
  t("swc_folder_a5:a", "viewer", "user_a5:jon", "xcond_a5"),
  t("swc_document_a5:2", "viewer", "swc_folder_a5:withoutcond#viewer"),
  t("swc_folder_a5:withoutcond", "viewer", "user_a5:bob"),

  t("stm_document_a5:1", "parent", "stm_folder_a5:a"),
  t("stm_folder_a5:a", "viewer", "user_a5:with-xcond", "xcond_a5"),
  t("stm_folder_a5:a", "viewer", "user_a5:with-ycond", "ycond_a5"),

  t("facet_document_a5:1", "concrete_cond", "user_a5:alice", "is_ok_a5"),
  t("facet_document_a5:1", "wildcard_cond", "user_a5:*", "is_ok_a5"),
  t(
    "facet_document_a5:1",
    "userset_cond",
    "facet_group_a5:eng#member",
    "is_ok_a5",
  ),
  // Derived: upstream writes no membership, so `userset_cond` is
  // never exercised past the row itself.
  t("facet_group_a5:eng", "member", "user_a5:alice"),

  t("tmp_group1_a5:1", "member", "user_a5:anne", "ts_less_than_a5"),
  t("tmp_group2_a5:1", "member", "user_a5:anne"),
  t("tmp_group1_a5:1", "member", "user_a5:bob", "ts_less_than_a5"),
  t("tmp_group2_a5:1", "member", "user_a5:charlie"),
  t("tmp_folder_a5:a", "viewer", "tmp_group1_a5:1#member"),
  t("tmp_folder_a5:a", "viewer", "tmp_group2_a5:1#member"),
  t("tmp_folder_a5:a", "viewer", "user_a5:daemon"),
  t("tmp_document_a5:a", "parent", "tmp_folder_a5:a"),
  t("tmp_group2_a5:3", "member", "user_a5:elle"),
  t("tmp_group1_a5:public", "member", "user_a5:*", "ts_less_than_a5"),
  t("tmp_folder_a5:public", "viewer", "tmp_group1_a5:public#member"),
  t("tmp_document_a5:public", "parent", "tmp_folder_a5:public"),
];

describe("A5 conditions on every edge kind (upstream corpus)", () => {
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
    for (const config of CONFIGS) {
      await tsfgaClient.writeRelationConfig(config);
    }
    for (const tuple of TUPLES) {
      await tsfgaClient.addTuple(tuple);
    }

    storeId = await fgaCreateStore("conditions-corpus");
    authorizationModelId = await fgaWriteModel(
      storeId,
      "./conditions-corpus/model.dsl",
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

  /** `[object, relation, subject, context, expected]`. */
  function checks(
    label: string,
    rows: ReadonlyArray<
      [string, string, string, Record<string, unknown> | null, CheckOutcome]
    >,
  ): void {
    for (const [object, relation, subject, context, expected] of rows) {
      const shown = context ? JSON.stringify(context) : "no context";
      test(`${label}: ${subject} ${relation} ${object} ${shown} is ${expected}`, async () => {
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
            ...(context ? { context } : {}),
          },
          expected,
        );
      });
    }
  }

  checks("direct_relations_with_condition_through_intersection", [
    ["dci_document_a5:1", "viewer", "user_a5:jon", { x: 10, y: 5 }, true],
    ["dci_document_a5:1", "viewer", "user_a5:jon", { x: 101, y: 5 }, false],
  ]);

  checks("simple_userset_with_and_without_condition_in_child", [
    ["swc_document_a5:1", "viewer", "user_a5:jon", null, "refused"],
    ["swc_document_a5:1", "viewer", "user_a5:jon", { x: 10 }, true],
    ["swc_document_a5:2", "viewer", "user_a5:jon", { x: 10 }, false],
    ["swc_document_a5:1", "viewer", "user_a5:jon", { x: 20 }, false],
    ["swc_document_a5:2", "viewer", "user_a5:bob", null, true],
    ["swc_document_a5:1", "viewer", "user_a5:bob", null, false],
  ]);

  checks("simple_ttu_with_multiple_conditions", [
    ["stm_document_a5:1", "viewer", "user_a5:with-xcond", null, "refused"],
    ["stm_document_a5:1", "viewer", "user_a5:with-ycond", null, "refused"],
    ["stm_document_a5:1", "viewer", "user_a5:with-xcond", { x: 10 }, true],
    ["stm_document_a5:1", "viewer", "user_a5:with-xcond", { x: 99 }, false],
    ["stm_document_a5:1", "viewer", "user_a5:with-ycond", { y: 10 }, true],
    ["stm_document_a5:1", "viewer", "user_a5:with-ycond", { y: 99 }, false],
    ["stm_document_a5:1", "viewer", "user_a5:with-xcond", { y: 10 }, "refused"],
    ["stm_document_a5:1", "viewer", "user_a5:with-ycond", { x: 10 }, "refused"],
  ]);

  checks("condition_bound_to_correct_type_restriction_facet", [
    [
      "facet_document_a5:1",
      "concrete_cond",
      "user_a5:alice",
      { ok: true },
      true,
    ],
    [
      "facet_document_a5:1",
      "concrete_cond",
      "user_a5:alice",
      { ok: false },
      false,
    ],
    ["facet_document_a5:1", "wildcard_cond", "user_a5:bob", { ok: true }, true],
    [
      "facet_document_a5:1",
      "wildcard_cond",
      "user_a5:bob",
      { ok: false },
      false,
    ],
    // Derived: the condition sits on the userset facet, so it
    // gates the expansion rather than the membership.
    [
      "facet_document_a5:1",
      "userset_cond",
      "user_a5:alice",
      { ok: true },
      true,
    ],
    [
      "facet_document_a5:1",
      "userset_cond",
      "user_a5:alice",
      { ok: false },
      false,
    ],
    ["facet_document_a5:1", "userset_cond", "user_a5:bob", { ok: true }, false],
  ]);

  checks("ttu_mixed_parents_public_wildcard", [
    ["tmp_document_a5:a", "viewer", "user_a5:anne", EARLY, true],
    ["tmp_document_a5:a", "viewer", "user_a5:anne", LATE, true],
    ["tmp_document_a5:public", "viewer", "user_a5:anne", EARLY, true],
    ["tmp_document_a5:public", "viewer", "user_a5:anne", LATE, false],
    ["tmp_document_a5:a", "viewer", "user_a5:bob", EARLY, true],
    ["tmp_document_a5:a", "viewer", "user_a5:bob", LATE, false],
    ["tmp_document_a5:public", "viewer", "user_a5:bob", EARLY, true],
    ["tmp_document_a5:public", "viewer", "user_a5:bob", LATE, false],
    ["tmp_document_a5:a", "viewer", "user_a5:charlie", null, true],
    ["tmp_document_a5:a", "viewer", "user_a5:charlie", EARLY, true],
    ["tmp_document_a5:a", "viewer", "user_a5:charlie", LATE, true],
    ["tmp_document_a5:public", "viewer", "user_a5:charlie", EARLY, true],
    ["tmp_document_a5:public", "viewer", "user_a5:charlie", LATE, false],
    ["tmp_document_a5:a", "viewer", "user_a5:daemon", null, true],
    ["tmp_document_a5:public", "viewer", "user_a5:daemon", EARLY, true],
    ["tmp_document_a5:a", "viewer", "user_a5:elle", EARLY, false],
    ["tmp_document_a5:public", "viewer", "user_a5:elle", EARLY, true],
  ]);

  test("the relation configs say what the model says", () => {
    expectConfigsMatchModel("./conditions-corpus/model.dsl", fixture, {
      coverage: "complete",
    });
  });
});
