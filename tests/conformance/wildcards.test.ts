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
 * Wildcard reach, ported from OpenFGA's behavioural corpus
 * (`assets/tests/consolidated_1_1_tests.yaml`, v1.18.2). One type
 * namespace per upstream case:
 *
 * - `wcu_` — `wildcard_computed_userset`
 * - `wr_`  — `wildcard_and_userset_restriction`
 * - `suo_` — `simple_userset_child_wildcard_only`
 * - `su_`  — `simple_userset_child_wildcard`
 * - `sto_` — `simple_ttu_child_wildcard_only`
 * - `st_`  — `simple_ttu_child_wildcard`
 * - `cp_`  — `combined_public_wildcard_userset`
 * - `w2_`  — `weight_2_more_than_one_userset_assignable`
 * - `w2d_` — `weight_2_two_userset_assignable_diff_types`
 *
 * The recurring question is whether a wildcard on *one* admitted
 * ref leaks into a check for a subject the wildcard's own type
 * restriction does not cover. Every expectation is transcribed
 * from upstream.
 */

const NAMES = [
  "1",
  "2",
  "A",
  "anne",
  "maria",
  "bob",
  "foo",
  "jon",
  "aardvark",
  "jdoe",
  "fga",
  "engineering",
  "superadmin",
  "public",
] as const;

const uuidMap = new Map<string, string>(
  NAMES.map((name, index) => [
    name,
    `00000000-0000-4000-d442-${String(index + 1).padStart(12, "0")}`,
  ]),
);

function uuid(name: string): string {
  const id = uuidMap.get(name);
  if (!id) throw new Error(`No UUID for ${name}`);
  return id;
}

const USER = "user_a5";
const USER2 = "user2_a5";

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

/** `t("wr_document_a5:public", "viewer", "user_a5:*")`. */
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

const ANY_USER = { type: USER, wildcard: true } as const;
const ANY_USER2 = { type: USER2, wildcard: true } as const;

const CONFIGS: RelationConfig[] = [
  cfg("wcu_document_a5", "writer", { directlyAssignable: [ANY_USER] }),
  cfg("wcu_document_a5", "viewer", {
    directlyAssignable: [{ type: USER }],
    impliedBy: ["writer"],
  }),

  cfg("wr_group_a5", "member", { directlyAssignable: [{ type: USER2 }] }),
  cfg("wr_document_a5", "viewer", {
    directlyAssignable: [ANY_USER, { type: "wr_group_a5", relation: "member" }],
  }),

  cfg("suo_group_a5", "member", { directlyAssignable: [ANY_USER, ANY_USER2] }),
  cfg("suo_folder_a5", "viewer", {
    directlyAssignable: [{ type: "suo_group_a5", relation: "member" }],
  }),

  cfg("su_group_a5", "member", {
    directlyAssignable: [{ type: USER }, ANY_USER, { type: USER2 }, ANY_USER2],
  }),
  cfg("su_folder_a5", "viewer", {
    directlyAssignable: [{ type: "su_group_a5", relation: "member" }],
  }),

  cfg("sto_group_a5", "member", { directlyAssignable: [ANY_USER, ANY_USER2] }),
  cfg("sto_folder_a5", "owner", {
    directlyAssignable: [{ type: "sto_group_a5" }],
  }),
  cfg("sto_folder_a5", "viewer", {
    tupleToUserset: [{ tupleset: "owner", computedUserset: "member" }],
  }),

  cfg("st_group_a5", "member", {
    directlyAssignable: [{ type: USER }, ANY_USER, { type: USER2 }, ANY_USER2],
  }),
  cfg("st_folder_a5", "owner", {
    directlyAssignable: [{ type: "st_group_a5" }],
  }),
  cfg("st_folder_a5", "viewer", {
    tupleToUserset: [{ tupleset: "owner", computedUserset: "member" }],
  }),

  cfg("cp_role_a5", "assignee", { directlyAssignable: [{ type: USER }] }),
  cfg("cp_deployment_a5", "can_access", {
    directlyAssignable: [
      ANY_USER,
      { type: "cp_role_a5", relation: "assignee" },
    ],
  }),

  cfg("w2_scope_a5", "public", { directlyAssignable: [ANY_USER] }),
  cfg("w2_scope_a5", "verified", { directlyAssignable: [{ type: USER }] }),
  cfg("w2_resource_a5", "access", {
    directlyAssignable: [
      { type: "w2_scope_a5", relation: "public" },
      { type: "w2_scope_a5", relation: "verified" },
    ],
  }),

  cfg("w2a_scope_a5", "public", { directlyAssignable: [ANY_USER] }),
  cfg("w2b_scope_a5", "verified", { directlyAssignable: [{ type: USER }] }),
  cfg("w2d_resource_a5", "access", {
    directlyAssignable: [
      { type: "w2a_scope_a5", relation: "public" },
      { type: "w2b_scope_a5", relation: "verified" },
    ],
  }),
];

