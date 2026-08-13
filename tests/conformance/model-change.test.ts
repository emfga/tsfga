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
 * Rows that outlive the type restriction that admitted them.
 *
 * Ported from the multi-stage cases of OpenFGA's behavioural
 * corpus (`assets/tests/consolidated_1_1_tests.yaml`, v1.18.2),
 * where a stage writes tuples under one model and the next stage
 * checks them under a narrower one. Every row here is legal when
 * written and inadmissible when read, which is the one way to
 * reach the read-side type gate at all: the write gate refuses to
 * create such a row directly.
 *
 * One type namespace per upstream case:
 *
 * - `pti_` — `prior_type_restrictions_ignored`
 * - `ptw_` — `prior_type_restrictions_ignored_with_wildcard`
 * - `wos_` — `wildcard_obeys_the_types_in_stages`
 * - `uop_` — `userset_orphan_parent`
 * - `trp_` — `ttu_remove_public_wildcard`
 * - `top_` — `ttu_orphan_public_wildcard_parent`
 * - `tdi_` — `ttu_discard_invalid`
 * - `udi_` — `userset_discard_invalid`
 * - `udw_` — `userset_discard_invalid_wildcard`
 *
 * tsfga's relation config *is* its model, so the narrowing is a
 * second `writeRelationConfig` over the same relation. OpenFGA
 * gets both models and the checks name the second one.
 */

const NAMES = [
  "1",
  "2",
  "3",
  "4",
  "jon",
  "aardvark",
  "badger",
  "anne",
  "bob",
  "pub",
  "minion",
  "parent",
  "awesome",
  "invalid",
  "admin",
] as const;

const uuidMap = new Map<string, string>(
  NAMES.map((name, index) => [
    name,
    `00000000-0000-4000-d443-${String(index + 1).padStart(12, "0")}`,
  ]),
);

function uuid(name: string): string {
  const id = uuidMap.get(name);
  if (!id) throw new Error(`No UUID for ${name}`);
  return id;
}

const USER = "user_a5";
const EMPLOYEE = "employee_a5";
const ANY_USER = { type: USER, wildcard: true } as const;

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

/** The configs the rows below were written under. */
const STAGE0: RelationConfig[] = [
  cfg("pti_document_a5", "viewer", { directlyAssignable: [{ type: USER }] }),
  cfg("ptw_document_a5", "viewer", { directlyAssignable: [ANY_USER] }),

  cfg("wos_document_a5", "writer", {
    directlyAssignable: [{ type: EMPLOYEE, wildcard: true }],
  }),
  cfg("wos_document_a5", "viewer", {
    directlyAssignable: [{ type: USER }],
    impliedBy: ["writer"],
  }),

  cfg("uop_group1_a5", "member", {
    directlyAssignable: [{ type: USER }, ANY_USER],
  }),
  cfg("uop_group2_a5", "member", {
    directlyAssignable: [{ type: USER }, ANY_USER],
  }),
  cfg("uop_document_a5", "viewer", {
    directlyAssignable: [
      { type: "uop_group1_a5", relation: "member" },
      { type: "uop_group2_a5", relation: "member" },
    ],
  }),

  cfg("trp_group_a5", "member", {
    directlyAssignable: [{ type: USER }, ANY_USER],
  }),
  cfg("trp_document_a5", "parent", {
    directlyAssignable: [{ type: "trp_group_a5" }],
  }),
  cfg("trp_document_a5", "viewer", {
    tupleToUserset: [{ tupleset: "parent", computedUserset: "member" }],
  }),

  cfg("top_group_a5", "member", { directlyAssignable: [{ type: USER }] }),
  cfg("top_document_a5", "parent", {
    directlyAssignable: [
      { type: "top_group_a5" },
      { type: "top_group_a5", wildcard: true },
    ],
  }),

  cfg("tdi_role_a5", "assignee", {
    directlyAssignable: [
      { type: USER },
      { type: "tdi_role_a5", relation: "assignee" },
    ],
  }),
  cfg("tdi_job_a5", "parent", {
    directlyAssignable: [{ type: "tdi_role_a5" }],
  }),
  cfg("tdi_job_a5", "can_read", {
    tupleToUserset: [{ tupleset: "parent", computedUserset: "assignee" }],
  }),

  cfg("udi_role_a5", "placeholder", { directlyAssignable: [{ type: USER }] }),
  cfg("udi_role_a5", "assignee", {
    directlyAssignable: [
      { type: USER },
      { type: "udi_role_a5", relation: "placeholder" },
    ],
  }),
  cfg("udi_job_a5", "can_read", {
    directlyAssignable: [{ type: "udi_role_a5", relation: "assignee" }],
  }),

  cfg("udw_role_a5", "assignee", { directlyAssignable: [{ type: USER }] }),
  cfg("udw_job_a5", "can_read", {
    directlyAssignable: [
      { type: "udw_role_a5", relation: "assignee" },
      ANY_USER,
    ],
  }),
];

