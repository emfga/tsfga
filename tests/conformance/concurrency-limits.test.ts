import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  type AddTupleRequest,
  type CheckRequest,
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
 * The concurrency limits must not be able to change an answer.
 *
 * `maxBreadth` bounds the branches of one resolution node and
 * `maxConcurrentChecks` bounds the checks of one `checkMany`
 * batch. Neither is a semantic knob: they decide how much work
 * runs at once, and the answer is supposed to be the same at 1, at
 * the default, and unbounded. Every check below is therefore run
 * against four clients that differ only in their limits, and each
 * run is a full two-engine `expectConformance` — so a limit that
 * moves an answer fails against OpenFGA, not merely against
 * another tsfga client.
 *
 * The model is deliberately wide *and* deep at the same node:
 * `group_d5:g1#member` carries thirteen userset rows, only the
 * last of which leads anywhere, and the trail behind it is five
 * more dispatches. Thirteen exceeds the default breadth of 10, so
 * the granting branch is in the second wave at the default, in the
 * thirteenth wave at breadth 1, and in the only wave at Infinity.
 *
 * The one shape excluded on purpose is a cycle reaching an
 * intersection operand, which `check.ts` documents as a place
 * where breadth legitimately changes the boolean — upstream has
 * the same exposure through its own concurrency limit. Everything
 * here is acyclic, so no such licence applies.
 */

const NAMES = [
  "alice",
  "bob",
  "carol",
  "dave",
  "eve",
  "g1",
  "g2",
  "g3",
  "g4",
  "g5",
  "g6",
  "gpub",
  "gx1",
  "gx2",
  "gx3",
  "gx4",
  "gx5",
  "gx6",
  "gx7",
  "gx8",
  "gx9",
  "gx10",
  "gx11",
  "gx12",
  "f1",
  "d1",
  "d2",
  "d3",
  "d4",
  "d5",
  "d6",
  "d7",
  "d8",
] as const;

const uuidMap = new Map<string, string>(
  NAMES.map((name, index) => [
    name,
    `00000000-0000-4000-d560-${String(index + 1).padStart(12, "0")}`,
  ]),
);

function uuid(name: string): string {
  const id = uuidMap.get(name);
  if (!id) throw new Error(`No UUID for ${name}`);
  return id;
}

const USER = "user_d5";
const GROUP = "group_d5";
const FOLDER = "folder_d5";
const DOC = "doc_d5";

/** The twelve decoy usersets that widen `group_d5:g1#member`. */
const DECOYS = [
  "gx1",
  "gx2",
  "gx3",
  "gx4",
  "gx5",
  "gx6",
  "gx7",
  "gx8",
  "gx9",
  "gx10",
  "gx11",
  "gx12",
] as const;

