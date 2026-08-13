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
 * Cycles and mutually recursive rewrites, ported from OpenFGA's
 * behavioural corpus (`assets/tests/consolidated_1_1_tests.yaml`,
 * v1.18.2). One type namespace per upstream case:
 *
 * - `coc_` — `cycle_or_cycle_return_false`
 * - `icc_` — `immediate_cycle_through_computed_userset`
 * - `tbc_` — `true_butnot_cycle_return_false`
 * - `cac_` — `cycle_and_cycle_return_false`
 * - `cat_` — `cycle_and_true_return_false`
 * - `icr_` — `immediate_cycle_return_false`
 * - `cbf_` — `cycle_butnot_false_return_false`
 * - `fbc_` — `false_butnot_cycle_return_false`
 * - `tpr_` — `three_prong_relation`
 * - `tpl_` — `three_prong_relation_loop`
 * - `tpe_` — `three_prong_relation_possible_exclusion`
 * - `efs_` — `exclusion_for_some_relations`
 * - `ctd_` — `contextual_tuple_ref_relation_disjoint`
 *
 * The cycle group is where a cycle-truncated `false` and a plain
 * `false` are distinguishable — `tbc_` and `fbc_` put one on the
 * subtract side of a `but not`, where reading it as a plain
 * `false` would fail open.
 */

const NAMES = ["1", "a", "b", "anne", "jon", "fga", "abc"] as const;