/** The narrowed configs every check below is resolved against. */
const STAGE1: RelationConfig[] = [
  cfg("pti_document_a5", "viewer", {
    directlyAssignable: [{ type: EMPLOYEE }],
  }),
  cfg("ptw_document_a5", "viewer", { directlyAssignable: [{ type: USER }] }),
  cfg("wos_document_a5", "writer", { directlyAssignable: [ANY_USER] }),
  cfg("uop_document_a5", "viewer", {
    directlyAssignable: [{ type: "uop_group1_a5", relation: "member" }],
  }),
  cfg("trp_group_a5", "member", { directlyAssignable: [{ type: USER }] }),
  cfg("top_document_a5", "parent", {
    directlyAssignable: [{ type: "top_group_a5" }],
  }),
  // Added, not narrowed: upstream's stage 1 introduces it.
  cfg("top_document_a5", "viewer", {
    tupleToUserset: [{ tupleset: "parent", computedUserset: "member" }],
  }),
  cfg("tdi_role_a5", "assignee", { directlyAssignable: [{ type: USER }] }),
  cfg("udi_role_a5", "assignee", { directlyAssignable: [{ type: USER }] }),
  cfg("udw_job_a5", "can_read", {
    directlyAssignable: [{ type: "udw_role_a5", relation: "assignee" }],
  }),
];

const TUPLES: AddTupleRequest[] = [
  t("pti_document_a5:1", "viewer", "user_a5:jon"),

  t("ptw_document_a5:1", "viewer", "user_a5:*"),

  t("wos_document_a5:1", "writer", "employee_a5:*"),

  t("uop_group1_a5:1", "member", "user_a5:anne"),
  t("uop_group2_a5:1", "member", "user_a5:bob"),
  t("uop_document_a5:1", "viewer", "uop_group2_a5:1#member"),
  t("uop_document_a5:1", "viewer", "uop_group1_a5:1#member"),

  t("trp_group_a5:1", "member", "user_a5:anne"),
  t("trp_document_a5:1", "parent", "trp_group_a5:1"),
  t("trp_group_a5:pub", "member", "user_a5:*"),
  t("trp_document_a5:1", "parent", "trp_group_a5:pub"),

  t("top_group_a5:1", "member", "user_a5:anne"),
  t("top_document_a5:1", "parent", "top_group_a5:1"),
  t("top_document_a5:1", "parent", "top_group_a5:*"),

  t("tdi_role_a5:minion", "assignee", "user_a5:1"),
  t("tdi_role_a5:parent", "assignee", "tdi_role_a5:minion#assignee"),
  t("tdi_job_a5:1", "parent", "tdi_role_a5:parent"),

  t("udi_role_a5:awesome", "placeholder", "user_a5:1"),
  t("udi_role_a5:invalid", "assignee", "udi_role_a5:awesome#placeholder"),
  t("udi_job_a5:1", "can_read", "udi_role_a5:invalid#assignee"),

  t("udw_job_a5:1", "can_read", "user_a5:*"),
  t("udw_job_a5:2", "can_read", "user_a5:*"),
  t("udw_job_a5:2", "can_read", "udw_role_a5:admin#assignee"),
  t("udw_role_a5:admin", "assignee", "user_a5:3"),
];

