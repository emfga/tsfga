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
 * The deepest single case in OpenFGA's behavioural corpus: stage 2
 * of `list_objects_expands_wildcard_tuple`
 * (`assets/tests/consolidated_1_1_tests.yaml`, v1.18.2).
 *
 * A five-deep folder chain owned by a group hierarchy, where
 * `can_read` is `(folder_reader and allowed and super_allowed) but
 * not (blocked but not unblocked)`, `blocked` recurses on
 * `nblocked from parent`, group membership is itself an
 * intersection minus an exclusion, and a `user:*` row sits on
 * `folder:4` for both `blocked` and `allowed`. Eight subjects, each
 * reaching a different subset.
 *
 * It is the case most likely to expose a disagreement about
 * *where* an exclusion is evaluated relative to a recursive TTU,
 * because `nblocked from parent` makes a folder's blocked-ness
 * depend on its ancestor's un-blocked-ness.
 */

const NAMES = [
  "1",
  "2",
  "3",
  "4",
  "5",
  "marketing",
  "digitalmktg",
  "admin",
  "anne",
  "beth",
  "carl",
  "dan",
  "emily",
  "frida",
  "gabriel",
  "harriette",
] as const;

const uuidMap = new Map<string, string>(
  NAMES.map((name, index) => [
    name,
    `00000000-0000-4000-d449-${String(index + 1).padStart(12, "0")}`,
  ]),
);

function uuid(name: string): string {
  const id = uuidMap.get(name);
  if (!id) throw new Error(`No UUID for ${name}`);
  return id;
}

const USER = "user_a5";
const FOLDER = "nf_folder_a5";
const GROUP = "nf_group_a5";
const ANY_USER = { type: USER, wildcard: true } as const;
const GROUP_MEMBER = { type: GROUP, relation: "member" } as const;

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
  cfg(FOLDER, "parent", { directlyAssignable: [{ type: FOLDER }] }),
  cfg(FOLDER, "owner", { directlyAssignable: [{ type: GROUP }] }),
  cfg(FOLDER, "folder_reader", {
    directlyAssignable: [{ type: USER }, GROUP_MEMBER],
    tupleToUserset: [
      { tupleset: "owner", computedUserset: "folder_reader" },
      { tupleset: "parent", computedUserset: "folder_reader" },
    ],
  }),
  cfg(FOLDER, "blocked", {
    directlyAssignable: [{ type: USER }, ANY_USER, GROUP_MEMBER],
    tupleToUserset: [{ tupleset: "parent", computedUserset: "nblocked" }],
  }),
  cfg(FOLDER, "unblocked", {
    directlyAssignable: [{ type: USER }, GROUP_MEMBER],
  }),
  cfg(FOLDER, "nblocked", {
    computedUserset: "blocked",
    excludedBy: "unblocked",
  }),
  cfg(FOLDER, "allowed", {
    directlyAssignable: [{ type: USER }, ANY_USER, GROUP_MEMBER],
    tupleToUserset: [{ tupleset: "parent", computedUserset: "allowed" }],
  }),
  cfg(FOLDER, "super_allowed", {
    directlyAssignable: [{ type: USER }, GROUP_MEMBER],
    tupleToUserset: [{ tupleset: "parent", computedUserset: "super_allowed" }],
  }),
  cfg(FOLDER, "reader", {
    intersection: [
      { type: "computedUserset", relation: "folder_reader" },
      { type: "computedUserset", relation: "allowed" },
      { type: "computedUserset", relation: "super_allowed" },
    ],
  }),
  cfg(FOLDER, "can_read", {
    computedUserset: "reader",
    excludedBy: "nblocked",
  }),

  cfg(GROUP, "parent", { directlyAssignable: [{ type: GROUP }] }),
  cfg(GROUP, "allowed", {
    directlyAssignable: [{ type: USER }, GROUP_MEMBER],
    tupleToUserset: [{ tupleset: "parent", computedUserset: "allowed" }],
  }),
  cfg(GROUP, "super_allowed", {
    directlyAssignable: [
      { type: USER },
      { type: GROUP, relation: "super_allowed" },
    ],
  }),
  cfg(GROUP, "blocked", {
    directlyAssignable: [{ type: USER }, GROUP_MEMBER],
    tupleToUserset: [{ tupleset: "parent", computedUserset: "blocked" }],
  }),
  cfg(GROUP, "og_member", {
    directlyAssignable: [{ type: USER }],
    tupleToUserset: [{ tupleset: "parent", computedUserset: "member" }],
  }),
  cfg(GROUP, "allowed_member", {
    intersection: [
      { type: "computedUserset", relation: "og_member" },
      { type: "computedUserset", relation: "allowed" },
      { type: "computedUserset", relation: "super_allowed" },
    ],
  }),
  cfg(GROUP, "member", {
    computedUserset: "allowed_member",
    excludedBy: "blocked",
  }),
  cfg(GROUP, "folder_reader", {
    directlyAssignable: [GROUP_MEMBER],
    tupleToUserset: [{ tupleset: "parent", computedUserset: "folder_reader" }],
  }),
];

