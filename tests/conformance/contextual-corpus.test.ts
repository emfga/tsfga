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
 * Contextual tuples, ported from OpenFGA's behavioural corpus
 * (`assets/tests/consolidated_1_1_tests.yaml`, v1.18.2).
 *
 * The bulk is upstream's `validation_*_in_contextual_tuple`
 * family: a contextual tuple is validated against the model
 * exactly as a written one is, so a tuple naming an undefined
 * type, an undefined relation, an inadmissible subject type, an
 * undefined userset relation or a wildcard the relation does not
 * admit makes the whole check a refusal (`errorCode: 2027`)
 * rather than a `false`. That distinction is the point: a
 * refusal that degrades to `false` is a silent fail-open on the
 * subtract side of an exclusion.
 *
 * - `ctx_`  — `validation_invalid_userset_in_contextual_tuple`
 * - `ctxp_` — `this_with_contextual_tuples` and the plain
 *             validation family
 * - `ctxw_` — `val_contextual_tuples_and_wildcard_in_ttu_evaluation`
 * - `ctxb_` — derived: a contextual tuple on the subtract side
 */

const NAMES = ["1", "2", "x", "aardvark", "fga"] as const;

const uuidMap = new Map<string, string>(
  NAMES.map((name, index) => [
    name,
    `00000000-0000-4000-d447-${String(index + 1).padStart(12, "0")}`,
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
  cfg("ctx_group_a5", "member", { directlyAssignable: [{ type: USER }] }),
  cfg("ctx_document_a5", "viewer", {
    directlyAssignable: [
      { type: USER },
      { type: "ctx_group_a5", relation: "member" },
    ],
  }),
  cfg("ctxp_document_a5", "viewer", { directlyAssignable: [{ type: USER }] }),
  cfg("ctxw_folder_a5", "viewer", { directlyAssignable: [{ type: USER }] }),
  cfg("ctxw_document_a5", "parent", {
    directlyAssignable: [{ type: "ctxw_folder_a5" }],
  }),
  cfg("ctxw_document_a5", "viewer", {
    tupleToUserset: [{ tupleset: "parent", computedUserset: "viewer" }],
  }),
  cfg("ctxb_document_a5", "blocked", { directlyAssignable: [{ type: USER }] }),
  cfg("ctxb_document_a5", "viewer", {
    directlyAssignable: [{ type: USER }],
    excludedBy: "blocked",
  }),
];

const TUPLES: AddTupleRequest[] = [
  t("ctxp_document_a5:1", "viewer", "user_a5:aardvark"),
  t("ctx_group_a5:fga", "member", "user_a5:aardvark"),
  t("ctxb_document_a5:1", "viewer", "user_a5:aardvark"),
];

describe("A5 contextual tuples (upstream corpus)", () => {
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

    storeId = await fgaCreateStore("contextual-corpus");
    authorizationModelId = await fgaWriteModel(
      storeId,
      "./contextual-corpus/model.dsl",
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

  function contextualCheck(
    label: string,
    object: string,
    relation: string,
    subject: string,
    contextualTuples: AddTupleRequest[],
    expected: CheckOutcome,
  ): void {
    test(`${label}`, async () => {
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
          contextualTuples,
        },
        expected,
      );
    });
  }

  contextualCheck(
    "this_with_contextual_tuples: a contextual grant is a grant",
    "ctxp_document_a5:2",
    "viewer",
    "user_a5:aardvark",
    [t("ctxp_document_a5:2", "viewer", "user_a5:aardvark")],
    true,
  );

  contextualCheck(
    "a contextual userset grant is a grant",
    "ctx_document_a5:1",
    "viewer",
    "user_a5:aardvark",
    [t("ctx_document_a5:1", "viewer", "ctx_group_a5:fga#member")],
    true,
  );

  contextualCheck(
    "validation_invalid_object_type_in_contextual_tuple",
    "ctxp_document_a5:1",
    "viewer",
    "user_a5:aardvark",
    [t("ctx_orphan_a5:x", "viewer", "user_a5:aardvark")],
    "refused",
  );

  contextualCheck(
    "validation_invalid_relation_in_contextual_tuple",
    "ctxp_document_a5:1",
    "viewer",
    "user_a5:aardvark",
    [t("ctxp_document_a5:1", "writer", "user_a5:aardvark")],
    "refused",
  );

  contextualCheck(
    "validation_invalid_user_in_contextual_tuple",
    "ctxp_document_a5:1",
    "viewer",
    "user_a5:aardvark",
    [t("ctxp_document_a5:1", "viewer", "employee_a5:aardvark")],
    "refused",
  );

  contextualCheck(
    "validation_invalid_userset_in_contextual_tuple",
    "ctx_document_a5:1",
    "viewer",
    "user_a5:aardvark",
    [t("ctx_document_a5:1", "viewer", "ctx_group_a5:fga#undefined")],
    "refused",
  );

  contextualCheck(
    "validation_invalid_wildcard_in_contextual_tuple",
    "ctxp_document_a5:1",
    "viewer",
    "user_a5:aardvark",
    [t("ctxp_document_a5:1", "viewer", "user_a5:*")],
    "refused",
  );

  contextualCheck(
    "val_contextual_tuples_and_wildcard_in_ttu_evaluation",
    "ctxw_document_a5:1",
    "viewer",
    "user_a5:aardvark",
    [t("ctxw_document_a5:1", "parent", "user_a5:*")],
    "refused",
  );

  // Derived: the subtract side reads contextual rows too, so a
  // contextual `blocked` must deny a stored grant.
  contextualCheck(
    "a contextual tuple on the subtract side denies",
    "ctxb_document_a5:1",
    "viewer",
    "user_a5:aardvark",
    [t("ctxb_document_a5:1", "blocked", "user_a5:aardvark")],
    false,
  );

  contextualCheck(
    "the same stored grant still holds without the subtract row",
    "ctxb_document_a5:1",
    "viewer",
    "user_a5:aardvark",
    [],
    true,
  );

  test("the relation configs say what the model says", () => {
    expectConfigsMatchModel("./contextual-corpus/model.dsl", fixture, {
      coverage: "complete",
    });
  });
});