function config(
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

const CONFIGS: RelationConfig[] = [
  config(GROUP, "member", {
    directlyAssignable: [
      { type: USER },
      { type: USER, wildcard: true },
      { type: GROUP, relation: "member" },
    ],
  }),
  config(FOLDER, "owner", { directlyAssignable: [{ type: USER }] }),
  config(FOLDER, "viewer", {
    directlyAssignable: [{ type: USER }, { type: GROUP, relation: "member" }],
    impliedBy: ["owner"],
  }),
  config(DOC, "parent", { directlyAssignable: [{ type: FOLDER }] }),
  config(DOC, "owner", { directlyAssignable: [{ type: USER }] }),
  config(DOC, "banned", { directlyAssignable: [{ type: USER }] }),
  config(DOC, "editor", {
    directlyAssignable: [{ type: USER }, { type: GROUP, relation: "member" }],
    impliedBy: ["owner"],
  }),
  config(DOC, "viewer", {
    directlyAssignable: [
      { type: USER },
      { type: USER, wildcard: true },
      { type: GROUP, relation: "member" },
    ],
    impliedBy: ["editor"],
    tupleToUserset: [{ tupleset: "parent", computedUserset: "viewer" }],
  }),
  config(DOC, "can_view", {
    computedUserset: "viewer",
    excludedBy: "banned",
  }),
  config(DOC, "restricted", {
    intersection: [
      { type: "computedUserset", relation: "viewer" },
      { type: "computedUserset", relation: "editor" },
    ],
  }),
];

/** A direct `user_d5` grant. */
function user(
  objectType: string,
  object: string,
  relation: string,
  name: string,
): AddTupleRequest {
  return {
    objectType,
    objectId: uuid(object),
    relation,
    subjectType: USER,
    subjectId: name === "*" ? "*" : uuid(name),
  };
}

/** A `group_d5:<id>#member` grant. */
function members(
  objectType: string,
  object: string,
  relation: string,
  group: string,
): AddTupleRequest {
  return {
    objectType,
    objectId: uuid(object),
    relation,
    subjectType: GROUP,
    subjectId: uuid(group),
    subjectRelation: "member",
  };
}

const TUPLES: AddTupleRequest[] = [
  // The chain: alice reaches group:g1#member through five hops.
  user(GROUP, "g6", "member", "alice"),
  members(GROUP, "g5", "member", "g6"),
  members(GROUP, "g4", "member", "g5"),
  members(GROUP, "g3", "member", "g4"),
  members(GROUP, "g2", "member", "g3"),
  // Twelve dead ends written *before* the live one, so the branch
  // that grants is last in insertion order at every breadth.
  ...DECOYS.map((decoy) => members(GROUP, "g1", "member", decoy)),
  members(GROUP, "g1", "member", "g2"),
  // Everybody, through a group rather than on the document.
  user(GROUP, "gpub", "member", "*"),

  user(FOLDER, "f1", "owner", "bob"),

  user(DOC, "d1", "viewer", "*"),
  user(DOC, "d2", "viewer", "alice"),
  user(DOC, "d2", "banned", "alice"),
  {
    objectType: DOC,
    objectId: uuid("d3"),
    relation: "parent",
    subjectType: FOLDER,
    subjectId: uuid("f1"),
  },
  members(DOC, "d4", "editor", "g1"),
  user(DOC, "d5", "viewer", "alice"),
  user(DOC, "d6", "owner", "carol"),
  user(DOC, "d7", "banned", "bob"),
  {
    objectType: DOC,
    objectId: uuid("d7"),
    relation: "parent",
    subjectType: FOLDER,
    subjectId: uuid("f1"),
  },
  members(DOC, "d8", "viewer", "gpub"),
];

/** One question, and the answer both engines must give. */
interface Case {
  readonly name: string;
  readonly request: CheckRequest;
  readonly expected: boolean;
}

function doc(
  object: string,
  relation: string,
  subject: string,
  expected: boolean,
): Case {
  return {
    name: `${relation} on ${object} for ${subject}`,
    request: {
      objectType: DOC,
      objectId: uuid(object),
      relation,
      subjectType: USER,
      subjectId: uuid(subject),
    },
    expected,
  };
}

function group(object: string, subject: string, expected: boolean): Case {
  return {
    name: `member on ${object} for ${subject}`,
    request: {
      objectType: GROUP,
      objectId: uuid(object),
      relation: "member",
      subjectType: USER,
      subjectId: uuid(subject),
    },
    expected,
  };
}

const CASES: Case[] = [
  doc("d1", "viewer", "alice", true),
  doc("d1", "viewer", "eve", true),
  doc("d1", "can_view", "alice", true),
  doc("d1", "restricted", "alice", false),
  doc("d2", "viewer", "alice", true),
  doc("d2", "can_view", "alice", false),
  doc("d3", "viewer", "bob", true),
  doc("d3", "viewer", "alice", false),
  doc("d3", "can_view", "bob", true),
  doc("d4", "editor", "alice", true),
  doc("d4", "viewer", "alice", true),
  doc("d4", "restricted", "alice", true),
  doc("d4", "can_view", "alice", true),
  doc("d4", "editor", "bob", false),
  doc("d4", "restricted", "bob", false),
  doc("d5", "viewer", "alice", true),
  doc("d5", "restricted", "alice", false),
  doc("d6", "editor", "carol", true),
  doc("d6", "restricted", "carol", true),
  doc("d7", "viewer", "bob", true),
  doc("d7", "can_view", "bob", false),
  doc("d7", "can_view", "dave", false),
  doc("d8", "viewer", "dave", true),
  group("g1", "alice", true),
  group("g1", "dave", false),
  group("gpub", "dave", true),
];

describe("D5 concurrency limits do not move an answer", () => {
  let db: Kysely<DB>;
  let storeId: string;
  let authorizationModelId: string;
  let fixture: FixtureRecord;

  /**
   * Four clients over one store, differing only in their limits.
   * `narrow` runs one branch and one check at a time; `wide` runs
   * everything at once; `deep` widens only the depth budget, which
   * must not change an answer either on a model that fits inside
   * the default.
   */
  let narrow: TsfgaClient;
  let standard: TsfgaClient;
  let wide: TsfgaClient;
  let deep: TsfgaClient;

  beforeAll(async () => {
    db = getDb();
    await beginTransaction(db);

    const store = new KyselyTupleStore(db);
    standard = createTsfga(store);
    fixture = recordFixture(standard);
    narrow = createTsfga(store, {
      maxBreadth: 1,
      maxConcurrentChecks: 1,
    });
    wide = createTsfga(store, {
      maxBreadth: Number.POSITIVE_INFINITY,
      maxConcurrentChecks: Number.POSITIVE_INFINITY,
    });
    deep = createTsfga(store, { maxDepth: 200, maxBreadth: 3 });

    for (const relationConfig of CONFIGS) {
      await standard.writeRelationConfig(relationConfig);
    }
    for (const tuple of TUPLES) {
      await standard.addTuple(tuple);
    }

    storeId = await fgaCreateStore("concurrency-limits");
    authorizationModelId = await fgaWriteModel(
      storeId,
      "./concurrency-limits/model.dsl",
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

  describe("check, at every limit setting", () => {
    for (const testCase of CASES) {
      test(`${testCase.name} is ${testCase.expected}`, async () => {
        for (const client of [narrow, standard, wide, deep]) {
          await expectConformance(
            storeId,
            authorizationModelId,
            client,
            testCase.request,
            testCase.expected,
          );
        }
      });
    }
  });

  describe("checkMany, at every concurrency setting", () => {
    for (const client of [
      ["1", () => narrow],
      ["default", () => standard],
      ["Infinity", () => wide],
    ] as const) {
      const [label, pick] = client;
      test(`the whole corpus in one batch at maxConcurrentChecks=${label}`, async () => {
        const outcomes = await pick().checkMany(
          CASES.map((testCase) => testCase.request),
        );
        expect(outcomes.map((outcome) => outcome.error ?? null)).toEqual(
          CASES.map(() => null),
        );
        expect(outcomes.map((outcome) => outcome.allowed)).toEqual(
          CASES.map((testCase) => testCase.expected),
        );
      });
    }

    test("a batch of repeats answers the same as the batch of one", async () => {
      // Every request appears eight times, so the shared scope
      // coalesces most of them onto one resolution. A memo key too
      // coarse to tell two questions apart shows up here and
      // nowhere else.
      const repeated = [
        ...CASES,
        ...CASES,
        ...CASES,
        ...CASES,
        ...CASES,
        ...CASES,
        ...CASES,
        ...CASES,
      ];
      const outcomes = await standard.checkMany(
        repeated.map((testCase) => testCase.request),
      );
      expect(outcomes.map((outcome) => outcome.allowed)).toEqual(
        repeated.map((testCase) => testCase.expected),
      );
    });

    test("one shared context object answers as one per request", async () => {
      // `checkMany` groups scopes by the *reference identity* of
      // `context`, so the same batch answered with one shared
      // object and with a fresh equal object per request takes two
      // different paths through the scope map.
      const shared = { unused: 1 };
      const withShared = CASES.map((testCase) => ({
        ...testCase.request,
        context: shared,
      }));
      const withOwn = CASES.map((testCase) => ({
        ...testCase.request,
        context: { unused: 1 },
      }));
      const [a, b] = await Promise.all([
        standard.checkMany(withShared),
        standard.checkMany(withOwn),
      ]);
      expect(a.map((outcome) => outcome.allowed)).toEqual(
        CASES.map((testCase) => testCase.expected),
      );
      expect(b.map((outcome) => outcome.allowed)).toEqual(
        CASES.map((testCase) => testCase.expected),
      );
    });
  });

  describe("listObjects, at every limit setting", () => {
    const listings: ReadonlyArray<readonly [string, string, string[]]> = [
      ["viewer", "alice", ["d1", "d2", "d4", "d5", "d8"]],
      ["can_view", "alice", ["d1", "d4", "d5", "d8"]],
      ["viewer", "bob", ["d1", "d3", "d7", "d8"]],
      ["can_view", "bob", ["d1", "d3", "d8"]],
      ["restricted", "alice", ["d4"]],
      ["viewer", "dave", ["d1", "d8"]],
    ];

    for (const [relation, subject, expected] of listings) {
      test(`${relation} for ${subject}`, async () => {
        for (const client of [narrow, standard, wide, deep]) {
          await expectListObjectsConformance(
            storeId,
            authorizationModelId,
            client,
            {
              objectType: DOC,
              relation,
              subjectType: USER,
              subjectId: uuid(subject),
            },
            expected.map(uuid),
          );
        }
      });
    }
  });

  describe("stability under repetition", () => {
    // The shapes where a race could plausibly decide the answer:
    // an exclusion whose two sides resolve concurrently, an
    // intersection whose operands do, and a wide union whose
    // granting branch is last. Twenty-five runs each, against
    // tsfga alone — the two-engine assertion is above; what this
    // adds is that tsfga's own answer does not wander.
    const RUNS = 25;
    const racy: Case[] = [
      doc("d2", "can_view", "alice", false),
      doc("d7", "can_view", "bob", false),
      doc("d4", "restricted", "alice", true),
      doc("d4", "editor", "alice", true),
      doc("d5", "restricted", "alice", false),
    ];

    for (const testCase of racy) {
      test(`${testCase.name} answers ${testCase.expected} ${RUNS} times`, async () => {
        for (const client of [narrow, standard, wide]) {
          const answers = await Promise.all(
            Array.from({ length: RUNS }, () => client.check(testCase.request)),
          );
          expect(new Set(answers)).toEqual(new Set([testCase.expected]));
        }
      });
    }
  });

  test("the relation configs say what the model says", () => {
    expectConfigsMatchModel("./concurrency-limits/model.dsl", fixture, {
      coverage: "complete",
    });
  });
});