const TUPLES: AddTupleRequest[] = [
  t("nf_group_a5:marketing", "og_member", "user_a5:anne"),
  t("nf_group_a5:marketing", "allowed", "user_a5:anne"),
  t("nf_group_a5:marketing", "super_allowed", "user_a5:anne"),
  t("nf_group_a5:marketing", "og_member", "user_a5:beth"),
  t("nf_group_a5:marketing", "allowed", "user_a5:beth"),
  t("nf_group_a5:marketing", "super_allowed", "user_a5:beth"),
  t("nf_group_a5:marketing", "og_member", "user_a5:carl"),
  t("nf_group_a5:marketing", "allowed", "user_a5:carl"),
  t("nf_group_a5:marketing", "og_member", "user_a5:dan"),
  t("nf_group_a5:marketing", "allowed", "user_a5:dan"),
  t("nf_group_a5:marketing", "super_allowed", "user_a5:dan"),
  t("nf_group_a5:marketing", "blocked", "user_a5:dan"),
  t("nf_group_a5:marketing", "og_member", "user_a5:emily"),
  t("nf_group_a5:marketing", "allowed", "user_a5:emily"),
  t("nf_group_a5:marketing", "super_allowed", "user_a5:emily"),
  t("nf_group_a5:marketing", "og_member", "user_a5:gabriel"),
  t("nf_group_a5:marketing", "allowed", "user_a5:gabriel"),
  t("nf_group_a5:marketing", "super_allowed", "user_a5:gabriel"),
  t("nf_group_a5:marketing", "og_member", "user_a5:harriette"),
  t("nf_group_a5:marketing", "allowed", "user_a5:harriette"),
  t("nf_group_a5:marketing", "super_allowed", "user_a5:harriette"),
  t("nf_group_a5:admin", "og_member", "user_a5:gabriel"),
  t("nf_group_a5:admin", "allowed", "user_a5:gabriel"),
  t("nf_group_a5:admin", "super_allowed", "user_a5:gabriel"),
  t("nf_group_a5:marketing", "folder_reader", "nf_group_a5:marketing#member"),
  t("nf_group_a5:digitalmktg", "parent", "nf_group_a5:marketing"),
  t(
    "nf_group_a5:digitalmktg",
    "super_allowed",
    "nf_group_a5:marketing#super_allowed",
  ),
  t("nf_folder_a5:1", "owner", "nf_group_a5:digitalmktg"),
  t("nf_folder_a5:2", "parent", "nf_folder_a5:1"),
  t("nf_folder_a5:3", "parent", "nf_folder_a5:2"),
  t("nf_folder_a5:4", "parent", "nf_folder_a5:3"),
  t("nf_folder_a5:5", "parent", "nf_folder_a5:4"),
  t("nf_folder_a5:1", "allowed", "nf_group_a5:marketing#member"),
  t("nf_folder_a5:1", "super_allowed", "nf_group_a5:marketing#member"),
  t("nf_folder_a5:2", "blocked", "user_a5:beth"),
  t("nf_folder_a5:1", "blocked", "user_a5:emily"),
  t("nf_folder_a5:2", "unblocked", "user_a5:emily"),
  t("nf_folder_a5:1", "blocked", "user_a5:gabriel"),
  t("nf_folder_a5:5", "unblocked", "user_a5:harriette"),
  t("nf_folder_a5:4", "blocked", "user_a5:*"),
  t("nf_folder_a5:4", "allowed", "user_a5:*"),
  t("nf_folder_a5:2", "unblocked", "nf_group_a5:admin#member"),
];

/** `[subject, folders reachable by can_read]`, from upstream. */
const LIST_EXPECTATIONS: ReadonlyArray<[string, string[]]> = [
  ["anne", ["1", "2", "3"]],
  ["beth", ["1"]],
  ["carl", []],
  ["dan", []],
  ["emily", ["2", "3"]],
  ["frida", []],
  ["gabriel", ["2", "3"]],
  ["harriette", ["1", "2", "3", "5"]],
];

/** `[subject, can_read on folder:3]`, from upstream. */
const CHECK_EXPECTATIONS: ReadonlyArray<[string, boolean]> = [
  ["anne", true],
  ["beth", false],
  ["carl", false],
  ["dan", false],
  ["emily", true],
  ["frida", false],
  ["gabriel", true],
  ["harriette", true],
];

describe("A5 nested folders and groups (upstream corpus)", () => {
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

    storeId = await fgaCreateStore("nested-folders");
    authorizationModelId = await fgaWriteModel(
      storeId,
      "./nested-folders/model.dsl",
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

  for (const [subject, folders] of LIST_EXPECTATIONS) {
    test(`listObjects can_read for ${subject}`, async () => {
      await expectListObjectsConformance(
        storeId,
        authorizationModelId,
        tsfgaClient,
        {
          objectType: FOLDER,
          relation: "can_read",
          subjectType: USER,
          subjectId: uuid(subject),
        },
        folders.map(uuid),
      );
    });
  }

  for (const [subject, expected] of CHECK_EXPECTATIONS) {
    test(`check can_read on folder:3 for ${subject} is ${expected}`, async () => {
      await expectConformance(
        storeId,
        authorizationModelId,
        tsfgaClient,
        {
          objectType: FOLDER,
          objectId: uuid("3"),
          relation: "can_read",
          subjectType: USER,
          subjectId: uuid(subject),
        },
        expected,
      );
    });
  }

  test("the relation configs say what the model says", () => {
    expectConfigsMatchModel("./nested-folders/model.dsl", fixture, {
      coverage: "complete",
    });
  });
});