const TUPLES: AddTupleRequest[] = [
  // wildcard_computed_userset
  t("wcu_document_a5:public", "writer", "user_a5:*"),
  t("wcu_document_a5:public", "viewer", "user_a5:jon"),

  // wildcard_and_userset_restriction
  t("wr_document_a5:public", "viewer", "user_a5:*"),
  t("wr_document_a5:public", "viewer", "wr_group_a5:fga#member"),
  t("wr_group_a5:fga", "member", "user2_a5:bob"),

  // simple_userset_child_wildcard_only
  t("suo_group_a5:fga", "member", "user_a5:*"),
  t("suo_folder_a5:1", "viewer", "suo_group_a5:fga#member"),

  // simple_userset_child_wildcard
  t("su_group_a5:fga", "member", "user_a5:*"),
  t("su_group_a5:engineering", "member", "user_a5:maria"),
  t("su_folder_a5:1", "viewer", "su_group_a5:fga#member"),
  t("su_folder_a5:2", "viewer", "su_group_a5:engineering#member"),

  // simple_ttu_child_wildcard_only
  t("sto_group_a5:fga", "member", "user_a5:*"),
  t("sto_folder_a5:1", "owner", "sto_group_a5:fga"),

  // simple_ttu_child_wildcard
  t("st_group_a5:fga", "member", "user_a5:*"),
  t("st_group_a5:engineering", "member", "user_a5:maria"),
  t("st_folder_a5:1", "owner", "st_group_a5:fga"),
  t("st_folder_a5:2", "owner", "st_group_a5:engineering"),

  // combined_public_wildcard_userset
  t("cp_deployment_a5:1", "can_access", "cp_role_a5:superadmin#assignee"),

  // weight_2_more_than_one_userset_assignable
  t("w2_resource_a5:1", "access", "w2_scope_a5:A#verified"),
  t("w2_scope_a5:A", "public", "user_a5:*"),

  // weight_2_two_userset_assignable_diff_types
  t("w2d_resource_a5:1", "access", "w2b_scope_a5:A#verified"),
  t("w2a_scope_a5:A", "public", "user_a5:*"),
];

describe("A5 wildcard reach (upstream corpus)", () => {
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

    storeId = await fgaCreateStore("wildcards");
    authorizationModelId = await fgaWriteModel(
      storeId,
      "./wildcards/model.dsl",
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

  checks("wildcard_computed_userset", [
    ["wcu_document_a5:public", "viewer", "user_a5:aardvark", true],
  ]);

  checks("wildcard_and_userset_restriction", [
    ["wr_document_a5:public", "viewer", "user2_a5:bob", true],
  ]);

  checks("simple_userset_child_wildcard_only", [
    ["suo_folder_a5:1", "viewer", "user_a5:anne", true],
    ["suo_folder_a5:2", "viewer", "user_a5:anne", false],
    ["suo_folder_a5:1", "viewer", "user2_a5:foo", false],
    ["suo_folder_a5:2", "viewer", "user2_a5:foo", false],
  ]);

  checks("simple_userset_child_wildcard", [
    ["su_folder_a5:1", "viewer", "user_a5:anne", true],
    ["su_folder_a5:2", "viewer", "user_a5:anne", false],
    ["su_folder_a5:1", "viewer", "user_a5:maria", true],
    ["su_folder_a5:2", "viewer", "user_a5:maria", true],
    ["su_folder_a5:1", "viewer", "user2_a5:foo", false],
    ["su_folder_a5:2", "viewer", "user2_a5:foo", false],
  ]);

  checks("simple_ttu_child_wildcard_only", [
    ["sto_folder_a5:1", "viewer", "user_a5:anne", true],
    ["sto_folder_a5:2", "viewer", "user_a5:anne", false],
    ["sto_folder_a5:1", "viewer", "user2_a5:foo", false],
    ["sto_folder_a5:2", "viewer", "user2_a5:foo", false],
  ]);

  checks("simple_ttu_child_wildcard", [
    ["st_folder_a5:1", "viewer", "user_a5:anne", true],
    ["st_folder_a5:2", "viewer", "user_a5:anne", false],
    ["st_folder_a5:1", "viewer", "user_a5:maria", true],
    ["st_folder_a5:2", "viewer", "user_a5:maria", true],
    ["st_folder_a5:1", "viewer", "user2_a5:foo", false],
    ["st_folder_a5:2", "viewer", "user2_a5:foo", false],
  ]);

  checks("combined_public_wildcard_userset", [
    ["cp_deployment_a5:1", "can_access", "user_a5:jdoe", false],
  ]);

  checks("weight_2_more_than_one_userset_assignable", [
    ["w2_resource_a5:1", "access", "user_a5:bob", false],
  ]);

  checks("weight_2_two_userset_assignable_diff_types", [
    ["w2d_resource_a5:1", "access", "user_a5:bob", false],
  ]);

  test("the relation configs say what the model says", () => {
    expectConfigsMatchModel("./wildcards/model.dsl", fixture, {
      coverage: "complete",
    });
  });
});
