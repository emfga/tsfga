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
  expectConfigsMatchModel,
  expectConformance,
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
  fgaWriteModel,
  fgaWriteTuplesRaw,
} from "./helpers/openfga.ts";

/**
 * ListObjects, ported from OpenFGA's behavioural corpus
 * (`assets/tests/consolidated_1_1_tests.yaml`, v1.18.2). One type
 * namespace per upstream case:
 *
 * - `loc_` — `list_objects_considers_input_contextual_tuples`,
 *            `list_objects_ignores_duplicate_contextual_tuples`,
 *            `list_objects_ignores_irrelevant_tuples_because_different_user`
 * - `lod_` — `list_objects_does_not_return_duplicates`
 * - `low_` — `list_objects_expands_wildcard_tuple`
 * - `lor_` — `reverse_expand_relation_not_match`
 * - `loy_` — `list_objects_with_subcheck_encounters_cycle`
 *
 * `lor_` is the one that matters most for a candidate-pool
 * implementation: `document.viewer` reaches through *two* TTUs on
 * the same tupleset (`member from owner or observer from owner`),
 * and the only stored path uses the relation that does not match.
 */

const NAMES = ["1", "2", "3", "a", "aa", "abc", "fga", "jon"] as const;

const uuidMap = new Map<string, string>(
  NAMES.map((name, index) => [
    name,
    `00000000-0000-4000-d448-${String(index + 1).padStart(12, "0")}`,
  ]),
);

function uuid(name: string): string {
  const id = uuidMap.get(name);
  if (!id) throw new Error(`No UUID for ${name}`);
  return id;
}

const USER = "user_a5";

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

const CONFIGS: RelationConfig[] = [
  cfg("loc_repo_a5", "blocked", { directlyAssignable: [{ type: USER }] }),
  cfg("loc_repo_a5", "owner", {
    directlyAssignable: [{ type: USER }],
    excludedBy: "blocked",
  }),

  cfg("lod_repo_a5", "blocked", { directlyAssignable: [{ type: USER }] }),
  cfg("lod_repo_a5", "admin", {
    directlyAssignable: [{ type: USER }, { type: USER, wildcard: true }],
    excludedBy: "blocked",
  }),

  cfg("low_repo_a5", "blocked", { directlyAssignable: [{ type: USER }] }),
  cfg("low_repo_a5", "owner", {
    directlyAssignable: [{ type: USER }, { type: USER, wildcard: true }],
    excludedBy: "blocked",
  }),
  cfg("low_repo_a5", "can_own", { computedUserset: "owner" }),

  cfg("lor_company_a5", "admin", { directlyAssignable: [{ type: USER }] }),
  cfg("lor_company_a5", "management", { directlyAssignable: [{ type: USER }] }),
  cfg("lor_company_a5", "employee", {
    directlyAssignable: [{ type: USER }],
    impliedBy: ["admin"],
  }),
  cfg("lor_group_a5", "observer", {
    directlyAssignable: [{ type: "lor_company_a5" }],
  }),
  cfg("lor_group_a5", "owner", {
    directlyAssignable: [{ type: "lor_company_a5" }],
  }),
  cfg("lor_group_a5", "admin", {
    tupleToUserset: [{ tupleset: "owner", computedUserset: "admin" }],
  }),
  cfg("lor_group_a5", "member", {
    tupleToUserset: [{ tupleset: "owner", computedUserset: "employee" }],
  }),
  cfg("lor_document_a5", "owner", {
    directlyAssignable: [{ type: "lor_group_a5" }],
  }),
  cfg("lor_document_a5", "viewer", {
    tupleToUserset: [
      { tupleset: "owner", computedUserset: "member" },
      { tupleset: "owner", computedUserset: "observer" },
    ],
  }),

  cfg("loy_document_a5", "allowed", {
    directlyAssignable: [
      { type: USER },
      { type: "loy_document_a5", relation: "viewer" },
    ],
  }),
  cfg("loy_document_a5", "viewer", {
    directlyAssignable: [
      { type: USER },
      { type: "loy_document_a5", relation: "allowed" },
    ],
    intersection: [
      { type: "direct" },
      { type: "computedUserset", relation: "allowed" },
    ],
  }),
];

