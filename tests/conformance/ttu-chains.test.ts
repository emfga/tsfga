import { afterAll, beforeAll, describe, test } from "bun:test";
import {
  type AddTupleRequest,
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
 * Tuple-to-userset and userset chaining, ported from OpenFGA's
 * behavioural corpus (`assets/tests/consolidated_1_1_tests.yaml`,
 * v1.18.2). One type namespace per upstream case, so the shapes
 * stay exactly as upstream wrote them:
 *
 * - `tu_` — `ttu_to_userset`
 * - `tt_` — `ttu_to_ttu`
 * - `ut_` — `userset_to_ttu`
 * - `uu_` — `userset_to_userset`
 * - `mt_` — `ttu_multiple_tupleset_types`
 * - `ct_` — `ttu_and_computed_ttu`
 * - `cu_` — `ttu_and_computed_ttu_with_union`
 * - `tc_` — `ttu_ttu_and_computed_ttu`
 * - `nd_` — `relations_not_defined_in_some_child_type_{falsy,truthy}`
 *
 * Every expectation is transcribed from upstream's `expectation:`
 * field.
 */

const NAMES = [
  "1",
  "2",
  "3",
  "a",
  "b",
  "c",
  "d",
  "x",
  "admin",
  "readjobs",
  "fga",
  "jose",
  "anne",
] as const;

const uuidMap = new Map<string, string>(
  NAMES.map((name, index) => [
    name,
    `00000000-0000-4000-d441-${String(index + 1).padStart(12, "0")}`,
  ]),
);

function uuid(name: string): string {
  const id = uuidMap.get(name);
  if (!id) throw new Error(`No UUID for ${name}`);
  return id;
}

const USER = "user_a5";
const EMPLOYEE = "employee_a5";

/** A relation config with every optional arm defaulted to "none". */
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

/**
 * A tuple written as upstream's YAML spells it —
 * `t("tu_job_a5:1", "can_read", "tu_permission_a5:readjobs#assignee")`
 * — so a row can be read against the corpus it came from.
 */
function t(object: string, relation: string, user: string): AddTupleRequest {
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
  };
}

function split(ref: string): [string, string] {
  const colon = ref.indexOf(":");
  if (colon < 0) throw new Error(`Not a typed ref: ${ref}`);
  return [ref.slice(0, colon), ref.slice(colon + 1)];
}

