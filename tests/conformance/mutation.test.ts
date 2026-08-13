import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { OpenFgaClient } from "@openfga/sdk";
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
  type FixtureRecord,
  recordFixture,
} from "./helpers/conformance.ts";
import {
  beginTransaction,
  destroyDb,
  getDb,
  rollbackTransaction,
} from "./helpers/db.ts";
import { fgaCreateStore, fgaWriteModel } from "./helpers/openfga.ts";

/**
 * Write/read interleaving.
 *
 * Every other fixture in the suite writes its tuples once and then
 * only reads. This one mutates between checks, because that is the
 * shape a caching bug hides in: a relation config, a condition
 * definition or a node result held past the write that invalidated
 * it answers correctly on the first check of a process and wrongly
 * on the second.
 *
 * The mutations are applied to both engines and the answer is
 * asserted on both after each one, so a stale read on either side
 * is a failure rather than a difference nobody looks at.
 *
 * Deletion needs an OpenFGA client of its own: the shared helpers
 * write tuples and never remove them.
 */

const USER = "user_d5m";
const GROUP = "group_d5m";
const DOC = "doc_d5m";

const ALICE = "00000000-0000-4000-d560-000000020001";
const DOC1 = "00000000-0000-4000-d560-000000020002";
const ENG = "00000000-0000-4000-d560-000000020003";

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
  config(GROUP, "member", { directlyAssignable: [{ type: USER }] }),
  config(DOC, "banned", { directlyAssignable: [{ type: USER }] }),
  config(DOC, "viewer", {
    directlyAssignable: [{ type: USER }, { type: GROUP, relation: "member" }],
  }),
  config(DOC, "can_view", {
    computedUserset: "viewer",
    excludedBy: "banned",
  }),
];

const VIEWER_ALICE: AddTupleRequest = {
  objectType: DOC,
  objectId: DOC1,
  relation: "viewer",
  subjectType: USER,
  subjectId: ALICE,
};
const BANNED_ALICE: AddTupleRequest = {
  objectType: DOC,
  objectId: DOC1,
  relation: "banned",
  subjectType: USER,
  subjectId: ALICE,
};
const VIEWER_ENG: AddTupleRequest = {
  objectType: DOC,
  objectId: DOC1,
  relation: "viewer",
  subjectType: GROUP,
  subjectId: ENG,
  subjectRelation: "member",
};
const MEMBER_ALICE: AddTupleRequest = {
  objectType: GROUP,
  objectId: ENG,
  relation: "member",
  subjectType: USER,
  subjectId: ALICE,
};

function fgaRef(tuple: AddTupleRequest): {
  user: string;
  relation: string;
  object: string;
} {
  return {
    user: tuple.subjectRelation
      ? `${tuple.subjectType}:${tuple.subjectId}#${tuple.subjectRelation}`
      : `${tuple.subjectType}:${tuple.subjectId}`,
    relation: tuple.relation,
    object: `${tuple.objectType}:${tuple.objectId}`,
  };
}

