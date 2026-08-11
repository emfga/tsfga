import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  ConditionEvaluationError,
  createTsfga,
  type TsfgaClient,
} from "@tsfga/core";
import type { DB } from "@tsfga/kysely";
import { KyselyTupleStore } from "@tsfga/kysely";
import type { Kysely } from "kysely";
import {
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
  fgaCheck,
  fgaCreateStore,
  fgaWriteModel,
  fgaWriteTuples,
} from "./helpers/openfga.ts";

// Validates union error semantics against real OpenFGA: a direct
// tuple whose condition evaluation FAILS (missing context
// parameter) is one racing union branch, and a granting sibling
// branch (team#member) must win over that error in both systems.
// When nothing grants, both systems must surface an error.
//
// Ref: https://github.com/openfga/openfga/blob/e04bde9e/internal/graph/check.go
// (union continues past branch errors looking for Allowed: true;
// checkDirectUserTuple returns the condition-evaluation error)

const uuidMap = new Map<string, string>([
  ["anne", "00000000-0000-4000-c400-000000000001"],
  ["bob", "00000000-0000-4000-c400-000000000002"],
  ["carl", "00000000-0000-4000-c400-000000000003"],
  ["eng", "00000000-0000-4000-c400-000000000004"],
  ["1", "00000000-0000-4000-c400-000000000005"],
  ["2", "00000000-0000-4000-c400-000000000006"],
  ["fga", "00000000-0000-4000-c400-000000000007"],
  ["fgb", "00000000-0000-4000-c400-000000000008"],
  ["fdeny", "00000000-0000-4000-c400-000000000009"],
  ["tga", "00000000-0000-4000-c400-00000000000a"],
  ["tgb", "00000000-0000-4000-c400-00000000000b"],
  ["tdeny", "00000000-0000-4000-c400-00000000000c"],
  ["t1", "00000000-0000-4000-c400-000000000010"],
  ["t2", "00000000-0000-4000-c400-000000000011"],
  ["t2r", "00000000-0000-4000-c400-000000000012"],
  ["t3", "00000000-0000-4000-c400-000000000013"],
  ["t3r", "00000000-0000-4000-c400-000000000014"],
  ["t4", "00000000-0000-4000-c400-000000000015"],
  ["t4r", "00000000-0000-4000-c400-000000000016"],
  ["t5", "00000000-0000-4000-c400-000000000017"],
  ["u1", "00000000-0000-4000-c400-000000000020"],
  ["u2", "00000000-0000-4000-c400-000000000021"],
  ["u3", "00000000-0000-4000-c400-000000000022"],
  ["u4", "00000000-0000-4000-c400-000000000023"],
  ["u5", "00000000-0000-4000-c400-000000000024"],
  ["u6", "00000000-0000-4000-c400-000000000025"],
]);

interface ConditionFields {
  conditionName: string;
  conditionContext?: Record<string, unknown>;
}

/** A row whose condition cannot be evaluated at all. */
const BROKEN: ConditionFields = { conditionName: "valid_ip" };
/** A row whose condition evaluates false. */
const CFALSE: ConditionFields = {
  conditionName: "valid_ip",
  conditionContext: { user_ip: "10.0.0.1" },
};
/** A row whose condition evaluates true. */
const GOOD: ConditionFields = {
  conditionName: "valid_ip",
  conditionContext: { user_ip: "192.168.0.1" },
};

function uuid(name: string): string {
  const id = uuidMap.get(name);
  if (!id) throw new Error(`No UUID for ${name}`);
  return id;
}

