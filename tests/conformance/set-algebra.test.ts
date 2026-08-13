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
 * The set-operator composition matrix, ported from OpenFGA's own
 * behavioural corpus (`assets/tests/consolidated_1_1_tests.yaml`,
 * v1.18.2): `union_and_exclusion`, `intersection_and_exclusion`,
 * `exclusion_and_intersection_in_subtract`,
 * `exclusion_and_exclusion_in_base`,
 * `exclusion_and_exclusion_in_subtract`,
 * `exclusion_under_wildcard_in_intersection` and its two
 * variants.
 *
 * Every expectation is transcribed from upstream's own
 * `expectation:` field rather than derived here, so a shape both
 * engines get wrong the same way still fails.
 *
 * tsfga has no nested set-operator form -- `excludedBy` is one
 * relation name and `intersection` is a flat operand list -- so
 * each nested operand is decomposed onto an `h_`-prefixed helper
 * relation and declared as such below.
 */

const NAMES = [
  "aardvark",
  "badger",
  "cheetah",
  "duck",
  "eagle",
  "fox",
  "alice",
  "eve",
  "ue1",
  "ue2",
  "ue3",
  "ue4",
  "ie1",
  "ie2",
  "ie3",
  "ie4",
  "ie5",
  "ie6",
  "eis1",
  "eis2",
  "eis3",
  "eis4",
  "eeb1",
  "eeb2",
  "eeb3",
  "ees1",
  "ees2",
  "ees3",
  "wc1",
  "wc2",
  "wc3",
] as const;

const uuidMap = new Map<string, string>(
  NAMES.map((name, index) => [
    name,
    `00000000-0000-4000-d440-${String(index + 1).padStart(12, "0")}`,
  ]),
);

function uuid(name: string): string {
  const id = uuidMap.get(name);
  if (!id) throw new Error(`No UUID for ${name}`);
  return id;
}

const USER = "user_a5";
const DOC = "document_a5";

