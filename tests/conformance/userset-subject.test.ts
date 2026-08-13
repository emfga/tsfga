import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  type AddTupleRequest,
  createTsfga,
  type RelationConfig,
  type TsfgaClient,
  TsfgaError,
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
 * A **userset as the subject of a check**.
 *
 * OpenFGA's Check and ListObjects both accept a `user` of the form
 * `type:id#relation` — "does this whole userset hold the
 * relation?" — and it is the subject form the generated corpora
 * lean on hardest: `tests/check/complexity_three.go` and
 * `check_userset.go` (v1.18.2) assert it in almost every case, as
 * `User: "ttus:...#direct_pa_direct_ch"`.
 *
 * tsfga spells the subject as three fields, so the form is
 * `subjectRelation`. The question it asks is a comparison, not an
 * expansion: `us_group_a5:eng#member` holds `viewer` iff a row
 * grants that exact userset or a rewrite of `viewer` reaches one.
 * The tests below fix the three edges of that, each measured
 * against the v1.18.2 container:
 *
 * - `team#member` and `team` are different subjects, in both
 *   directions;
 * - a typed wildcard never grants a userset;
 * - a userset whose relation the model does not define is refused,
 *   not denied.
 */

const NAMES = ["1", "2", "eng", "other", "alice", "f1"] as const;

const uuidMap = new Map<string, string>(
  NAMES.map((name, index) => [
    name,
    `00000000-0000-4000-d446-${String(index + 1).padStart(12, "0")}`,
  ]),
);

function uuid(name: string): string {
  const id = uuidMap.get(name);
  if (!id) throw new Error(`No UUID for ${name}`);
  return id;
}

const USER = "user_a5";
const GROUP = "us_group_a5";
const FOLDER = "us_folder_a5";
const DOC = "us_document_a5";

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

// In dependency order: a rewrite's premises are written before it,
// so the tupleset gates in `writeRelationConfig` see them.
const CONFIGS: RelationConfig[] = [
  cfg(GROUP, "member", { directlyAssignable: [{ type: USER }] }),
  cfg(GROUP, "admin", { directlyAssignable: [{ type: USER }] }),
  cfg(FOLDER, "viewer", {
    directlyAssignable: [{ type: GROUP, relation: "member" }],
  }),
  cfg(DOC, "parent", { directlyAssignable: [{ type: FOLDER }] }),
  cfg(DOC, "viewer", {
    directlyAssignable: [{ type: GROUP, relation: "member" }],
  }),
  cfg(DOC, "can_view", { computedUserset: "viewer" }),
  // A bare-type restriction, so a userset subject is not admitted.
  cfg(DOC, "owner", { directlyAssignable: [{ type: GROUP }] }),
  // A typed wildcard, which a userset subject never matches.
  cfg(DOC, "anyone", {
    directlyAssignable: [{ type: GROUP, wildcard: true }],
  }),
  cfg(DOC, "inherited", {
    tupleToUserset: [{ tupleset: "parent", computedUserset: "viewer" }],
  }),
  cfg(DOC, "blocked", {
    directlyAssignable: [{ type: GROUP, relation: "member" }],
  }),
  cfg(DOC, "restricted", {
    computedUserset: "viewer",
    excludedBy: "blocked",
  }),
];

const TUPLES: AddTupleRequest[] = [
  {
    objectType: DOC,
    objectId: uuid("1"),
    relation: "viewer",
    subjectType: GROUP,
    subjectId: uuid("eng"),
    subjectRelation: "member",
  },
  {
    objectType: DOC,
    objectId: uuid("2"),
    relation: "viewer",
    subjectType: GROUP,
    subjectId: uuid("eng"),
    subjectRelation: "member",
  },
  {
    objectType: GROUP,
    objectId: uuid("eng"),
    relation: "member",
    subjectType: USER,
    subjectId: uuid("alice"),
  },
  {
    objectType: DOC,
    objectId: uuid("1"),
    relation: "owner",
    subjectType: GROUP,
    subjectId: uuid("eng"),
  },
  {
    objectType: DOC,
    objectId: uuid("1"),
    relation: "anyone",
    subjectType: GROUP,
    subjectId: "*",
  },
  {
    objectType: FOLDER,
    objectId: uuid("f1"),
    relation: "viewer",
    subjectType: GROUP,
    subjectId: uuid("eng"),
    subjectRelation: "member",
  },
  {
    objectType: DOC,
    objectId: uuid("1"),
    relation: "parent",
    subjectType: FOLDER,
    subjectId: uuid("f1"),
  },
  {
    objectType: DOC,
    objectId: uuid("2"),
    relation: "blocked",
    subjectType: GROUP,
    subjectId: uuid("other"),
    subjectRelation: "member",
  },
];