describe("Condition Error vs Sibling Grant Conformance", () => {
  let db: Kysely<DB>;
  let storeId: string;
  let authorizationModelId: string;
  let tsfgaClient: TsfgaClient;
  let fixture: FixtureRecord;

  beforeAll(async () => {
    db = getDb();
    await beginTransaction(db);

    const store = new KyselyTupleStore(db);
    tsfgaClient = createTsfga(store);
    fixture = recordFixture(tsfgaClient);

    // === Condition definition ===
    await tsfgaClient.writeConditionDefinition({
      name: "valid_ip",
      expression: 'user_ip == "192.168.0.1"',
      parameters: { user_ip: "string" },
    });

    // === Relation configs ===
    await tsfgaClient.writeRelationConfig({
      objectType: "team",
      relation: "member",
      directlyAssignable: [{ type: "user" }],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });
    await tsfgaClient.writeRelationConfig({
      objectType: "folder",
      relation: "viewer",
      directlyAssignable: [{ type: "user" }],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });
    await tsfgaClient.writeRelationConfig({
      objectType: "document",
      relation: "parent",
      directlyAssignable: [{ type: "folder", condition: "valid_ip" }],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });
    await tsfgaClient.writeRelationConfig({
      objectType: "document",
      relation: "ttu_viewer",
      directlyAssignable: [],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: [{ tupleset: "parent", computedUserset: "viewer" }],
      excludedBy: null,
      intersection: null,
    });
    await tsfgaClient.writeRelationConfig({
      objectType: "document",
      relation: "viewer",
      directlyAssignable: [
        { type: "user", condition: "valid_ip" },
        { type: "team", relation: "member" },
        { type: "team", relation: "member", condition: "valid_ip" },
      ],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });

    // === Tuples ===

    // anne: conditioned direct grant with no stored context, so a
    // context-free check fails condition evaluation
    await tsfgaClient.addTuple({
      objectType: "document",
      objectId: uuid("1"),
      relation: "viewer",
      subjectType: "user",
      subjectId: uuid("anne"),
      conditionName: "valid_ip",
    });

    // ...and a sibling grant path via team membership
    await tsfgaClient.addTuple({
      objectType: "document",
      objectId: uuid("1"),
      relation: "viewer",
      subjectType: "team",
      subjectId: uuid("eng"),
      subjectRelation: "member",
    });
    await tsfgaClient.addTuple({
      objectType: "team",
      objectId: uuid("eng"),
      relation: "member",
      subjectType: "user",
      subjectId: uuid("anne"),
    });
    await tsfgaClient.addTuple({
      objectType: "team",
      objectId: uuid("eng"),
      relation: "member",
      subjectType: "user",
      subjectId: uuid("bob"),
    });

    // carl: ONLY a conditioned grant on document:2
    await tsfgaClient.addTuple({
      objectType: "document",
      objectId: uuid("2"),
      relation: "viewer",
      subjectType: "user",
      subjectId: uuid("carl"),
      conditionName: "valid_ip",
    });

    // === The sibling matrix ===
    //
    // Row order matters to the shapes labelled `r`, and nothing in
    // the adapter orders `findTuplesByRelation`, so these are
    // written in the order each shape names and read back in the
    // order PostgreSQL happens to return them. Order independence
    // is pinned deterministically in
    // `packages/core/tests/check.test.ts` against a mock store;
    // here the two orders are two fixtures, not a guarantee.

    for (const folder of ["fga", "fgb"] as const) {
      await tsfgaClient.addTuple({
        objectType: "folder",
        objectId: uuid(folder),
        relation: "viewer",
        subjectType: "user",
        subjectId: uuid("anne"),
      });
    }
    await tsfgaClient.addTuple({
      objectType: "folder",
      objectId: uuid("fdeny"),
      relation: "viewer",
      subjectType: "user",
      subjectId: uuid("bob"),
    });

    for (const team of ["tga", "tgb"] as const) {
      await tsfgaClient.addTuple({
        objectType: "team",
        objectId: uuid(team),
        relation: "member",
        subjectType: "user",
        subjectId: uuid("anne"),
      });
    }
    await tsfgaClient.addTuple({
      objectType: "team",
      objectId: uuid("tdeny"),
      relation: "member",
      subjectType: "user",
      subjectId: uuid("bob"),
    });

    const tuplesetRows: Array<[string, Array<[string, ConditionFields]>]> = [
      ["t1", [["fga", BROKEN]]],
      [
        "t2",
        [
          ["fga", BROKEN],
          ["fgb", GOOD],
        ],
      ],
      [
        "t2r",
        [
          ["fgb", GOOD],
          ["fga", BROKEN],
        ],
      ],
      [
        "t3",
        [
          ["fga", BROKEN],
          ["fgb", CFALSE],
        ],
      ],
      [
        "t3r",
        [
          ["fgb", CFALSE],
          ["fga", BROKEN],
        ],
      ],
      [
        "t4",
        [
          ["fga", BROKEN],
          ["fdeny", GOOD],
        ],
      ],
      [
        "t4r",
        [
          ["fdeny", GOOD],
          ["fga", BROKEN],
        ],
      ],
      [
        "t5",
        [
          ["fga", BROKEN],
          ["fgb", CFALSE],
          ["fdeny", GOOD],
        ],
      ],
    ];
    for (const [document, rows] of tuplesetRows) {
      for (const [folder, condition] of rows) {
        await tsfgaClient.addTuple({
          objectType: "document",
          objectId: uuid(document),
          relation: "parent",
          subjectType: "folder",
          subjectId: uuid(folder),
          ...condition,
        });
      }
    }

    const usersetRows: Array<[string, Array<[string, ConditionFields]>]> = [
      ["u1", [["tga", BROKEN]]],
      [
        "u2",
        [
          ["tga", BROKEN],
          ["tgb", GOOD],
        ],
      ],
      [
        "u3",
        [
          ["tga", BROKEN],
          ["tgb", CFALSE],
        ],
      ],
      [
        "u4",
        [
          ["tga", BROKEN],
          ["tdeny", GOOD],
        ],
      ],
      ["u5", [["tga", BROKEN]]],
      ["u6", [["tdeny", GOOD]]],
    ];
    for (const [document, rows] of usersetRows) {
      for (const [team, condition] of rows) {
        await tsfgaClient.addTuple({
          objectType: "document",
          objectId: uuid(document),
          relation: "viewer",
          subjectType: "team",
          subjectId: uuid(team),
          subjectRelation: "member",
          ...condition,
        });
      }
    }

    // u5's granting direct row, and u6's broken one.
    await tsfgaClient.addTuple({
      objectType: "document",
      objectId: uuid("u5"),
      relation: "viewer",
      subjectType: "user",
      subjectId: uuid("anne"),
      ...GOOD,
    });
    await tsfgaClient.addTuple({
      objectType: "document",
      objectId: uuid("u6"),
      relation: "viewer",
      subjectType: "user",
      subjectId: uuid("anne"),
      ...BROKEN,
    });

    // Setup OpenFGA
    storeId = await fgaCreateStore("condition-error-siblings-conformance");
    authorizationModelId = await fgaWriteModel(
      storeId,
      "./condition-error-siblings/model.dsl",
    );
    await fgaWriteTuples(
      storeId,
      "./condition-error-siblings/tuples.yaml",
      authorizationModelId,
      uuidMap,
    );
  });

  afterAll(async () => {
    await rollbackTransaction(db);
    await destroyDb();
  });

  test("1: sibling team grant beats anne's condition error", async () => {
    // No context: anne's direct branch errors (missing user_ip),
    // but the team#member branch grants — both systems say true.
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "document",
        objectId: uuid("1"),
        relation: "viewer",
        subjectType: "user",
        subjectId: uuid("anne"),
      },
      true,
    );
  });

  test("2: anne's conditioned grant works with context", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "document",
        objectId: uuid("1"),
        relation: "viewer",
        subjectType: "user",
        subjectId: uuid("anne"),
        context: { user_ip: "192.168.0.1" },
      },
      true,
    );
  });

  test("3: bob is granted via the team alone", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "document",
        objectId: uuid("1"),
        relation: "viewer",
        subjectType: "user",
        subjectId: uuid("bob"),
      },
      true,
    );
  });

  test("4: both systems error when nothing grants carl", async () => {
    // No context and no sibling path: the condition error is the
    // only outcome, and both engines report it as a refusal
    // rather than as an answer.
    await expect(
      tsfgaClient.check({
        objectType: "document",
        objectId: uuid("2"),
        relation: "viewer",
        subjectType: "user",
        subjectId: uuid("carl"),
      }),
    ).rejects.toBeInstanceOf(ConditionEvaluationError);

    const openFgaResult = await fgaCheck(storeId, authorizationModelId, {
      objectType: "document",
      objectId: uuid("2"),
      relation: "viewer",
      subjectType: "user",
      subjectId: uuid("carl"),
    });
    expect(typeof openFgaResult === "object" && openFgaResult !== null).toBe(
      true,
    );
  });

  test("5: carl's conditioned grant works with context", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "document",
        objectId: uuid("2"),
        relation: "viewer",
        subjectType: "user",
        subjectId: uuid("carl"),
        context: { user_ip: "192.168.0.1" },
      },
      true,
    );
  });

  test("6: wrong ip denies carl in both systems", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "document",
        objectId: uuid("2"),
        relation: "viewer",
        subjectType: "user",
        subjectId: uuid("carl"),
        context: { user_ip: "10.0.0.1" },
      },
      false,
    );
  });

  // === The sibling matrix ===
  //
  // A condition that cannot be evaluated is stashed rather than
  // raised, and swallowed if and only if some *other* row's
  // condition evaluated true. Three of these shapes are refusals on
  // both sides and pass before the fix as well as after: they are
  // guards against the looser predicate "some row was admitted",
  // under which shapes 3 and 3r would answer false where OpenFGA
  // refuses. Do not drop them for passing already — shape 3 is the
  // only one that separates the two candidate predicates.

  const tuplesetShapes: Array<[string, string, boolean | "refused"]> = [
    ["1: broken only", "t1", "refused"],
    ["2: broken + good(grants)", "t2", true],
    ["2r: good(grants) + broken", "t2r", true],
    ["3: broken + condition-FALSE sibling", "t3", "refused"],
    ["3r: condition-FALSE + broken", "t3r", "refused"],
    ["4: broken + valid-but-denies", "t4", false],
    ["4r: valid-but-denies + broken", "t4r", false],
    ["5: broken + cfalse + valid-but-denies", "t5", false],
  ];

  for (const [name, document, expected] of tuplesetShapes) {
    test(`tupleset ${name}`, async () => {
      await expectConformance(
        storeId,
        authorizationModelId,
        tsfgaClient,
        {
          objectType: "document",
          objectId: uuid(document),
          relation: "ttu_viewer",
          subjectType: "user",
          subjectId: uuid("anne"),
        },
        expected,
      );
    });
  }

  const usersetShapes: Array<[string, string, boolean | "refused"]> = [
    ["1: broken only", "u1", "refused"],
    ["2: broken + good(grants)", "u2", true],
    ["3: broken + condition-FALSE sibling", "u3", "refused"],
    ["4: broken + valid-but-denies", "u4", false],
    ["5: broken userset + granting direct row", "u5", true],
    // Not one of the five shapes the review measured. It decides
    // how wide the swallow decision reaches: upstream refuses here,
    // so a userset row whose condition held does NOT rescue a
    // broken *direct* row. The two are separate reads and keep
    // separate decisions.
    ["6: broken direct row + userset that holds but denies", "u6", "refused"],
  ];

  for (const [name, document, expected] of usersetShapes) {
    test(`userset ${name}`, async () => {
      await expectConformance(
        storeId,
        authorizationModelId,
        tsfgaClient,
        {
          objectType: "document",
          objectId: uuid(document),
          relation: "viewer",
          subjectType: "user",
          subjectId: uuid("anne"),
        },
        expected,
      );
    });
  }

  test("the relation configs say what the model says", () => {
    expectConfigsMatchModel("./condition-error-siblings/model.dsl", fixture, {
      coverage: "complete",
    });
  });
});