describe("A5 rows outliving their type restriction (upstream corpus)", () => {
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

    for (const config of STAGE0) {
      await tsfgaClient.writeRelationConfig(config);
    }
    for (const tuple of TUPLES) {
      await tsfgaClient.addTuple(tuple);
    }
    // The model change. Every row above is now read under a
    // restriction that would not have admitted it.
    for (const config of STAGE1) {
      await tsfgaClient.writeRelationConfig(config);
    }

    storeId = await fgaCreateStore("model-change");
    const stage0ModelId = await fgaWriteModel(
      storeId,
      "./model-change/model-stage0.dsl",
    );
    await fgaWriteTuplesRaw(
      storeId,
      stage0ModelId,
      TUPLES.map((tuple) => ({
        user: tuple.subjectRelation
          ? `${tuple.subjectType}:${tuple.subjectId}#${tuple.subjectRelation}`
          : `${tuple.subjectType}:${tuple.subjectId}`,
        relation: tuple.relation,
        object: `${tuple.objectType}:${tuple.objectId}`,
      })),
    );
    authorizationModelId = await fgaWriteModel(
      storeId,
      "./model-change/model.dsl",
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

  checks("prior_type_restrictions_ignored", [
    ["pti_document_a5:1", "viewer", "user_a5:jon", false],
  ]);

  checks("prior_type_restrictions_ignored_with_wildcard", [
    ["ptw_document_a5:1", "viewer", "user_a5:jon", false],
  ]);

  checks("wildcard_obeys_the_types_in_stages", [
    ["wos_document_a5:1", "viewer", "user_a5:aardvark", false],
    ["wos_document_a5:1", "viewer", "employee_a5:badger", false],
  ]);

  checks("userset_orphan_parent", [
    ["uop_document_a5:1", "viewer", "user_a5:anne", true],
    ["uop_document_a5:1", "viewer", "user_a5:bob", false],
  ]);

  checks("ttu_remove_public_wildcard", [
    ["trp_document_a5:1", "viewer", "user_a5:anne", true],
    ["trp_document_a5:1", "viewer", "user_a5:bob", false],
  ]);

  checks("ttu_orphan_public_wildcard_parent", [
    ["top_document_a5:1", "viewer", "user_a5:anne", true],
    ["top_document_a5:1", "viewer", "user_a5:bob", false],
  ]);

  // Upstream's stage 1 re-checks on fresh objects rather than on
  // the rows it just orphaned, so the assertion that actually
  // exercises the case is derived, not transcribed: the
  // `role#assignee` userset row on `tdi_role_a5:parent` is no
  // longer a ref the relation admits, so the chain through it
  // must not resolve.
  checks("ttu_discard_invalid (derived)", [
    ["tdi_job_a5:1", "can_read", "user_a5:1", false],
  ]);

  checks("userset_discard_invalid (derived)", [
    ["udi_job_a5:1", "can_read", "user_a5:1", false],
  ]);

  checks("userset_discard_invalid_wildcard", [
    ["udw_job_a5:2", "can_read", "user_a5:3", true],
    ["udw_job_a5:2", "can_read", "user_a5:4", false],
    // Derived, same reason as above: the `user:*` row is no
    // longer admitted.
    ["udw_job_a5:1", "can_read", "user_a5:1", false],
  ]);

  test("the relation configs say what the model says", () => {
    expectConfigsMatchModel("./model-change/model.dsl", fixture, {
      coverage: "complete",
    });
  });
});
