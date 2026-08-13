import { afterAll, beforeAll, describe, test } from "bun:test";
import {
  type CheckRequest,
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
  expectToleratedNondeterminism,
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
  fgaWriteTuples,
} from "./helpers/openfga.ts";

// Wildcards in every position the check algorithm can meet one:
// beside a named row on the same relation, carrying a condition,
// reached through a userset hop, as the base of an exclusion, as an
// intersection operand, and as the *subject* of the check itself.

const uuidMap = new Map<string, string>();
const names = [
  "alice",
  "bob",
  "t1",
  "t2",
  "t3",
  "w1",
  "w2",
  "w3",
  "w4",
  "w5",
  "w6",
];
for (const [i, name] of names.entries()) {
  uuidMap.set(
    name,
    `00000000-0000-4000-d400-0000000005${String(i).padStart(2, "0")}`,
  );
}

function uuid(name: string): string {
  const id = uuidMap.get(name);
  if (!id) throw new Error(`No UUID for ${name}`);
  return id;
}

const GOOD = { user_ip: "192.168.0.1" };
const BAD = { user_ip: "10.0.0.1" };

const EMPTY = {
  directlyAssignable: [],
  impliedBy: null,
  computedUserset: null,
  tupleToUserset: null,
  excludedBy: null,
  intersection: null,
} satisfies Omit<RelationConfig, "objectType" | "relation">;