const uuidMap = new Map<string, string>(
  NAMES.map((name, index) => [
    name,
    `00000000-0000-4000-d444-${String(index + 1).padStart(12, "0")}`,
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

/** `[user_a5] or owner from parent`, on all three prong types. */
function prongConfigs(prefix: string): RelationConfig[] {
  const module = `${prefix}_module_a5`;
  const folder = `${prefix}_folder_a5`;
  const document = `${prefix}_document_a5`;
  const parents: Record<string, string[]> = {
    [module]: [document, module],
    [folder]: [module, folder],
    [document]: [folder, document],
  };
  return [module, folder, document].flatMap((type) => [
    cfg(type, "owner", {
      directlyAssignable: [{ type: USER }],
      tupleToUserset: [{ tupleset: "parent", computedUserset: "owner" }],
    }),
    cfg(type, "parent", {
      directlyAssignable: (parents[type] ?? []).map((target) => ({
        type: target,
      })),
    }),
    cfg(type, "viewer", {
      directlyAssignable: [{ type: USER }],
      impliedBy: ["owner"],
      tupleToUserset: [{ tupleset: "parent", computedUserset: "viewer" }],
    }),
  ]);
}

/** As `prongConfigs`, but routed through `has_owned`. */
function prongExclusionConfigs(): RelationConfig[] {
  const module = "tpe_module_a5";
  const folder = "tpe_folder_a5";
  const document = "tpe_document_a5";
  const parents: Record<string, string[]> = {
    [module]: [document, module],
    [folder]: [module, folder],
    [document]: [folder, document],
  };
  const configs = [module, folder, document].flatMap((type) => [
    cfg(type, "owner", {
      directlyAssignable: [{ type: USER }],
      tupleToUserset: [{ tupleset: "parent", computedUserset: "has_owned" }],
    }),
    cfg(type, "parent", {
      directlyAssignable: (parents[type] ?? []).map((target) => ({
        type: target,
      })),
    }),
    cfg(type, "viewer", {
      directlyAssignable: [{ type: USER }],
      impliedBy: ["has_owned"],
      tupleToUserset: [{ tupleset: "parent", computedUserset: "viewer" }],
    }),
  ]);
  configs.push(
    cfg(module, "has_owned", { computedUserset: "owner" }),
    cfg(folder, "has_owned", { computedUserset: "owner" }),
    cfg(document, "banned", { directlyAssignable: [{ type: USER }] }),
    cfg(document, "has_owned", {
      computedUserset: "owner",
      excludedBy: "banned",
    }),
  );
  return configs;
}

const CONFIGS: RelationConfig[] = [
  // cycle_or_cycle_return_false
  cfg("coc_document_a5", "editor", {
    directlyAssignable: [
      { type: USER },
      { type: "coc_document_a5", relation: "viewer" },
    ],
  }),
  cfg("coc_document_a5", "viewer", {
    directlyAssignable: [{ type: "coc_document_a5", relation: "editor" }],
    impliedBy: ["editor"],
  }),

  // immediate_cycle_through_computed_userset
  cfg("icc_document_a5", "editor", {
    directlyAssignable: [
      { type: USER },
      { type: "icc_document_a5", relation: "viewer" },
    ],
  }),
  cfg("icc_document_a5", "viewer", { computedUserset: "editor" }),

  // true_butnot_cycle_return_false
  cfg("tbc_document_a5", "restricted", {
    directlyAssignable: [
      { type: USER },
      { type: "tbc_document_a5", relation: "viewer" },
    ],
  }),
  cfg("tbc_document_a5", "viewer", {
    directlyAssignable: [{ type: USER }],
    excludedBy: "restricted",
  }),

  // cycle_and_cycle_return_false
  cfg("cac_document_a5", "editor", {
    directlyAssignable: [
      { type: USER },
      { type: "cac_document_a5", relation: "viewer" },
    ],
  }),
  cfg("cac_document_a5", "viewer", {
    directlyAssignable: [
      { type: USER },
      { type: "cac_document_a5", relation: "editor" },
    ],
    intersection: [
      { type: "direct" },
      { type: "computedUserset", relation: "editor" },
    ],
  }),

  // cycle_and_true_return_false
  cfg("cat_document_a5", "allowed", { directlyAssignable: [{ type: USER }] }),
  cfg("cat_document_a5", "viewer", {
    directlyAssignable: [
      { type: USER },
      { type: "cat_document_a5", relation: "viewer" },
    ],
    intersection: [
      { type: "direct" },
      { type: "computedUserset", relation: "allowed" },
    ],
  }),

  // immediate_cycle_return_false
  cfg("icr_document_a5", "viewer", {
    directlyAssignable: [
      { type: USER },
      { type: "icr_document_a5", relation: "viewer" },
    ],
  }),

  // cycle_butnot_false_return_false
  cfg("cbf_document_a5", "restricted", {
    directlyAssignable: [{ type: USER }],
  }),
  cfg("cbf_document_a5", "viewer", {
    directlyAssignable: [
      { type: USER },
      { type: "cbf_document_a5", relation: "viewer" },
    ],
    excludedBy: "restricted",
  }),

  // false_butnot_cycle_return_false
  cfg("fbc_document_a5", "restricted", {
    directlyAssignable: [
      { type: USER },
      { type: "fbc_document_a5", relation: "viewer" },
    ],
  }),
  cfg("fbc_document_a5", "viewer", {
    directlyAssignable: [{ type: USER }],
    excludedBy: "restricted",
  }),

  ...prongConfigs("tpr"),
  ...prongConfigs("tpl"),
  ...prongExclusionConfigs(),

  // exclusion_for_some_relations
  cfg("efs_group_a5", "member", { directlyAssignable: [{ type: USER }] }),
  cfg("efs_folder_a5", "owner", {
    directlyAssignable: [{ type: "efs_group_a5" }],
  }),
  cfg("efs_folder_a5", "viewer", {
    tupleToUserset: [{ tupleset: "owner", computedUserset: "member" }],
  }),
  cfg("efs_document_a5", "banned", { directlyAssignable: [{ type: USER }] }),
  cfg("efs_document_a5", "owner", {
    directlyAssignable: [{ type: "efs_folder_a5" }],
  }),
  cfg("efs_document_a5", "viewer", {
    tupleToUserset: [{ tupleset: "owner", computedUserset: "viewer" }],
  }),
  cfg("efs_document_a5", "can_view", {
    computedUserset: "viewer",
    excludedBy: "banned",
  }),
  cfg("efs_document_a5", "can_see", { computedUserset: "can_view" }),

  // contextual_tuple_ref_relation_disjoint
  cfg("ctd_company_a5", "admin", { directlyAssignable: [{ type: USER }] }),
  cfg("ctd_company_a5", "management", { directlyAssignable: [{ type: USER }] }),
  cfg("ctd_company_a5", "employee", {
    directlyAssignable: [{ type: USER }],
    impliedBy: ["admin"],
  }),
  cfg("ctd_group_a5", "corp", {
    directlyAssignable: [{ type: "ctd_company_a5" }],
  }),
  cfg("ctd_group_a5", "member", {
    tupleToUserset: [{ tupleset: "corp", computedUserset: "employee" }],
  }),
  cfg("ctd_document_a5", "viewer", {
    directlyAssignable: [{ type: "ctd_group_a5", relation: "member" }],
  }),
  cfg("ctd_diagram_a5", "parent", {
    directlyAssignable: [{ type: "ctd_document_a5" }],
  }),
  cfg("ctd_diagram_a5", "viewer", {
    tupleToUserset: [{ tupleset: "parent", computedUserset: "viewer" }],
  }),
];

/** The parent chain both three-prong cases share, `tpl` looping. */
function prongTuples(prefix: string, loop: boolean): AddTupleRequest[] {
  const rows = [
    t(`${prefix}_module_a5:a`, "owner", "user_a5:anne"),
    t(`${prefix}_folder_a5:a`, "parent", `${prefix}_module_a5:a`),
    t(`${prefix}_document_a5:a`, "parent", `${prefix}_folder_a5:a`),
    t(`${prefix}_module_a5:b`, "parent", `${prefix}_document_a5:a`),
    t(`${prefix}_folder_a5:b`, "parent", `${prefix}_module_a5:b`),
    t(`${prefix}_document_a5:b`, "parent", `${prefix}_folder_a5:b`),
  ];
  if (loop) {
    rows.push(t(`${prefix}_module_a5:a`, "parent", `${prefix}_document_a5:b`));
  }
  return rows;
}

const TUPLES: AddTupleRequest[] = [
  t("coc_document_a5:1", "editor", "coc_document_a5:1#viewer"),
  t("coc_document_a5:1", "viewer", "coc_document_a5:1#editor"),

  t("icc_document_a5:1", "editor", "icc_document_a5:1#viewer"),

  t("tbc_document_a5:1", "viewer", "user_a5:jon"),
  t("tbc_document_a5:1", "restricted", "tbc_document_a5:1#viewer"),

  t("cac_document_a5:1", "viewer", "cac_document_a5:1#editor"),
  t("cac_document_a5:1", "editor", "cac_document_a5:1#viewer"),

  t("cat_document_a5:1", "allowed", "user_a5:jon"),

  t("fbc_document_a5:1", "restricted", "fbc_document_a5:1#viewer"),

  ...prongTuples("tpr", false),
  ...prongTuples("tpl", true),
  // three_prong_relation_possible_exclusion: same chain, no loop.
  t("tpe_module_a5:a", "owner", "user_a5:anne"),
  t("tpe_folder_a5:a", "parent", "tpe_module_a5:a"),
  t("tpe_document_a5:a", "parent", "tpe_folder_a5:a"),
  t("tpe_module_a5:b", "parent", "tpe_document_a5:a"),
  t("tpe_folder_a5:b", "parent", "tpe_module_a5:b"),
  t("tpe_document_a5:b", "parent", "tpe_folder_a5:b"),

  t("efs_group_a5:fga", "member", "user_a5:anne"),
  t("efs_folder_a5:a", "owner", "efs_group_a5:fga"),
  t("efs_document_a5:a", "owner", "efs_folder_a5:a"),

  t("ctd_company_a5:abc", "management", "user_a5:anne"),
  t("ctd_group_a5:fga", "corp", "ctd_company_a5:abc"),
  t("ctd_document_a5:a", "viewer", "ctd_group_a5:fga#member"),
  t("ctd_diagram_a5:a", "parent", "ctd_document_a5:a"),
];

describe("A5 cycles and recursive rewrites (upstream corpus)", () => {
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

    storeId = await fgaCreateStore("cycles-corpus");
    authorizationModelId = await fgaWriteModel(
      storeId,
      "./cycles-corpus/model.dsl",
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

  checks("cycle_or_cycle_return_false", [
    ["coc_document_a5:1", "viewer", "user_a5:jon", false],
  ]);
  checks("immediate_cycle_through_computed_userset", [
    ["icc_document_a5:1", "viewer", "user_a5:jon", false],
  ]);
  checks("true_butnot_cycle_return_false", [
    ["tbc_document_a5:1", "viewer", "user_a5:jon", false],
  ]);
  checks("cycle_and_cycle_return_false", [
    ["cac_document_a5:1", "viewer", "user_a5:jon", false],
  ]);
  checks("cycle_and_true_return_false", [
    ["cat_document_a5:1", "viewer", "user_a5:jon", false],
  ]);
  checks("immediate_cycle_return_false", [
    ["icr_document_a5:1", "viewer", "user_a5:jon", false],
  ]);
  checks("cycle_butnot_false_return_false", [
    ["cbf_document_a5:1", "viewer", "user_a5:jon", false],
  ]);
  checks("false_butnot_cycle_return_false", [
    ["fbc_document_a5:1", "viewer", "user_a5:jon", false],
  ]);

  checks("three_prong_relation", [
    ["tpr_module_a5:a", "viewer", "user_a5:anne", true],
    ["tpr_module_a5:b", "viewer", "user_a5:anne", true],
    ["tpr_folder_a5:a", "viewer", "user_a5:anne", true],
    ["tpr_folder_a5:b", "viewer", "user_a5:anne", true],
    ["tpr_document_a5:a", "viewer", "user_a5:anne", true],
    ["tpr_document_a5:b", "viewer", "user_a5:anne", true],
  ]);

  checks("three_prong_relation_loop", [
    ["tpl_module_a5:a", "viewer", "user_a5:anne", true],
    ["tpl_module_a5:b", "viewer", "user_a5:anne", true],
    ["tpl_folder_a5:a", "viewer", "user_a5:anne", true],
    ["tpl_folder_a5:b", "viewer", "user_a5:anne", true],
    ["tpl_document_a5:a", "viewer", "user_a5:anne", true],
    ["tpl_document_a5:b", "viewer", "user_a5:anne", true],
  ]);

  checks("three_prong_relation_possible_exclusion", [
    ["tpe_module_a5:a", "viewer", "user_a5:anne", true],
    ["tpe_module_a5:b", "viewer", "user_a5:anne", true],
    ["tpe_folder_a5:a", "viewer", "user_a5:anne", true],
    ["tpe_folder_a5:b", "viewer", "user_a5:anne", true],
    ["tpe_document_a5:a", "viewer", "user_a5:anne", true],
    ["tpe_document_a5:b", "viewer", "user_a5:anne", true],
  ]);

  checks("exclusion_for_some_relations", [
    ["efs_document_a5:a", "viewer", "user_a5:anne", true],
    ["efs_document_a5:a", "can_view", "user_a5:anne", true],
    ["efs_document_a5:a", "can_see", "user_a5:anne", true],
  ]);

  checks("contextual_tuple_ref_relation_disjoint", [
    ["ctd_document_a5:a", "viewer", "user_a5:anne", false],
    ["ctd_diagram_a5:a", "viewer", "user_a5:anne", false],
  ]);

  test("the relation configs say what the model says", () => {
    expectConfigsMatchModel("./cycles-corpus/model.dsl", fixture, {
      coverage: "complete",
    });
  });
});