describe("D5 write/read interleaving", () => {
  let db: Kysely<DB>;
  let storeId: string;
  let authorizationModelId: string;
  let client: TsfgaClient;
  let fga: OpenFgaClient;
  let fixture: FixtureRecord;

  /** Write one tuple on both engines. */
  async function grant(tuple: AddTupleRequest): Promise<void> {
    await client.addTuple(tuple);
    await fga.writeTuples([fgaRef(tuple)], { authorizationModelId });
  }

  /** Remove one tuple from both engines. */
  async function revoke(tuple: AddTupleRequest): Promise<void> {
    await client.removeTuple(tuple);
    await fga.deleteTuples([fgaRef(tuple)], { authorizationModelId });
  }

  async function expectCheck(
    relation: string,
    expected: boolean,
  ): Promise<void> {
    await expectConformance(
      storeId,
      authorizationModelId,
      client,
      {
        objectType: DOC,
        objectId: DOC1,
        relation,
        subjectType: USER,
        subjectId: ALICE,
      },
      expected,
    );
  }

  beforeAll(async () => {
    db = getDb();
    await beginTransaction(db);

    client = createTsfga(new KyselyTupleStore(db));
    fixture = recordFixture(client);
    for (const relationConfig of CONFIGS) {
      await client.writeRelationConfig(relationConfig);
    }

    storeId = await fgaCreateStore("mutation");
    authorizationModelId = await fgaWriteModel(storeId, "./mutation/model.dsl");
    fga = new OpenFgaClient({ apiUrl: process.env.FGA_API_URL, storeId });
  });

  afterAll(async () => {
    await rollbackTransaction(db);
    await destroyDb();
  });

  // Sequential by construction: each step depends on the store
  // state the previous one left behind.
  test("1: nothing is granted before anything is written", async () => {
    await expectCheck("viewer", false);
    await expectCheck("can_view", false);
  });

  test("2: a grant is visible to the very next check", async () => {
    await grant(VIEWER_ALICE);
    await expectCheck("viewer", true);
    await expectCheck("can_view", true);
  });

  test("3: a ban is visible to the very next check", async () => {
    await grant(BANNED_ALICE);
    await expectCheck("viewer", true);
    await expectCheck("can_view", false);
  });

  test("4: lifting the ban is visible to the very next check", async () => {
    await revoke(BANNED_ALICE);
    await expectCheck("can_view", true);
  });

  test("5: revoking the grant is visible to the very next check", async () => {
    await revoke(VIEWER_ALICE);
    await expectCheck("viewer", false);
    await expectCheck("can_view", false);
  });

  test("6: a contextual tuple grants where no row exists", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      client,
      {
        objectType: DOC,
        objectId: DOC1,
        relation: "can_view",
        subjectType: USER,
        subjectId: ALICE,
        contextualTuples: [VIEWER_ALICE],
      },
      true,
    );
  });

  test("7: a contextual tuple duplicating a stored row still grants", async () => {
    await grant(VIEWER_ALICE);
    await expectConformance(
      storeId,
      authorizationModelId,
      client,
      {
        objectType: DOC,
        objectId: DOC1,
        relation: "can_view",
        subjectType: USER,
        subjectId: ALICE,
        contextualTuples: [VIEWER_ALICE],
      },
      true,
    );
    // And the overlay leaves nothing behind: the plain check that
    // follows must answer from the store alone.
    await expectCheck("can_view", true);
  });

  test("8: a stored ban outranks a contextual grant", async () => {
    await grant(BANNED_ALICE);
    await expectConformance(
      storeId,
      authorizationModelId,
      client,
      {
        objectType: DOC,
        objectId: DOC1,
        relation: "can_view",
        subjectType: USER,
        subjectId: ALICE,
        contextualTuples: [VIEWER_ALICE],
      },
      false,
    );
    await revoke(BANNED_ALICE);
    await revoke(VIEWER_ALICE);
  });

  test("9: membership added and removed under a userset grant", async () => {
    await grant(VIEWER_ENG);
    await expectCheck("viewer", false);
    await grant(MEMBER_ALICE);
    await expectCheck("viewer", true);
    await expectCheck("can_view", true);
    await revoke(MEMBER_ALICE);
    await expectCheck("viewer", false);
    await revoke(VIEWER_ENG);
  });

  test("10: twenty checks straddling one grant never answer stale", async () => {
    // Ten before, the write, ten after — on one client, so a
    // process-wide cache of anything tuple-shaped would show up
    // as the eleventh answer still being the first one.
    for (let run = 0; run < 10; run++) {
      expect(
        await client.check({
          objectType: DOC,
          objectId: DOC1,
          relation: "viewer",
          subjectType: USER,
          subjectId: ALICE,
        }),
      ).toBe(false);
    }
    await grant(VIEWER_ALICE);
    for (let run = 0; run < 10; run++) {
      expect(
        await client.check({
          objectType: DOC,
          objectId: DOC1,
          relation: "viewer",
          subjectType: USER,
          subjectId: ALICE,
        }),
      ).toBe(true);
    }
    await expectCheck("can_view", true);
    await revoke(VIEWER_ALICE);
  });

  test("11: a config deleted between checks stops answering", async () => {
    // The relation-config cache is scoped to one call, so the
    // check after the delete must refuse rather than reuse the
    // config the check before it read.
    await grant(VIEWER_ALICE);
    await expectCheck("viewer", true);
    expect(await client.deleteRelationConfig(DOC, "viewer")).toBe(true);
    await expect(
      client.check({
        objectType: DOC,
        objectId: DOC1,
        relation: "viewer",
        subjectType: USER,
        subjectId: ALICE,
      }),
    ).rejects.toBeInstanceOf(Error);
    await client.writeRelationConfig(
      config(DOC, "viewer", {
        directlyAssignable: [
          { type: USER },
          { type: GROUP, relation: "member" },
        ],
      }),
    );
    await expectCheck("viewer", true);
    await revoke(VIEWER_ALICE);
  });

  test("the relation configs say what the model says", () => {
    expectConfigsMatchModel("./mutation/model.dsl", fixture, {
      coverage: "complete",
    });
  });
});
