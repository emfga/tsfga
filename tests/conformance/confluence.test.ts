import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ErrorCode, FgaApiValidationError, OpenFgaClient } from "@openfga/sdk";
import {
  type AddTupleRequest,
  createTsfga,
  type RemoveTupleRequest,
  type TsfgaClient,
} from "@tsfga/core";
import type { DB } from "@tsfga/kysely";
import { KyselyTupleStore } from "@tsfga/kysely";
import type { Kysely } from "kysely";
import {
  expectConfigsMatchModel,
  expectConformance,
  expectListObjectsConformance,
  expectWriteConformance,
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
import {
  assertUuidMapCovers,
  assertUuidMapInjective,
} from "./helpers/uuid-map.ts";

/**
 * A Confluence-shaped wiki: space -> page tree, with per-page
 * restrictions that *subtract* from what the tree inherits.
 *
 * Three seams are the point of this fixture.
 *
 * `page_c3f.open_view` is an exclusion whose minuend is a
 * two-armed, self-recursive tuple-to-userset — `can_view from
 * parent or can_view from space`. A page therefore inherits along
 * a chain and can have that inheritance cut at any link, and the
 * cut is visible to every page *below* it: `runbook` is locked to
 * `user_c3f:*`, so `appendix`, which is only reachable through
 * `runbook`, is readable exactly by `runbook`'s restricted
 * viewers.
 *
 * `page_c3f.locked` admits both a wildcard and a userset, so a
 * subtrahend may be "everyone" or "the contractors" and the second
 * has to expand a nested group to decide.
 *
 * The ids were human strings when this fixture was written,
 * because `object_id` was a `text` column at the time. They are
 * canonical UUIDs now: the column is `uuid` again and the store
 * declares its id domain, so the names live in a map and the
 * assertions read in names.
 */

const uuidMap = new Map<string, string>([
  ["bob", "00000000-0000-4000-d572-000000000001"],
  ["platform", "00000000-0000-4000-d572-000000000002"],
  ["engineering", "00000000-0000-4000-d572-000000000003"],
  ["carol", "00000000-0000-4000-d572-000000000004"],
  ["dave", "00000000-0000-4000-d572-000000000005"],
  ["contractors", "00000000-0000-4000-d572-000000000006"],
  ["alice", "00000000-0000-4000-d572-000000000007"],
  ["eng", "00000000-0000-4000-d572-000000000008"],
  ["public-docs", "00000000-0000-4000-d572-000000000009"],
  ["home", "00000000-0000-4000-d572-000000000010"],
  ["guide", "00000000-0000-4000-d572-000000000011"],
  ["runbook", "00000000-0000-4000-d572-000000000012"],
  ["appendix", "00000000-0000-4000-d572-000000000013"],
  ["salary-bands", "00000000-0000-4000-d572-000000000014"],
  ["changelog", "00000000-0000-4000-d572-000000000015"],
  ["frank", "00000000-0000-4000-d572-000000000016"],
]);

function uuid(name: string): string {
  const id = uuidMap.get(name);
  if (!id) throw new Error(`No UUID for ${name}`);
  return id;
}

describe("Confluence Model Conformance", () => {
  let db: Kysely<DB>;
  let storeId: string;
  let authorizationModelId: string;
  let tsfga: TsfgaClient;
  let fgaClient: OpenFgaClient;
  let fixture: FixtureRecord;

  function can(
    objectType: string,
    objectId: string,
    relation: string,
    subject: string,
    expected: boolean,
  ): Promise<void> {
    return expectConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType,
        objectId: uuid(objectId),
        relation,
        subjectType: "user_c3f",
        subjectId: uuid(subject),
      },
      expected,
    );
  }

  function userRef(tuple: {
    subjectType: string;
    subjectId: string;
    subjectRelation?: string | null;
  }): string {
    return tuple.subjectRelation
      ? `${tuple.subjectType}:${tuple.subjectId}#${tuple.subjectRelation}`
      : `${tuple.subjectType}:${tuple.subjectId}`;
  }

  /** Take a row out of both engines, asserting both had it. */
  async function revoke(tuple: RemoveTupleRequest): Promise<void> {
    await Promise.all([
      tsfga.removeTuple(tuple),
      fgaClient
        .deleteTuples(
          [
            {
              user: userRef(tuple),
              relation: tuple.relation,
              object: `${tuple.objectType}:${tuple.objectId}`,
            },
          ],
          { authorizationModelId },
        )
        .then(() => "deleted")
        .catch((error: unknown) => {
          if (
            error instanceof FgaApiValidationError &&
            error.apiErrorCode === ErrorCode.WriteFailedDueToInvalidInput
          ) {
            return "missing";
          }
          throw error;
        })
        .then((outcome) => {
          expect(outcome).toBe("deleted");
        }),
    ]);
  }

  beforeAll(async () => {
    assertUuidMapInjective(uuidMap);
    assertUuidMapCovers("./confluence/tuples.yaml", uuidMap);

    db = getDb();
    await beginTransaction(db);

    tsfga = createTsfga(new KyselyTupleStore(db));
    fixture = recordFixture(tsfga);

    const plain = {
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    } as const;

    await tsfga.writeRelationConfig({
      objectType: "group_c3f",
      relation: "member",
      directlyAssignable: [
        { type: "user_c3f" },
        { type: "group_c3f", relation: "member" },
      ],
      ...plain,
    });

    // === space_c3f ===
    await tsfga.writeRelationConfig({
      objectType: "space_c3f",
      relation: "admin",
      directlyAssignable: [
        { type: "user_c3f" },
        { type: "group_c3f", relation: "member" },
      ],
      ...plain,
    });
    await tsfga.writeRelationConfig({
      objectType: "space_c3f",
      relation: "member",
      directlyAssignable: [
        { type: "user_c3f" },
        { type: "group_c3f", relation: "member" },
      ],
      ...plain,
      impliedBy: ["admin"],
    });
    await tsfga.writeRelationConfig({
      objectType: "space_c3f",
      relation: "anonymous",
      directlyAssignable: [{ type: "user_c3f", wildcard: true }],
      ...plain,
    });
    await tsfga.writeRelationConfig({
      objectType: "space_c3f",
      relation: "can_view",
      directlyAssignable: [],
      ...plain,
      impliedBy: ["member", "anonymous"],
    });
    await tsfga.writeRelationConfig({
      objectType: "space_c3f",
      relation: "can_admin",
      directlyAssignable: [],
      ...plain,
      computedUserset: "admin",
    });

    // === page_c3f ===
    await tsfga.writeRelationConfig({
      objectType: "page_c3f",
      relation: "space",
      directlyAssignable: [{ type: "space_c3f" }],
      ...plain,
    });
    await tsfga.writeRelationConfig({
      objectType: "page_c3f",
      relation: "parent",
      directlyAssignable: [{ type: "page_c3f" }],
      ...plain,
    });
    await tsfga.writeRelationConfig({
      objectType: "page_c3f",
      relation: "owner",
      directlyAssignable: [{ type: "user_c3f" }],
      ...plain,
    });
    await tsfga.writeRelationConfig({
      objectType: "page_c3f",
      relation: "restricted_viewer",
      directlyAssignable: [
        { type: "user_c3f" },
        { type: "group_c3f", relation: "member" },
      ],
      ...plain,
    });
    await tsfga.writeRelationConfig({
      objectType: "page_c3f",
      relation: "locked",
      directlyAssignable: [
        { type: "user_c3f", wildcard: true },
        { type: "group_c3f", relation: "member" },
      ],
      ...plain,
    });
    await tsfga.writeRelationConfig({
      objectType: "page_c3f",
      relation: "comments_disabled",
      directlyAssignable: [{ type: "user_c3f", wildcard: true }],
      ...plain,
    });
    await tsfga.writeRelationConfig({
      objectType: "page_c3f",
      relation: "inherited_view",
      directlyAssignable: [],
      ...plain,
      tupleToUserset: [
        { tupleset: "parent", computedUserset: "can_view" },
        { tupleset: "space", computedUserset: "can_view" },
      ],
    });
    await tsfga.writeRelationConfig({
      objectType: "page_c3f",
      relation: "open_view",
      directlyAssignable: [],
      ...plain,
      computedUserset: "inherited_view",
      excludedBy: "locked",
    });
    await tsfga.writeRelationConfig({
      objectType: "page_c3f",
      relation: "can_view",
      directlyAssignable: [],
      ...plain,
      impliedBy: ["owner", "restricted_viewer", "open_view"],
    });
    await tsfga.writeRelationConfig({
      objectType: "page_c3f",
      relation: "can_edit",
      directlyAssignable: [],
      ...plain,
      impliedBy: ["owner"],
      tupleToUserset: [{ tupleset: "space", computedUserset: "can_admin" }],
    });
    await tsfga.writeRelationConfig({
      objectType: "page_c3f",
      relation: "can_comment",
      directlyAssignable: [],
      ...plain,
      computedUserset: "can_view",
      excludedBy: "comments_disabled",
    });

    // === Tuples (mirroring ./confluence/tuples.yaml) ===
    const add = (t: AddTupleRequest) => tsfga.addTuple(t);

    await add({
      objectType: "group_c3f",
      objectId: uuid("platform"),
      relation: "member",
      subjectType: "user_c3f",
      subjectId: uuid("bob"),
    });
    await add({
      objectType: "group_c3f",
      objectId: uuid("engineering"),
      relation: "member",
      subjectType: "group_c3f",
      subjectId: uuid("platform"),
      subjectRelation: "member",
    });
    await add({
      objectType: "group_c3f",
      objectId: uuid("engineering"),
      relation: "member",
      subjectType: "user_c3f",
      subjectId: uuid("carol"),
    });
    await add({
      objectType: "group_c3f",
      objectId: uuid("contractors"),
      relation: "member",
      subjectType: "user_c3f",
      subjectId: uuid("dave"),
    });

    await add({
      objectType: "space_c3f",
      objectId: uuid("eng"),
      relation: "admin",
      subjectType: "user_c3f",
      subjectId: uuid("alice"),
    });
    await add({
      objectType: "space_c3f",
      objectId: uuid("eng"),
      relation: "member",
      subjectType: "group_c3f",
      subjectId: uuid("engineering"),
      subjectRelation: "member",
    });
    await add({
      objectType: "space_c3f",
      objectId: uuid("public-docs"),
      relation: "anonymous",
      subjectType: "user_c3f",
      subjectId: "*",
    });
    await add({
      objectType: "space_c3f",
      objectId: uuid("public-docs"),
      relation: "admin",
      subjectType: "user_c3f",
      subjectId: uuid("alice"),
    });

    await add({
      objectType: "page_c3f",
      objectId: uuid("home"),
      relation: "space",
      subjectType: "space_c3f",
      subjectId: uuid("eng"),
    });
    await add({
      objectType: "page_c3f",
      objectId: uuid("home"),
      relation: "owner",
      subjectType: "user_c3f",
      subjectId: uuid("alice"),
    });
    await add({
      objectType: "page_c3f",
      objectId: uuid("guide"),
      relation: "parent",
      subjectType: "page_c3f",
      subjectId: uuid("home"),
    });
    await add({
      objectType: "page_c3f",
      objectId: uuid("guide"),
      relation: "space",
      subjectType: "space_c3f",
      subjectId: uuid("eng"),
    });
    await add({
      objectType: "page_c3f",
      objectId: uuid("runbook"),
      relation: "parent",
      subjectType: "page_c3f",
      subjectId: uuid("guide"),
    });
    await add({
      objectType: "page_c3f",
      objectId: uuid("runbook"),
      relation: "space",
      subjectType: "space_c3f",
      subjectId: uuid("eng"),
    });
    await add({
      objectType: "page_c3f",
      objectId: uuid("runbook"),
      relation: "locked",
      subjectType: "user_c3f",
      subjectId: "*",
    });
    await add({
      objectType: "page_c3f",
      objectId: uuid("runbook"),
      relation: "restricted_viewer",
      subjectType: "user_c3f",
      subjectId: uuid("carol"),
    });
    await add({
      objectType: "page_c3f",
      objectId: uuid("appendix"),
      relation: "parent",
      subjectType: "page_c3f",
      subjectId: uuid("runbook"),
    });
    await add({
      objectType: "page_c3f",
      objectId: uuid("salary-bands"),
      relation: "parent",
      subjectType: "page_c3f",
      subjectId: uuid("home"),
    });
    await add({
      objectType: "page_c3f",
      objectId: uuid("salary-bands"),
      relation: "locked",
      subjectType: "group_c3f",
      subjectId: uuid("contractors"),
      subjectRelation: "member",
    });
    await add({
      objectType: "space_c3f",
      objectId: uuid("eng"),
      relation: "member",
      subjectType: "user_c3f",
      subjectId: uuid("dave"),
    });
    await add({
      objectType: "page_c3f",
      objectId: uuid("changelog"),
      relation: "space",
      subjectType: "space_c3f",
      subjectId: uuid("public-docs"),
    });
    await add({
      objectType: "page_c3f",
      objectId: uuid("changelog"),
      relation: "comments_disabled",
      subjectType: "user_c3f",
      subjectId: "*",
    });

    storeId = await fgaCreateStore("confluence");
    authorizationModelId = await fgaWriteModel(
      storeId,
      "./confluence/model.dsl",
    );
    await fgaWriteTuples(
      storeId,
      "./confluence/tuples.yaml",
      authorizationModelId,
      uuidMap,
    );
    fgaClient = new OpenFgaClient({
      apiUrl: process.env.FGA_API_URL,
      storeId,
    });
  });

  afterAll(async () => {
    await rollbackTransaction(db);
    await destroyDb();
  });

  // --- The nested group reaching the space ---

  test("1: bob is an engineering member through platform", async () => {
    await can("group_c3f", "engineering", "member", "bob", true);
  });

  test("2: dave is no engineering member", async () => {
    await can("group_c3f", "engineering", "member", "dave", false);
  });

  test("3: bob is a space member two usersets down", async () => {
    await can("space_c3f", "eng", "member", "bob", true);
  });

  test("4: the admin is a member by union", async () => {
    await can("space_c3f", "eng", "member", "alice", true);
  });

  test("5: a member is not an admin", async () => {
    await can("space_c3f", "eng", "can_admin", "bob", false);
  });

  test("6: frank reaches no space", async () => {
    await can("space_c3f", "eng", "can_view", "frank", false);
  });

  // --- Inheritance down the page tree ---

  test("7: the owner views home", async () => {
    await can("page_c3f", "home", "can_view", "alice", true);
  });

  test("8: bob views home through the space", async () => {
    await can("page_c3f", "home", "can_view", "bob", true);
  });

  test("9: bob views guide one link down", async () => {
    await can("page_c3f", "guide", "can_view", "bob", true);
  });

  test("10: alice views guide through the parent, not the space", async () => {
    await can("page_c3f", "guide", "can_view", "alice", true);
  });

  test("11: frank views nothing in the tree", async () => {
    await can("page_c3f", "guide", "can_view", "frank", false);
  });

  // --- A wildcard lock cutting the chain ---

  test("12: the wildcard lock strips bob's inherited view", async () => {
    await can("page_c3f", "runbook", "can_view", "bob", false);
  });

  test("13: it strips the space admin too", async () => {
    await can("page_c3f", "runbook", "can_view", "alice", false);
  });

  test("14: carol survives as a restricted viewer", async () => {
    await can("page_c3f", "runbook", "can_view", "carol", true);
  });

  test("15: the cut is inherited by the page below", async () => {
    await can("page_c3f", "appendix", "can_view", "bob", false);
  });

  test("16: and so is the exception", async () => {
    await can("page_c3f", "appendix", "can_view", "carol", true);
  });

  test("17: locking view does not lock editing", async () => {
    await can("page_c3f", "runbook", "can_edit", "alice", true);
  });

  test("18: a member still cannot edit", async () => {
    await can("page_c3f", "guide", "can_edit", "bob", false);
  });

  // --- A userset lock: contractors only ---

  test("19: dave loses salary-bands to the contractor lock", async () => {
    await can("page_c3f", "salary-bands", "can_view", "dave", false);
  });

  test("20: carol keeps it — the lock misses her", async () => {
    await can("page_c3f", "salary-bands", "can_view", "carol", true);
  });

  test("21: dave still views the parent page", async () => {
    await can("page_c3f", "home", "can_view", "dave", true);
  });

  // --- Anonymous access through the space wildcard ---

  test("22: a stranger views the public changelog", async () => {
    await can("page_c3f", "changelog", "can_view", "frank", true);
  });

  test("23: but cannot comment — comments are off", async () => {
    await can("page_c3f", "changelog", "can_comment", "frank", false);
  });

  test("24: the anonymous wildcard is not membership of eng", async () => {
    await can("space_c3f", "eng", "can_view", "frank", false);
  });

  test("25: bob may comment on guide", async () => {
    await can("page_c3f", "guide", "can_comment", "bob", true);
  });

  // --- Userset subjects asked about directly ---

  test("26: the engineering userset is itself a space member", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "space_c3f",
        objectId: uuid("eng"),
        relation: "member",
        subjectType: "group_c3f",
        subjectId: uuid("engineering"),
        subjectRelation: "member",
      },
      true,
    );
  });

  test("27: the nested platform userset is one too, one hop down", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "space_c3f",
        objectId: uuid("eng"),
        relation: "member",
        subjectType: "group_c3f",
        subjectId: uuid("platform"),
        subjectRelation: "member",
      },
      true,
    );
  });

  test("27b: the contractors userset reaches no space", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "space_c3f",
        objectId: uuid("eng"),
        relation: "member",
        subjectType: "group_c3f",
        subjectId: uuid("contractors"),
        subjectRelation: "member",
      },
      false,
    );
  });

  // --- listObjects over the same graph ---

  test("28: the pages bob may view", async () => {
    await expectListObjectsConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "page_c3f",
        relation: "can_view",
        subjectType: "user_c3f",
        subjectId: uuid("bob"),
      },
      [uuid("home"), uuid("guide"), uuid("salary-bands"), uuid("changelog")],
    );
  });

  test("29: the pages carol may view", async () => {
    await expectListObjectsConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "page_c3f",
        relation: "can_view",
        subjectType: "user_c3f",
        subjectId: uuid("carol"),
      },
      [
        uuid("home"),
        uuid("guide"),
        uuid("runbook"),
        uuid("appendix"),
        uuid("salary-bands"),
        uuid("changelog"),
      ],
    );
  });

  test("30: the pages a stranger may view", async () => {
    await expectListObjectsConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "page_c3f",
        relation: "can_view",
        subjectType: "user_c3f",
        subjectId: uuid("frank"),
      },
      [uuid("changelog")],
    );
  });

  test("31: the spaces alice may administer", async () => {
    await expectListObjectsConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "space_c3f",
        relation: "can_admin",
        subjectType: "user_c3f",
        subjectId: uuid("alice"),
      },
      [uuid("eng"), uuid("public-docs")],
    );
  });

  // --- The write gate on this model ---

  test("32: a group userset may lock a page", async () => {
    await expectWriteConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "page_c3f",
        objectId: uuid("guide"),
        relation: "locked",
        subjectType: "group_c3f",
        subjectId: uuid("contractors"),
        subjectRelation: "member",
      },
      "accepted",
    );
  });

  test("33: a bare group may not — the model names the userset", async () => {
    await expectWriteConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "page_c3f",
        objectId: uuid("appendix"),
        relation: "locked",
        subjectType: "group_c3f",
        subjectId: uuid("contractors"),
      },
      "refused",
    );
  });

  test("34: `comments_disabled` admits the wildcard only", async () => {
    await expectWriteConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "page_c3f",
        objectId: uuid("guide"),
        relation: "comments_disabled",
        subjectType: "user_c3f",
        subjectId: uuid("alice"),
      },
      "refused",
    );
  });

  test("35: a space may not be a page's parent", async () => {
    await expectWriteConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "page_c3f",
        objectId: uuid("appendix"),
        relation: "parent",
        subjectType: "space_c3f",
        subjectId: uuid("eng"),
      },
      "refused",
    );
  });

  test("36: a computed relation takes no tuple at all", async () => {
    await expectWriteConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "page_c3f",
        objectId: uuid("guide"),
        relation: "can_view",
        subjectType: "user_c3f",
        subjectId: uuid("frank"),
      },
      "refused",
    );
  });

  // --- Revocation through each path ---

  test("37: the lock written in test 32 now bites bob", async () => {
    await can("page_c3f", "guide", "can_view", "bob", true);
    await can("page_c3f", "guide", "can_view", "dave", false);
  });

  test("38: revoking the nested group drops bob out of the space", async () => {
    await can("page_c3f", "home", "can_view", "bob", true);
    await revoke({
      objectType: "group_c3f",
      objectId: uuid("engineering"),
      relation: "member",
      subjectType: "group_c3f",
      subjectId: uuid("platform"),
      subjectRelation: "member",
    });
    await can("group_c3f", "engineering", "member", "bob", false);
    await can("space_c3f", "eng", "member", "bob", false);
    await can("page_c3f", "home", "can_view", "bob", false);
    await can("page_c3f", "guide", "can_view", "bob", false);
  });

  test("39: revoking the lock restores the whole subtree", async () => {
    await revoke({
      objectType: "page_c3f",
      objectId: uuid("runbook"),
      relation: "locked",
      subjectType: "user_c3f",
      subjectId: "*",
    });
    await can("page_c3f", "runbook", "can_view", "alice", true);
    await can("page_c3f", "appendix", "can_view", "alice", true);
  });

  test("40: revoking the owner tuple ends the owner's whole tree", async () => {
    await revoke({
      objectType: "page_c3f",
      objectId: uuid("home"),
      relation: "owner",
      subjectType: "user_c3f",
      subjectId: uuid("alice"),
    });
    // alice remains a space admin, so the space arm still reaches
    // home — the owner arm is what went away.
    await can("page_c3f", "home", "can_view", "alice", true);
    await revoke({
      objectType: "space_c3f",
      objectId: uuid("eng"),
      relation: "admin",
      subjectType: "user_c3f",
      subjectId: uuid("alice"),
    });
    await can("page_c3f", "home", "can_view", "alice", false);
    await can("page_c3f", "appendix", "can_view", "alice", false);
    await can("page_c3f", "runbook", "can_edit", "alice", false);
  });

  test("the relation configs say what the model says", () => {
    expectConfigsMatchModel("./confluence/model.dsl", fixture, {
      coverage: "complete",
    });
  });
});
