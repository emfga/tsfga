import { afterAll, beforeAll, describe, test } from "bun:test";
import {
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
  expectPinnedDivergence,
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

/**
 * Recursive and mutually recursive relations, which the record
 * expresses natively — `[user] or viewer from parent` is one
 * `directlyAssignable` plus one `tupleToUserset` entry — but which
 * upstream resolves through dedicated recursive resolvers rather
 * than the generic path. The shapes are here because a native
 * encoding is not the same thing as a matching answer.
 *
 * Chains are three levels deep, well inside the default depth
 * budget, so nothing here is testing the documented depth boundary.
 */

const uuidMap = new Map<string, string>([
  ["alice", "00000000-0000-4000-d460-000000000041"],
  ["bob", "00000000-0000-4000-d460-000000000042"],
  ["carol", "00000000-0000-4000-d460-000000000043"],
  ["dave", "00000000-0000-4000-d460-000000000044"],
  ["f1", "00000000-0000-4000-d460-000000000051"],
  ["f2", "00000000-0000-4000-d460-000000000052"],
  ["f3", "00000000-0000-4000-d460-000000000053"],
  ["fc1", "00000000-0000-4000-d460-000000000054"],
  ["fc2", "00000000-0000-4000-d460-000000000055"],
  ["t1", "00000000-0000-4000-d460-000000000061"],
  ["t2", "00000000-0000-4000-d460-000000000062"],
  ["t3", "00000000-0000-4000-d460-000000000063"],
  ["tc1", "00000000-0000-4000-d460-000000000064"],
  ["tc2", "00000000-0000-4000-d460-000000000065"],
]);

function uuid(name: string): string {
  const id = uuidMap.get(name);
  if (!id) throw new Error(`No UUID for ${name}`);
  return id;
}

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

describe("Recursive relation conformance", () => {
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

    await tsfgaClient.writeRelationConfig(
      config("folder_a7r", "parent", {
        directlyAssignable: [{ type: "folder_a7r" }],
      }),
    );
    await tsfgaClient.writeRelationConfig(
      config("folder_a7r", "viewer", {
        directlyAssignable: [{ type: "user_a7r" }],
        tupleToUserset: [{ tupleset: "parent", computedUserset: "viewer" }],
      }),
    );
    await tsfgaClient.writeRelationConfig(
      config("folder_a7r", "blocked", {
        directlyAssignable: [{ type: "user_a7r" }],
        tupleToUserset: [{ tupleset: "parent", computedUserset: "blocked" }],
      }),
    );
    await tsfgaClient.writeRelationConfig(
      config("folder_a7r", "can_read", {
        computedUserset: "viewer",
        excludedBy: "blocked",
      }),
    );

    await tsfgaClient.writeRelationConfig(
      config("team_a7r", "parent", {
        directlyAssignable: [{ type: "team_a7r" }],
      }),
    );
    await tsfgaClient.writeRelationConfig(
      config("team_a7r", "member", {
        directlyAssignable: [{ type: "user_a7r" }],
        tupleToUserset: [{ tupleset: "parent", computedUserset: "lead" }],
      }),
    );
    await tsfgaClient.writeRelationConfig(
      config("team_a7r", "lead", {
        directlyAssignable: [{ type: "user_a7r" }],
        tupleToUserset: [{ tupleset: "parent", computedUserset: "member" }],
      }),
    );

    const link = (
      objectType: string,
      child: string,
      parent: string,
    ): Promise<void> =>
      tsfgaClient.addTuple({
        objectType,
        objectId: uuid(child),
        relation: "parent",
        subjectType: objectType,
        subjectId: uuid(parent),
      });
    const grant = (
      objectType: string,
      object: string,
      relation: string,
      user: string,
    ): Promise<void> =>
      tsfgaClient.addTuple({
        objectType,
        objectId: uuid(object),
        relation,
        subjectType: "user_a7r",
        subjectId: uuid(user),
      });

    await link("folder_a7r", "f2", "f1");
    await link("folder_a7r", "f3", "f2");
    await grant("folder_a7r", "f1", "viewer", "alice");
    await grant("folder_a7r", "f1", "viewer", "bob");
    await grant("folder_a7r", "f2", "blocked", "alice");

    await link("folder_a7r", "fc1", "fc2");
    await link("folder_a7r", "fc2", "fc1");
    await grant("folder_a7r", "fc1", "viewer", "alice");

    await link("team_a7r", "t2", "t1");
    await link("team_a7r", "t3", "t2");
    await grant("team_a7r", "t1", "lead", "carol");
    await grant("team_a7r", "t1", "member", "dave");

    await link("team_a7r", "tc1", "tc2");
    await link("team_a7r", "tc2", "tc1");

    storeId = await fgaCreateStore("recursive-relations");
    authorizationModelId = await fgaWriteModel(
      storeId,
      "./recursive-relations/model.dsl",
    );
    await fgaWriteTuples(
      storeId,
      "./recursive-relations/tuples.yaml",
      authorizationModelId,
      uuidMap,
    );
  });

  afterAll(async () => {
    await rollbackTransaction(db);
    await destroyDb();
  });

  function checkOn(
    objectType: string,
    object: string,
    relation: string,
    user: string,
    expected: boolean,
  ): Promise<void> {
    return expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType,
        objectId: uuid(object),
        relation,
        subjectType: "user_a7r",
        subjectId: uuid(user),
      },
      expected,
    );
  }

  // define viewer: [user] or viewer from parent
  const chain: ReadonlyArray<readonly [string, string, string, boolean]> = [
    ["f1", "viewer", "alice", true],
    ["f2", "viewer", "alice", true],
    ["f3", "viewer", "alice", true],
    ["f1", "blocked", "alice", false],
    ["f2", "blocked", "alice", true],
    ["f3", "blocked", "alice", true],
    ["f1", "can_read", "alice", true],
    ["f2", "can_read", "alice", false],
    ["f3", "can_read", "alice", false],
    ["f1", "can_read", "bob", true],
    ["f2", "can_read", "bob", true],
    ["f3", "can_read", "bob", true],
    ["f1", "viewer", "carol", false],
    ["f3", "viewer", "carol", false],
  ];
  for (const [object, relation, user, expected] of chain) {
    test(`folder ${object} ${relation} ${user} is ${expected}`, async () => {
      await checkOn("folder_a7r", object, relation, user, expected);
    });
  }

  // The recursion walks a cycle in the data rather than a chain.
  test("a recursive relation over a parent cycle still grants", async () => {
    await checkOn("folder_a7r", "fc2", "viewer", "alice", true);
  });
  test("a recursive relation over a parent cycle denies a stranger", async () => {
    await checkOn("folder_a7r", "fc2", "viewer", "carol", false);
  });
  // At the root a cycled `false` and a plain `false` are the same
  // answer, so the subtrahend itself agrees...
  test("the cycling subtrahend answers false on both engines", async () => {
    await checkOn("folder_a7r", "fc1", "blocked", "alice", false);
  });
  test("the cycling subtrahend, one hop out", async () => {
    await checkOn("folder_a7r", "fc2", "blocked", "alice", false);
  });

  // ...and only the subtract position tells them apart. This is
  // the documented "recursive relations" divergence: upstream's
  // recursive TTU resolver walks the reachable set iteratively and
  // reports a definitive `false`, so the exclusion does not fire;
  // tsfga's single resolver reports indeterminacy and denies.
  // Pinned rather than asserted, per `packages/core/README.md`.
  test("recursive subtrahend over a data cycle: pinned divergence", async () => {
    await expectPinnedDivergence(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "folder_a7r",
        objectId: uuid("fc1"),
        relation: "can_read",
        subjectType: "user_a7r",
        subjectId: uuid("alice"),
      },
      { openfga: true, tsfga: false },
    );
  });
  test("recursive subtrahend over a data cycle, one hop out", async () => {
    await expectPinnedDivergence(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "folder_a7r",
        objectId: uuid("fc2"),
        relation: "can_read",
        subjectType: "user_a7r",
        subjectId: uuid("alice"),
      },
      { openfga: true, tsfga: false },
    );
  });

  // define member: [user] or lead from parent
  // define lead:   [user] or member from parent
  const mutual: ReadonlyArray<readonly [string, string, string, boolean]> = [
    ["t1", "member", "dave", true],
    ["t1", "lead", "carol", true],
    ["t1", "lead", "dave", false],
    ["t1", "member", "carol", false],
    ["t2", "member", "carol", true],
    ["t2", "member", "dave", false],
    ["t2", "lead", "dave", true],
    ["t2", "lead", "carol", false],
    ["t3", "member", "dave", true],
    ["t3", "member", "carol", false],
    ["t3", "lead", "carol", true],
    ["t3", "lead", "dave", false],
  ];
  for (const [object, relation, user, expected] of mutual) {
    test(`team ${object} ${relation} ${user} is ${expected}`, async () => {
      await checkOn("team_a7r", object, relation, user, expected);
    });
  }

  test("mutual recursion over a team cycle terminates and denies", async () => {
    await checkOn("team_a7r", "tc1", "member", "carol", false);
  });
  test("mutual recursion over a team cycle, the other relation", async () => {
    await checkOn("team_a7r", "tc2", "lead", "dave", false);
  });

  test("the relation configs say what the model says", () => {
    expectConfigsMatchModel("./recursive-relations/model.dsl", fixture, {
      coverage: "complete",
    });
  });
});