const CONFIGS: RelationConfig[] = [
  // ttu_to_userset
  cfg("tu_role_a5", "assignee", { directlyAssignable: [{ type: USER }] }),
  cfg("tu_permission_a5", "role", {
    directlyAssignable: [{ type: "tu_role_a5" }],
  }),
  cfg("tu_permission_a5", "assignee", {
    tupleToUserset: [{ tupleset: "role", computedUserset: "assignee" }],
  }),
  cfg("tu_job_a5", "can_read", {
    directlyAssignable: [{ type: "tu_permission_a5", relation: "assignee" }],
  }),
  cfg("tu_job_a5", "cannot_read", {
    directlyAssignable: [{ type: USER }],
    excludedBy: "can_read",
  }),

  // ttu_to_ttu
  cfg("tt_role_a5", "assignee", { directlyAssignable: [{ type: USER }] }),
  cfg("tt_permission_a5", "role", {
    directlyAssignable: [{ type: "tt_role_a5" }],
  }),
  cfg("tt_permission_a5", "assignee", {
    tupleToUserset: [{ tupleset: "role", computedUserset: "assignee" }],
  }),
  cfg("tt_job_a5", "permission", {
    directlyAssignable: [{ type: "tt_permission_a5" }],
  }),
  cfg("tt_job_a5", "can_read", {
    tupleToUserset: [{ tupleset: "permission", computedUserset: "assignee" }],
  }),
  cfg("tt_job_a5", "cannot_read", {
    directlyAssignable: [{ type: USER }],
    excludedBy: "can_read",
  }),

  // userset_to_ttu
  cfg("ut_role_a5", "assignee", { directlyAssignable: [{ type: USER }] }),
  cfg("ut_permission_a5", "assignee", {
    directlyAssignable: [{ type: "ut_role_a5", relation: "assignee" }],
  }),
  cfg("ut_job_a5", "permission", {
    directlyAssignable: [{ type: "ut_permission_a5" }],
  }),
  cfg("ut_job_a5", "can_read", {
    tupleToUserset: [{ tupleset: "permission", computedUserset: "assignee" }],
  }),
  cfg("ut_job_a5", "cannot_read", {
    directlyAssignable: [{ type: USER }],
    excludedBy: "can_read",
  }),

  // userset_to_userset
  cfg("uu_role_a5", "assignee", { directlyAssignable: [{ type: USER }] }),
  cfg("uu_permission_a5", "assignee", {
    directlyAssignable: [{ type: "uu_role_a5", relation: "assignee" }],
  }),
  cfg("uu_job_a5", "can_read", {
    directlyAssignable: [{ type: "uu_permission_a5", relation: "assignee" }],
  }),
  cfg("uu_job_a5", "cannot_read", {
    directlyAssignable: [{ type: USER }],
    excludedBy: "can_read",
  }),

  // ttu_multiple_tupleset_types
  cfg("mt_group_a5", "can_view", { directlyAssignable: [{ type: EMPLOYEE }] }),
  cfg("mt_folder_a5", "can_view", { directlyAssignable: [{ type: USER }] }),
  cfg("mt_document_a5", "parent", {
    directlyAssignable: [
      { type: EMPLOYEE },
      { type: "mt_group_a5" },
      { type: "mt_folder_a5" },
    ],
  }),
  cfg("mt_document_a5", "viewer", {
    tupleToUserset: [{ tupleset: "parent", computedUserset: "can_view" }],
  }),

  // ttu_and_computed_ttu
  cfg("ct_folder_a5", "owner", { directlyAssignable: [{ type: USER }] }),
  cfg("ct_folder_a5", "viewer", { computedUserset: "owner" }),
  cfg("ct_document_a5", "parent", {
    directlyAssignable: [{ type: "ct_folder_a5" }],
  }),
  cfg("ct_document_a5", "can_view", {
    tupleToUserset: [{ tupleset: "parent", computedUserset: "viewer" }],
  }),

  // ttu_and_computed_ttu_with_union
  cfg("cu_group_a5", "member", { directlyAssignable: [{ type: USER }] }),
  cfg("cu_folder_a5", "parent", {
    directlyAssignable: [{ type: "cu_folder_a5" }],
  }),
  cfg("cu_folder_a5", "viewer", {
    directlyAssignable: [{ type: "cu_group_a5", relation: "member" }],
  }),
  cfg("cu_folder_a5", "can_view", {
    impliedBy: ["viewer"],
    tupleToUserset: [{ tupleset: "parent", computedUserset: "can_view" }],
  }),
  cfg("cu_document_a5", "parent", {
    directlyAssignable: [{ type: "cu_folder_a5" }],
  }),
  cfg("cu_document_a5", "viewer", {
    tupleToUserset: [{ tupleset: "parent", computedUserset: "can_view" }],
  }),

  // ttu_ttu_and_computed_ttu
  cfg("tc_group_a5", "member", { directlyAssignable: [{ type: USER }] }),
  cfg("tc_module_a5", "parent", {
    directlyAssignable: [{ type: "tc_module_a5" }],
  }),
  cfg("tc_module_a5", "viewer", {
    directlyAssignable: [{ type: "tc_group_a5", relation: "member" }],
  }),
  cfg("tc_module_a5", "can_view", {
    impliedBy: ["viewer"],
    tupleToUserset: [{ tupleset: "parent", computedUserset: "can_view" }],
  }),
  cfg("tc_folder_a5", "parent", {
    directlyAssignable: [{ type: "tc_module_a5" }, { type: "tc_folder_a5" }],
  }),
  cfg("tc_folder_a5", "can_view", {
    tupleToUserset: [{ tupleset: "parent", computedUserset: "can_view" }],
  }),
  cfg("tc_document_a5", "parent", {
    directlyAssignable: [{ type: "tc_folder_a5" }],
  }),
  cfg("tc_document_a5", "viewer", {
    tupleToUserset: [{ tupleset: "parent", computedUserset: "can_view" }],
  }),

  // relations_not_defined_in_some_child_type
  cfg("nd_folder2_a5", "viewer", { directlyAssignable: [{ type: USER }] }),
  cfg("nd_document_a5", "parent", {
    directlyAssignable: [{ type: "nd_folder1_a5" }, { type: "nd_folder2_a5" }],
  }),
  cfg("nd_document_a5", "viewer", {
    tupleToUserset: [{ tupleset: "parent", computedUserset: "viewer" }],
  }),
];