/** A relation config with every optional arm defaulted to "none". */
function cfg(
  relation: string,
  overrides: Partial<RelationConfig> = {},
): RelationConfig {
  return {
    objectType: DOC,
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

/** `relation` on `object` granted to `user`. */
function t(user: string, relation: string, object: string): AddTupleRequest {
  return {
    objectType: DOC,
    objectId: uuid(object),
    relation,
    subjectType: USER,
    subjectId: user === "*" ? "*" : uuid(user),
  };
}

const TUPLES: AddTupleRequest[] = [
  // union_and_exclusion
  t("aardvark", "writer", "ue1"),
  t("badger", "editor", "ue1"),
  t("badger", "owner", "ue2"),
  t("cheetah", "editor", "ue3"),
  t("duck", "owner", "ue4"),
  // intersection_and_exclusion
  t("aardvark", "writer", "ie1"),
  t("aardvark", "editor", "ie1"),
  t("aardvark", "owner", "ie1"),
  t("badger", "writer", "ie2"),
  t("badger", "editor", "ie2"),
  t("cheetah", "writer", "ie3"),
  t("cheetah", "owner", "ie3"),
  t("duck", "writer", "ie4"),
  t("eagle", "editor", "ie5"),
  t("fox", "owner", "ie6"),
  // exclusion_and_intersection_in_subtract
  t("aardvark", "writer", "eis1"),
  t("aardvark", "editor", "eis1"),
  t("aardvark", "owner", "eis1"),
  t("badger", "writer", "eis2"),
  t("badger", "editor", "eis2"),
  t("cheetah", "writer", "eis3"),
  t("cheetah", "owner", "eis3"),
  t("duck", "writer", "eis4"),
  // exclusion_and_exclusion_in_base
  t("aardvark", "writer", "eeb1"),
  t("aardvark", "editor", "eeb1"),
  t("badger", "writer", "eeb2"),
  t("badger", "owner", "eeb2"),
  t("cheetah", "writer", "eeb3"),
  // exclusion_and_exclusion_in_subtract
  t("aardvark", "writer", "ees1"),
  t("aardvark", "editor", "ees1"),
  t("aardvark", "owner", "ees1"),
  t("badger", "writer", "ees2"),
  t("badger", "editor", "ees2"),
  t("cheetah", "writer", "ees3"),
  t("cheetah", "owner", "ees3"),
  // exclusion_under_wildcard_in_intersection
  t("*", "org_member", "wc1"),
  t("eve", "banned", "wc1"),
  t("alice", "active", "wc1"),
  t("eve", "active", "wc1"),
  // ..._only_wildcard
  t("*", "org_member", "wc2"),
  t("eve", "banned", "wc2"),
  t("*", "active_wc", "wc2"),
  // ..._three_operand
  t("*", "org_member", "wc3"),
  t("eve", "banned", "wc3"),
  t("alice", "active", "wc3"),
  t("eve", "active", "wc3"),
  t("alice", "verified", "wc3"),
  t("eve", "verified", "wc3"),
];

const DIRECT: RelationConfig[] = [
  cfg("writer", { directlyAssignable: [{ type: USER }] }),
  cfg("editor", { directlyAssignable: [{ type: USER }] }),
  cfg("owner", { directlyAssignable: [{ type: USER }] }),
  cfg("banned", { directlyAssignable: [{ type: USER }] }),
  cfg("active", { directlyAssignable: [{ type: USER }] }),
  cfg("verified", { directlyAssignable: [{ type: USER }] }),
  cfg("active_wc", {
    directlyAssignable: [{ type: USER, wildcard: true }, { type: USER }],
  }),
  cfg("org_member", {
    directlyAssignable: [{ type: USER, wildcard: true }, { type: USER }],
  }),
];

/** Nested operands tsfga has no single form for. */
const HELPERS: RelationConfig[] = [
  cfg("h_editor_not_owner", {
    computedUserset: "editor",
    excludedBy: "owner",
  }),
  cfg("h_editor_and_owner", {
    intersection: [
      { type: "computedUserset", relation: "editor" },
      { type: "computedUserset", relation: "owner" },
    ],
  }),
  cfg("h_writer_not_editor", {
    computedUserset: "writer",
    excludedBy: "editor",
  }),
  cfg("h_org_member_not_banned", {
    computedUserset: "org_member",
    excludedBy: "banned",
  }),
];

const COMPOSED: RelationConfig[] = [
  // writer or (editor but not owner)
  cfg("u_or_ex", { impliedBy: ["writer", "h_editor_not_owner"] }),
  // writer and (editor but not owner)
  cfg("i_and_ex", {
    intersection: [
      { type: "computedUserset", relation: "writer" },
      { type: "computedUserset", relation: "h_editor_not_owner" },
    ],
  }),
  // writer but not (editor and owner)
  cfg("ex_and_i_sub", {
    computedUserset: "writer",
    excludedBy: "h_editor_and_owner",
  }),
  // (writer but not editor) but not owner
  cfg("ex_and_ex_base", {
    computedUserset: "h_writer_not_editor",
    excludedBy: "owner",
  }),
  // writer but not (editor but not owner)
  cfg("ex_and_ex_sub", {
    computedUserset: "writer",
    excludedBy: "h_editor_not_owner",
  }),
  // (org_member but not banned) and active
  cfg("wc_ex_in_int", {
    intersection: [
      { type: "computedUserset", relation: "h_org_member_not_banned" },
      { type: "computedUserset", relation: "active" },
    ],
  }),
  // (org_member but not banned) and active_wc
  cfg("wc_ex_in_int_wc", {
    intersection: [
      { type: "computedUserset", relation: "h_org_member_not_banned" },
      { type: "computedUserset", relation: "active_wc" },
    ],
  }),
  // (org_member but not banned) and active and verified
  cfg("wc_ex_in_int3", {
    intersection: [
      { type: "computedUserset", relation: "h_org_member_not_banned" },
      { type: "computedUserset", relation: "active" },
      { type: "computedUserset", relation: "verified" },
    ],
  }),
];

describe("A5 set-operator composition (upstream corpus)", () => {
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

    for (const config of [...DIRECT, ...HELPERS, ...COMPOSED]) {
      await tsfgaClient.writeRelationConfig(config);
    }
    for (const tuple of TUPLES) {
      await tsfgaClient.addTuple(tuple);
    }

    storeId = await fgaCreateStore("set-algebra");
    authorizationModelId = await fgaWriteModel(
      storeId,
      "./set-algebra/model.dsl",
    );
    await fgaWriteTuplesRaw(
      storeId,
      authorizationModelId,
      TUPLES.map((tuple) => ({
        user: `${tuple.subjectType}:${tuple.subjectId}`,
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
    relation: string,
    rows: ReadonlyArray<[string, string, CheckOutcome]>,
  ): void {
    for (const [user, object, expected] of rows) {
      test(`${relation}: ${user} on ${object} is ${expected}`, async () => {
        await expectConformance(
          storeId,
          authorizationModelId,
          tsfgaClient,
          {
            objectType: DOC,
            objectId: uuid(object),
            relation,
            subjectType: USER,
            subjectId: uuid(user),
          },
          expected,
        );
      });
    }
  }

  describe("union_and_exclusion: writer or (editor but not owner)", () => {
    checks("u_or_ex", [
      ["aardvark", "ue1", true],
      ["badger", "ue1", true],
      ["badger", "ue2", false],
      ["cheetah", "ue3", true],
      ["duck", "ue4", false],
    ]);
  });

  describe("intersection_and_exclusion: writer and (editor but not owner)", () => {
    checks("i_and_ex", [
      ["aardvark", "ie1", false],
      ["badger", "ie2", true],
      ["cheetah", "ie3", false],
      ["duck", "ie4", false],
      ["eagle", "ie5", false],
      ["fox", "ie6", false],
    ]);
  });

  describe("exclusion_and_intersection_in_subtract", () => {
    checks("ex_and_i_sub", [
      ["aardvark", "eis1", false],
      ["badger", "eis2", true],
      ["cheetah", "eis3", true],
      ["duck", "eis4", true],
    ]);
  });

  describe("exclusion_and_exclusion_in_base", () => {
    checks("ex_and_ex_base", [
      ["aardvark", "eeb1", false],
      ["badger", "eeb2", false],
      ["cheetah", "eeb3", true],
    ]);
  });

  describe("exclusion_and_exclusion_in_subtract", () => {
    checks("ex_and_ex_sub", [
      ["aardvark", "ees1", true],
      ["badger", "ees2", false],
      ["cheetah", "ees3", true],
    ]);
  });

  describe("exclusion_under_wildcard_in_intersection", () => {
    checks("wc_ex_in_int", [
      ["alice", "wc1", true],
      ["eve", "wc1", false],
    ]);
    checks("wc_ex_in_int_wc", [
      ["eve", "wc2", false],
      ["alice", "wc2", true],
    ]);
    checks("wc_ex_in_int3", [
      ["alice", "wc3", true],
      ["eve", "wc3", false],
    ]);
  });

  test("the relation configs say what the model says", () => {
    expectConfigsMatchModel("./set-algebra/model.dsl", fixture, {
      coverage: "complete",
      tsfgaOnlyHelpers: HELPERS.map((c) => `${c.objectType}.${c.relation}`),
    });
  });
});