describe("a1: wildcards", () => {
  let db: Kysely<DB>;
  let storeId: string;
  let authorizationModelId: string;
  let tsfgaClient: TsfgaClient;
  let fixture: FixtureRecord;

  async function check(
    request: CheckRequest,
    expected: CheckOutcome,
  ): Promise<void> {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      request,
      expected,
    );
  }

  function on(
    object: string,
    relation: string,
    subject: string,
    context?: Record<string, unknown>,
  ): CheckRequest {
    return {
      objectType: "doc_a1",
      objectId: uuid(object),
      relation,
      subjectType: "user_a1",
      subjectId: subject === "*" ? "*" : uuid(subject),
      ...(context ? { context } : {}),
    };
  }

  beforeAll(async () => {
    db = getDb();
    await beginTransaction(db);

    tsfgaClient = createTsfga(new KyselyTupleStore(db));
    fixture = recordFixture(tsfgaClient);

    await tsfgaClient.writeConditionDefinition({
      name: "valid_ip_a1",
      expression: 'user_ip == "192.168.0.1"',
      parameters: { user_ip: "string" },
    });

    const configs: RelationConfig[] = [
      {
        ...EMPTY,
        objectType: "team_a1",
        relation: "member",
        directlyAssignable: [
          { type: "user_a1", wildcard: true, condition: "valid_ip_a1" },
        ],
      },
      {
        ...EMPTY,
        objectType: "doc_a1",
        relation: "both",
        directlyAssignable: [
          { type: "user_a1" },
          { type: "user_a1", wildcard: true },
        ],
      },
      {
        ...EMPTY,
        objectType: "doc_a1",
        relation: "conditioned",
        directlyAssignable: [
          { type: "user_a1", wildcard: true, condition: "valid_ip_a1" },
        ],
      },
      {
        ...EMPTY,
        objectType: "doc_a1",
        relation: "via_team",
        directlyAssignable: [{ type: "team_a1", relation: "member" }],
      },
      {
        ...EMPTY,
        objectType: "team2_a1",
        relation: "member",
        directlyAssignable: [{ type: "user_a1", condition: "valid_ip_a1" }],
      },
      {
        ...EMPTY,
        objectType: "doc_a1",
        relation: "via_team2",
        directlyAssignable: [{ type: "team2_a1", relation: "member" }],
      },
      {
        ...EMPTY,
        objectType: "doc_a1",
        relation: "blocked",
        directlyAssignable: [{ type: "user_a1" }],
      },
      {
        ...EMPTY,
        objectType: "doc_a1",
        relation: "ok",
        computedUserset: "both",
        excludedBy: "blocked",
      },
      {
        ...EMPTY,
        objectType: "doc_a1",
        relation: "wild_and_named",
        intersection: [
          { type: "computedUserset", relation: "conditioned" },
          { type: "computedUserset", relation: "both" },
        ],
      },
    ];
    for (const config of configs) {
      await tsfgaClient.writeRelationConfig(config);
    }

    await tsfgaClient.addTuple({
      objectType: "doc_a1",
      objectId: uuid("w1"),
      relation: "both",
      subjectType: "user_a1",
      subjectId: "*",
    });
    await tsfgaClient.addTuple({
      objectType: "doc_a1",
      objectId: uuid("w1"),
      relation: "both",
      subjectType: "user_a1",
      subjectId: uuid("bob"),
    });
    await tsfgaClient.addTuple({
      objectType: "doc_a1",
      objectId: uuid("w1"),
      relation: "blocked",
      subjectType: "user_a1",
      subjectId: uuid("alice"),
    });
    await tsfgaClient.addTuple({
      objectType: "doc_a1",
      objectId: uuid("w2"),
      relation: "both",
      subjectType: "user_a1",
      subjectId: uuid("bob"),
    });
    await tsfgaClient.addTuple({
      objectType: "doc_a1",
      objectId: uuid("w3"),
      relation: "conditioned",
      subjectType: "user_a1",
      subjectId: "*",
      conditionName: "valid_ip_a1",
    });
    await tsfgaClient.addTuple({
      objectType: "doc_a1",
      objectId: uuid("w3"),
      relation: "both",
      subjectType: "user_a1",
      subjectId: "*",
    });
    await tsfgaClient.addTuple({
      objectType: "team_a1",
      objectId: uuid("t1"),
      relation: "member",
      subjectType: "user_a1",
      subjectId: "*",
      conditionName: "valid_ip_a1",
      conditionContext: GOOD,
    });
    await tsfgaClient.addTuple({
      objectType: "doc_a1",
      objectId: uuid("w4"),
      relation: "via_team",
      subjectType: "team_a1",
      subjectId: uuid("t1"),
      subjectRelation: "member",
    });
    await tsfgaClient.addTuple({
      objectType: "team_a1",
      objectId: uuid("t2"),
      relation: "member",
      subjectType: "user_a1",
      subjectId: "*",
      conditionName: "valid_ip_a1",
    });
    await tsfgaClient.addTuple({
      objectType: "doc_a1",
      objectId: uuid("w5"),
      relation: "via_team",
      subjectType: "team_a1",
      subjectId: uuid("t2"),
      subjectRelation: "member",
    });

    await tsfgaClient.addTuple({
      objectType: "team2_a1",
      objectId: uuid("t3"),
      relation: "member",
      subjectType: "user_a1",
      subjectId: uuid("alice"),
      conditionName: "valid_ip_a1",
    });
    await tsfgaClient.addTuple({
      objectType: "doc_a1",
      objectId: uuid("w6"),
      relation: "via_team2",
      subjectType: "team2_a1",
      subjectId: uuid("t3"),
      subjectRelation: "member",
    });

    storeId = await fgaCreateStore("wildcard-positions");
    authorizationModelId = await fgaWriteModel(
      storeId,
      "./wildcard-positions/model.dsl",
    );
    await fgaWriteTuples(
      storeId,
      "./wildcard-positions/tuples.yaml",
      authorizationModelId,
      uuidMap,
    );
  });

  afterAll(async () => {
    await rollbackTransaction(db);
    await destroyDb();
  });

  test("a wildcard beside a named row on the same relation", async () => {
    await check(on("w1", "both", "alice"), true);
    await check(on("w1", "both", "bob"), true);
    await check(on("w2", "both", "alice"), false);
    await check(on("w2", "both", "bob"), true);
  });

  test("a conditioned wildcard", async () => {
    await check(on("w3", "conditioned", "alice", GOOD), true);
    await check(on("w3", "conditioned", "alice", BAD), false);
    await check(on("w3", "conditioned", "alice"), "refused");
  });

  test("a live conditioned wildcard reached through a userset hop", async () => {
    await check(on("w4", "via_team", "alice"), true);
  });

  test("003: a broken conditioned wildcard one userset hop down", async () => {
    // The same row shape at the *root* node refuses on both engines
    // (see "a conditioned wildcard" above), and the same shape
    // without the wildcard refuses on both a hop down (see below).
    // Only the conditioned wildcard behind a dispatch answers two
    // ways, and only on upstream: alone this file measures `false`
    // every run, inside the full suite it measures a refusal. See
    // `expectToleratedNondeterminism` for why that is tolerated
    // rather than pinned.
    await expectToleratedNondeterminism(
      storeId,
      authorizationModelId,
      tsfgaClient,
      on("w5", "via_team", "alice"),
      { tsfga: "refused", openfga: [false, "refused"] },
    );
  });

  test("a conditioned wildcard one hop down, with context", async () => {
    await check(on("w5", "via_team", "alice", GOOD), true);
    await check(on("w5", "via_team", "alice", BAD), false);
  });

  test("a broken named row one userset hop down", async () => {
    await check(on("w6", "via_team2", "alice"), "refused");
    await check(on("w6", "via_team2", "alice", GOOD), true);
    await check(on("w6", "via_team2", "alice", BAD), false);
  });

  test("a wildcard base with a named subtrahend", async () => {
    await check(on("w1", "ok", "alice"), false);
    await check(on("w1", "ok", "bob"), true);
  });

  test("a conditioned wildcard as an intersection operand", async () => {
    await check(on("w3", "wild_and_named", "alice", GOOD), true);
    await check(on("w3", "wild_and_named", "alice", BAD), false);
  });

  test("the wildcard subject itself", async () => {
    // `user_a1:*` matches only the wildcard row, never a named one.
    await check(on("w1", "both", "*"), true);
    await check(on("w2", "both", "*"), false);
    await check(on("w1", "ok", "*"), true);
    await check(on("w3", "conditioned", "*", GOOD), true);
  });

  test("the relation configs say what the model says", () => {
    expectConfigsMatchModel("./wildcard-positions/model.dsl", fixture, {
      coverage: "complete",
    });
  });
});