const TUPLES: AddTupleRequest[] = [
  // ttu_to_userset
  t("tu_role_a5:admin", "assignee", "user_a5:1"),
  t("tu_permission_a5:readjobs", "role", "tu_role_a5:admin"),
  t("tu_job_a5:1", "can_read", "tu_permission_a5:readjobs#assignee"),
  t("tu_job_a5:1", "cannot_read", "user_a5:1"),

  // ttu_to_ttu
  t("tt_role_a5:admin", "assignee", "user_a5:1"),
  t("tt_permission_a5:readjobs", "role", "tt_role_a5:admin"),
  t("tt_job_a5:1", "permission", "tt_permission_a5:readjobs"),
  t("tt_job_a5:1", "cannot_read", "user_a5:1"),

  // userset_to_ttu
  t("ut_role_a5:admin", "assignee", "user_a5:1"),
  t("ut_permission_a5:readjobs", "assignee", "ut_role_a5:admin#assignee"),
  t("ut_job_a5:1", "permission", "ut_permission_a5:readjobs"),
  t("ut_job_a5:1", "cannot_read", "user_a5:1"),

  // userset_to_userset
  t("uu_role_a5:admin", "assignee", "user_a5:1"),
  t("uu_permission_a5:readjobs", "assignee", "uu_role_a5:admin#assignee"),
  t("uu_job_a5:1", "can_read", "uu_permission_a5:readjobs#assignee"),
  t("uu_job_a5:1", "cannot_read", "user_a5:1"),

  // ttu_multiple_tupleset_types
  t("mt_group_a5:1", "can_view", "employee_a5:1"),
  t("mt_document_a5:1", "parent", "mt_group_a5:1"),
  t("mt_folder_a5:1", "can_view", "user_a5:1"),
  t("mt_document_a5:1", "parent", "mt_folder_a5:1"),

  // ttu_and_computed_ttu
  t("ct_document_a5:1", "parent", "ct_folder_a5:1"),
  t("ct_folder_a5:1", "owner", "user_a5:jose"),

  // ttu_and_computed_ttu_with_union
  t("cu_group_a5:fga", "member", "user_a5:anne"),
  t("cu_folder_a5:a", "viewer", "cu_group_a5:fga#member"),
  t("cu_folder_a5:b", "parent", "cu_folder_a5:a"),
  t("cu_document_a5:b", "parent", "cu_folder_a5:a"),

  // ttu_ttu_and_computed_ttu
  t("tc_group_a5:fga", "member", "user_a5:anne"),
  t("tc_module_a5:a", "viewer", "tc_group_a5:fga#member"),
  t("tc_folder_a5:a", "parent", "tc_module_a5:a"),
  t("tc_folder_a5:b", "parent", "tc_folder_a5:a"),
  t("tc_document_a5:b", "parent", "tc_folder_a5:a"),

  // relations_not_defined_in_some_child_type_falsy
  t("nd_document_a5:d", "parent", "nd_folder1_a5:x"),
  // relations_not_defined_in_some_child_type_truthy
  t("nd_document_a5:c", "parent", "nd_folder2_a5:x"),
  t("nd_folder2_a5:x", "viewer", "user_a5:anne"),
];