describe("A5 userset as the check subject", () => {
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

    storeId = await fgaCreateStore("userset-subject");
    authorizationModelId = await fgaWriteModel(
      storeId,
      "./userset-subject/model.dsl",
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

  // Controls: the same model answered for a concrete subject.
  test("control: alice is a viewer through the userset", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: DOC,
        objectId: uuid("1"),
        relation: "viewer",
        subjectType: USER,
        subjectId: uuid("alice"),
      },
      true,
    );
  });

  test("control: alice reaches can_view through the rewrite", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: DOC,
        objectId: uuid("1"),
        relation: "can_view",
        subjectType: USER,
        subjectId: uuid("alice"),
      },
      true,
    );
  });

  test("a userset subject holds the relation it was granted", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: DOC,
        objectId: uuid("1"),
        relation: "viewer",
        subjectType: GROUP,
        subjectId: uuid("eng"),
        subjectRelation: "member",
      },
      true,
    );
  });

  test("a userset subject reaches a computed relation", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: DOC,
        objectId: uuid("1"),
        relation: "can_view",
        subjectType: GROUP,
        subjectId: uuid("eng"),
        subjectRelation: "member",
      },
      true,
    );
  });

  test("an ungranted userset subject is denied", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: DOC,
        objectId: uuid("1"),
        relation: "viewer",
        subjectType: GROUP,
        subjectId: uuid("other"),
        subjectRelation: "member",
      },
      false,
    );
  });

  test("listObjects reaches objects for a userset subject", async () => {
    await expectListObjectsConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: DOC,
        relation: "viewer",
        subjectType: GROUP,
        subjectId: uuid("eng"),
        subjectRelation: "member",
      },
      [uuid("1"), uuid("2")],
    );
  });

  test("a userset subject reaches through a tuple-to-userset", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: DOC,
        objectId: uuid("1"),
        relation: "inherited",
        subjectType: GROUP,
        subjectId: uuid("eng"),
        subjectRelation: "member",
      },
      true,
    );
  });

  test("a userset subject on the base side of an exclusion", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: DOC,
        objectId: uuid("2"),
        relation: "restricted",
        subjectType: GROUP,
        subjectId: uuid("eng"),
        subjectRelation: "member",
      },
      true,
    );
  });

  test("a userset subject the subtrahend excludes", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: DOC,
        objectId: uuid("2"),
        relation: "restricted",
        subjectType: GROUP,
        subjectId: uuid("other"),
        subjectRelation: "member",
      },
      false,
    );
  });

  // The userset ref and the bare type are matched exactly and in
  // both directions, exactly as `formatRestriction` writes them.
  test("a restriction naming team#member denies the bare team", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: DOC,
        objectId: uuid("1"),
        relation: "viewer",
        subjectType: GROUP,
        subjectId: uuid("eng"),
      },
      false,
    );
  });

  test("a restriction naming team denies the userset team#member", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: DOC,
        objectId: uuid("1"),
        relation: "owner",
        subjectType: GROUP,
        subjectId: uuid("eng"),
        subjectRelation: "member",
      },
      false,
    );
  });

  test("control: the bare team holds the bare restriction", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: DOC,
        objectId: uuid("1"),
        relation: "owner",
        subjectType: GROUP,
        subjectId: uuid("eng"),
      },
      true,
    );
  });

  // A userset can never be a wildcard, so neither the wildcard row
  // nor the wildcard retry in the type graph applies to it.
  test("a typed wildcard does not grant a userset subject", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: DOC,
        objectId: uuid("1"),
        relation: "anyone",
        subjectType: GROUP,
        subjectId: uuid("eng"),
        subjectRelation: "member",
      },
      false,
    );
  });

  test("control: the same wildcard grants the bare subject", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: DOC,
        objectId: uuid("1"),
        relation: "anyone",
        subjectType: GROUP,
        subjectId: uuid("eng"),
      },
      true,
    );
  });

  test("a userset naming a relation it was not granted is denied", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: DOC,
        objectId: uuid("1"),
        relation: "viewer",
        subjectType: GROUP,
        subjectId: uuid("eng"),
        subjectRelation: "admin",
      },
      false,
    );
  });

  // A userset holds its own relation on its own object by
  // definition, ahead of the model: upstream answers this in
  // `IsSelfDefining`, before the relation's restrictions or the
  // type graph are consulted, and `member` admits no userset at
  // all.
  test("a userset holds its own relation on its own object", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: GROUP,
        objectId: uuid("eng"),
        relation: "member",
        subjectType: GROUP,
        subjectId: uuid("eng"),
        subjectRelation: "member",
      },
      true,
    );
  });

  // Refusals. Each is a refusal on *both* engines: upstream
  // validates the `user` field before resolving anything and
  // answers a validation error rather than `false`.
  test("a subject relation the type does not define is refused", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: DOC,
        objectId: uuid("1"),
        relation: "viewer",
        subjectType: GROUP,
        subjectId: uuid("eng"),
        subjectRelation: "nonexistent_a5",
      },
      "refused",
    );
  });

  test("a subject type the model does not define is refused", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: DOC,
        objectId: uuid("1"),
        relation: "viewer",
        subjectType: "nonexistent_type_a5",
        subjectId: uuid("eng"),
        subjectRelation: "member",
      },
      "refused",
    );
  });

  test("a wildcard subject carrying a subject relation is refused", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: DOC,
        objectId: uuid("1"),
        relation: "viewer",
        subjectType: GROUP,
        subjectId: "*",
        subjectRelation: "member",
      },
      "refused",
    );
  });

  /**
   * One-sided on purpose. `subjectId: "<id>#member"` is a valid
   * `user` string on OpenFGA's wire, which has one field for the
   * whole subject, and upstream answers `true` for it. tsfga has
   * three fields, so the same spelling is a caller forwarding a
   * ref into the wrong one — and before this landed it resolved
   * quietly to `false`, which is indistinguishable from a real
   * denial. There is no divergence to pin here: the two engines
   * are being handed different requests.
   */
  test("a ref smuggled through the subject id is refused", async () => {
    await expect(
      tsfgaClient.check({
        objectType: DOC,
        objectId: uuid("1"),
        relation: "viewer",
        subjectType: GROUP,
        subjectId: `${uuid("eng")}#member`,
      }),
    ).rejects.toBeInstanceOf(TsfgaError);
  });

  /**
   * The node memo keys on the subject *relation* as well as on the
   * subject's type and id.
   *
   * `checkMany` answers a whole batch in one resolution scope, so
   * two requests differing only in the subject relation resolve
   * against one memo. Leave the relation out of the key and the
   * first answer is handed back for the second question — here,
   * `true` for a subject the model denies.
   */
  test("the userset and the bare subject do not share a memo entry", async () => {
    const node = {
      objectType: DOC,
      objectId: uuid("1"),
      relation: "viewer",
      subjectType: GROUP,
      subjectId: uuid("eng"),
    };
    const outcomes = await tsfgaClient.checkMany([
      { ...node, subjectRelation: "member" },
      node,
      { ...node, subjectRelation: "admin" },
    ]);
    expect(outcomes.map((outcome) => outcome.allowed)).toEqual([
      true,
      false,
      false,
    ]);
  });

  test("listObjects tells the userset and the bare subject apart", async () => {
    await expectListObjectsConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: DOC,
        relation: "owner",
        subjectType: GROUP,
        subjectId: uuid("eng"),
        subjectRelation: "member",
      },
      [],
    );
    await expectListObjectsConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: DOC,
        relation: "owner",
        subjectType: GROUP,
        subjectId: uuid("eng"),
      },
      [uuid("1")],
    );
  });

  test("the relation configs say what the model says", () => {
    expectConfigsMatchModel("./userset-subject/model.dsl", fixture, {
      coverage: "complete",
    });
  });
});