const TUPLES: AddTupleRequest[] = [
  t("loc_repo_a5:1", "owner", "user_a5:a"),
  t("loc_repo_a5:2", "owner", "user_a5:aa"),

  t("lod_repo_a5:1", "admin", "user_a5:a"),
  t("lod_repo_a5:1", "admin", "user_a5:*"),

  t("low_repo_a5:1", "owner", "user_a5:*"),

  t("lor_company_a5:abc", "employee", "user_a5:jon"),
  t("lor_document_a5:a", "owner", "lor_group_a5:fga"),
  t("lor_group_a5:fga", "observer", "lor_company_a5:abc"),

  t("loy_document_a5:1", "viewer", "user_a5:jon"),
  t("loy_document_a5:1", "allowed", "loy_document_a5:1#viewer"),
  t("loy_document_a5:1", "viewer", "loy_document_a5:1#allowed"),
];

describe("A5 listObjects (upstream corpus)", () => {
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

    storeId = await fgaCreateStore("list-objects-corpus");
    authorizationModelId = await fgaWriteModel(
      storeId,
      "./list-objects-corpus/model.dsl",
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

  test("list_objects_considers_input_contextual_tuples", async () => {
    await expectListObjectsConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "loc_repo_a5",
        relation: "owner",
        subjectType: USER,
        subjectId: uuid("a"),
        contextualTuples: [
          t("loc_repo_a5:2", "owner", "user_a5:a"),
          t("loc_repo_a5:3", "owner", "user_a5:a"),
        ],
      },
      [uuid("1"), uuid("2"), uuid("3")],
    );
  });

  test("list_objects_ignores_duplicate_contextual_tuples", async () => {
    await expectListObjectsConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "loc_repo_a5",
        relation: "owner",
        subjectType: USER,
        subjectId: uuid("a"),
        contextualTuples: [
          t("loc_repo_a5:2", "owner", "user_a5:a"),
          t("loc_repo_a5:2", "owner", "user_a5:a"),
        ],
      },
      [uuid("1"), uuid("2")],
    );
  });

  test("list_objects_ignores_irrelevant_tuples_because_different_user", async () => {
    await expectListObjectsConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "loc_repo_a5",
        relation: "owner",
        subjectType: USER,
        subjectId: uuid("a"),
      },
      [uuid("1")],
    );
  });

  test("list_objects_does_not_return_duplicates", async () => {
    await expectListObjectsConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "lod_repo_a5",
        relation: "admin",
        subjectType: USER,
        subjectId: uuid("a"),
      },
      [uuid("1")],
    );
  });

  test("list_objects_expands_wildcard_tuple", async () => {
    await expectListObjectsConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "low_repo_a5",
        relation: "owner",
        subjectType: USER,
        subjectId: uuid("a"),
      },
      [uuid("1")],
    );
  });

  test("list_objects_expands_wildcard_tuple through a rewrite", async () => {
    await expectListObjectsConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "low_repo_a5",
        relation: "can_own",
        subjectType: USER,
        subjectId: uuid("a"),
      },
      [uuid("1")],
    );
  });

  test("reverse_expand_relation_not_match: listObjects", async () => {
    await expectListObjectsConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "lor_document_a5",
        relation: "viewer",
        subjectType: USER,
        subjectId: uuid("jon"),
      },
      [],
    );
  });

  test("reverse_expand_relation_not_match: check", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "lor_document_a5",
        objectId: uuid("a"),
        relation: "viewer",
        subjectType: USER,
        subjectId: uuid("jon"),
      },
      false,
    );
  });

  test("list_objects_with_subcheck_encounters_cycle: listObjects", async () => {
    await expectListObjectsConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "loy_document_a5",
        relation: "viewer",
        subjectType: USER,
        subjectId: uuid("jon"),
      },
      [],
    );
  });

  test("list_objects_with_subcheck_encounters_cycle: check", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "loy_document_a5",
        objectId: uuid("1"),
        relation: "viewer",
        subjectType: USER,
        subjectId: uuid("jon"),
      },
      false,
    );
  });

  test("the relation configs say what the model says", () => {
    expectConfigsMatchModel("./list-objects-corpus/model.dsl", fixture, {
      coverage: "complete",
    });
  });
});