describe("A5 TTU and userset chaining (upstream corpus)", () => {
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

    for (const config of CONFIGS) {
      await tsfgaClient.writeRelationConfig(config);
    }
    for (const tuple of TUPLES) {
      await tsfgaClient.addTuple(tuple);
    }

    storeId = await fgaCreateStore("ttu-chains");
    authorizationModelId = await fgaWriteModel(
      storeId,
      "./ttu-chains/model.dsl",
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
      })),
    );
  });

  afterAll(async () => {
    await rollbackTransaction(db);
    await destroyDb();
  });

  /** `[object, relation, subject, expected]`, refs as upstream writes them. */
  function checks(
    label: string,
    rows: ReadonlyArray<[string, string, string, CheckOutcome]>,
  ): void {
    for (const [object, relation, subject, expected] of rows) {
      test(`${label}: ${subject} ${relation} ${object} is ${expected}`, async () => {
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
          },
          expected,
        );
      });
    }
  }

  describe("ttu_to_userset", () => {
    checks("ttu_to_userset", [
      ["tu_job_a5:1", "cannot_read", "user_a5:1", false],
      ["tu_job_a5:1", "can_read", "user_a5:1", true],
    ]);
  });

  describe("ttu_to_ttu", () => {
    checks("ttu_to_ttu", [
      ["tt_job_a5:1", "cannot_read", "user_a5:1", false],
      ["tt_job_a5:1", "can_read", "user_a5:1", true],
    ]);
  });

  describe("userset_to_ttu", () => {
    checks("userset_to_ttu", [
      ["ut_job_a5:1", "can_read", "user_a5:1", true],
      ["ut_permission_a5:readjobs", "assignee", "user_a5:1", true],
      ["ut_job_a5:1", "cannot_read", "user_a5:1", false],
    ]);
  });

  describe("userset_to_userset", () => {
    checks("userset_to_userset", [
      ["uu_job_a5:1", "can_read", "user_a5:1", true],
      ["uu_permission_a5:readjobs", "assignee", "user_a5:1", true],
      ["uu_job_a5:1", "cannot_read", "user_a5:1", false],
    ]);
  });

  describe("ttu_multiple_tupleset_types", () => {
    checks("ttu_multiple_tupleset_types", [
      ["mt_document_a5:1", "viewer", "employee_a5:1", true],
      ["mt_document_a5:1", "viewer", "user_a5:1", true],
    ]);
  });

  describe("ttu_and_computed_ttu", () => {
    checks("ttu_and_computed_ttu", [
      ["ct_document_a5:1", "can_view", "user_a5:jose", true],
    ]);
  });

  describe("ttu_and_computed_ttu_with_union", () => {
    checks("ttu_and_computed_ttu_with_union", [
      ["cu_folder_a5:a", "can_view", "user_a5:anne", true],
      ["cu_folder_a5:b", "can_view", "user_a5:anne", true],
      ["cu_document_a5:b", "viewer", "user_a5:anne", true],
    ]);
  });

  describe("ttu_ttu_and_computed_ttu", () => {
    checks("ttu_ttu_and_computed_ttu", [
      ["tc_folder_a5:a", "can_view", "user_a5:anne", true],
      ["tc_folder_a5:b", "can_view", "user_a5:anne", true],
      ["tc_document_a5:b", "viewer", "user_a5:anne", true],
    ]);
  });

  describe("relations_not_defined_in_some_child_type", () => {
    checks("falsy", [["nd_document_a5:d", "viewer", "user_a5:anne", false]]);
    checks("truthy", [["nd_document_a5:c", "viewer", "user_a5:anne", true]]);
  });

  test("the relation configs say what the model says", () => {
    expectConfigsMatchModel("./ttu-chains/model.dsl", fixture, {
      coverage: "complete",
    });
  });
});
