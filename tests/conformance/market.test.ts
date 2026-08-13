import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ErrorCode, FgaApiValidationError, OpenFgaClient } from "@openfga/sdk";
import {
  type AddTupleRequest,
  type ConditionDefinition,
  createTsfga,
  type RemoveTupleRequest,
  type TsfgaClient,
} from "@tsfga/core";
import type { DB } from "@tsfga/kysely";
import { KyselyTupleStore } from "@tsfga/kysely";
import type { Kysely } from "kysely";
import {
  fgaBatchCheck,
  fgaListUsers,
  renderSubject,
} from "./batch/upstream.ts";
import {
  type CheckOutcome,
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
 * An online marketplace with escrow and disputes.
 *
 * The seam is the ban. `banned` is written once, on the merchant,
 * and every layer below re-reads it through a tuple-to-userset:
 * merchant to seller to listing to order to dispute. So the
 * subtrahend of `dispute.can_comment` is four dispatches deep, and
 * one of the two merchants carries it as `user_d4m:*` — a wildcard
 * ban that has to travel the whole chain and take a listing, an
 * order and a dispute away from everybody, including the arbiter
 * written directly on the dispute.
 *
 * Around it: `can_publish`, an intersection whose second operand is
 * itself a tuple-to-userset (`verified and can_manage from seller`);
 * `order.seller`, a relation that only exists as a TTU onto a
 * relation that is itself only a TTU; `party`, two TTU arms off one
 * tupleset; a nested `g_ops#member` inside `g_staff#member` carrying
 * the merchant's staff grant; and two conditions doing real work —
 * an escrow state matched against a list the *tuple* supplies while
 * the *request* supplies the value, and an order reference matched
 * against an RE2 pattern with an escaped dot.
 */

const CONDITIONS: ConditionDefinition[] = [
  {
    name: "escrow_state_d4m",
    expression: "state in allowed",
    parameters: { state: "string", allowed: "list<string>" },
  },
  {
    name: "order_ref_d4m",
    expression:
      'ref.startsWith("ord-") && ref.endsWith(".web") && size(ref) == 12',
    parameters: { ref: "string" },
  },
];

const DRAFT = { state: "draft" };
const LIVE = { state: "live" };
const SOLD = { state: "sold" };
const FUNDED = { state: "funded" };
const GOOD_REF = { ref: "ord-1234.web" };

const uuidMap = new Map<string, string>([
  ["ivy", "00000000-0000-4000-d583-000000000001"],
  ["g_ops", "00000000-0000-4000-d583-000000000002"],
  ["g_staff", "00000000-0000-4000-d583-000000000003"],
  ["hank", "00000000-0000-4000-d583-000000000004"],
  ["judy", "00000000-0000-4000-d583-000000000005"],
  ["g_arb", "00000000-0000-4000-d583-000000000006"],
  ["mona", "00000000-0000-4000-d583-000000000007"],
  ["m_acme", "00000000-0000-4000-d583-000000000008"],
  ["nate", "00000000-0000-4000-d583-000000000009"],
  ["m_bad", "00000000-0000-4000-d583-000000000010"],
  ["quinn", "00000000-0000-4000-d583-000000000011"],
  ["s_alpha", "00000000-0000-4000-d583-000000000012"],
  ["pete", "00000000-0000-4000-d583-000000000013"],
  ["s_beta", "00000000-0000-4000-d583-000000000014"],
  ["l_boots", "00000000-0000-4000-d583-000000000015"],
  ["l_hat", "00000000-0000-4000-d583-000000000016"],
  ["rita", "00000000-0000-4000-d583-000000000017"],
  ["sam", "00000000-0000-4000-d583-000000000018"],
  ["ord1", "00000000-0000-4000-d583-000000000019"],
  ["tina", "00000000-0000-4000-d583-000000000020"],
  ["umar", "00000000-0000-4000-d583-000000000021"],
  ["wes", "00000000-0000-4000-d583-000000000022"],
  ["vera", "00000000-0000-4000-d583-000000000023"],
  ["ord2", "00000000-0000-4000-d583-000000000024"],
  ["d1", "00000000-0000-4000-d583-000000000025"],
  ["d2", "00000000-0000-4000-d583-000000000026"],
  ["zed", "00000000-0000-4000-d583-000000000027"],
]);

function uuid(name: string): string {
  const id = uuidMap.get(name);
  if (!id) throw new Error(`No UUID for ${name}`);
  return id;
}

describe("Marketplace Escrow Model Conformance", () => {
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
    expected: CheckOutcome,
    context?: Record<string, unknown>,
  ): Promise<void> {
    return expectConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType,
        objectId: uuid(objectId),
        relation,
        subjectType: "user_d4m",
        subjectId: uuid(subject),
        ...(context ? { context } : {}),
      },
      expected,
    );
  }

  /** The same, with contextual tuples overlaid on the read. */
  function canWith(
    objectType: string,
    objectId: string,
    relation: string,
    subject: string,
    contextualTuples: AddTupleRequest[],
    expected: CheckOutcome,
    context?: Record<string, unknown>,
  ): Promise<void> {
    return expectConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType,
        objectId: uuid(objectId),
        relation,
        subjectType: "user_d4m",
        subjectId: uuid(subject),
        contextualTuples,
        ...(context ? { context } : {}),
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
        .then((outcome) => expect(outcome).toBe("deleted")),
    ]);
  }

  beforeAll(async () => {
    assertUuidMapInjective(uuidMap);
    assertUuidMapCovers("./market/tuples.yaml", uuidMap);

    db = getDb();
    await beginTransaction(db);

    tsfga = createTsfga(new KyselyTupleStore(db));
    fixture = recordFixture(tsfga);

    for (const condition of CONDITIONS) {
      await tsfga.writeConditionDefinition(condition);
    }

    const plain = {
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    } as const;
    const person = { type: "user_d4m" } as const;
    const groupMember = { type: "group_d4m", relation: "member" } as const;
    const escrowPerson = {
      type: "user_d4m",
      condition: "escrow_state_d4m",
    } as const;

    await tsfga.writeRelationConfig({
      objectType: "group_d4m",
      relation: "member",
      directlyAssignable: [person, groupMember],
      ...plain,
    });

    // --- merchant ---
    await tsfga.writeRelationConfig({
      objectType: "merchant_d4m",
      relation: "owner",
      directlyAssignable: [person, groupMember],
      ...plain,
    });
    await tsfga.writeRelationConfig({
      objectType: "merchant_d4m",
      relation: "staff",
      directlyAssignable: [person, groupMember],
      ...plain,
    });
    await tsfga.writeRelationConfig({
      objectType: "merchant_d4m",
      relation: "banned",
      directlyAssignable: [person, { type: "user_d4m", wildcard: true }],
      ...plain,
    });
    await tsfga.writeRelationConfig({
      objectType: "merchant_d4m",
      relation: "can_administer",
      directlyAssignable: [],
      ...plain,
      impliedBy: ["owner", "staff"],
    });

    // --- seller ---
    await tsfga.writeRelationConfig({
      objectType: "seller_d4m",
      relation: "merchant",
      directlyAssignable: [{ type: "merchant_d4m" }],
      ...plain,
    });
    await tsfga.writeRelationConfig({
      objectType: "seller_d4m",
      relation: "operator",
      directlyAssignable: [person, groupMember],
      ...plain,
    });
    await tsfga.writeRelationConfig({
      objectType: "seller_d4m",
      relation: "banned",
      directlyAssignable: [],
      ...plain,
      tupleToUserset: [{ tupleset: "merchant", computedUserset: "banned" }],
    });
    await tsfga.writeRelationConfig({
      objectType: "seller_d4m",
      relation: "can_manage",
      directlyAssignable: [],
      ...plain,
      impliedBy: ["operator"],
      tupleToUserset: [
        { tupleset: "merchant", computedUserset: "can_administer" },
      ],
      excludedBy: "banned",
    });

    // --- listing ---
    await tsfga.writeRelationConfig({
      objectType: "listing_d4m",
      relation: "seller",
      directlyAssignable: [{ type: "seller_d4m" }],
      ...plain,
    });
    await tsfga.writeRelationConfig({
      objectType: "listing_d4m",
      relation: "editor",
      directlyAssignable: [person, escrowPerson],
      ...plain,
    });
    await tsfga.writeRelationConfig({
      objectType: "listing_d4m",
      relation: "verified",
      directlyAssignable: [person, groupMember],
      ...plain,
    });
    await tsfga.writeRelationConfig({
      objectType: "listing_d4m",
      relation: "manager",
      directlyAssignable: [],
      ...plain,
      tupleToUserset: [{ tupleset: "seller", computedUserset: "can_manage" }],
    });
    await tsfga.writeRelationConfig({
      objectType: "listing_d4m",
      relation: "banned",
      directlyAssignable: [],
      ...plain,
      tupleToUserset: [{ tupleset: "seller", computedUserset: "banned" }],
    });
    await tsfga.writeRelationConfig({
      objectType: "listing_d4m",
      relation: "can_edit",
      directlyAssignable: [],
      ...plain,
      impliedBy: ["editor", "manager"],
      excludedBy: "banned",
    });
    await tsfga.writeRelationConfig({
      objectType: "listing_d4m",
      relation: "can_publish",
      directlyAssignable: [],
      ...plain,
      intersection: [
        { type: "computedUserset", relation: "verified" },
        {
          type: "tupleToUserset",
          tupleset: "seller",
          computedUserset: "can_manage",
        },
      ],
    });

    // --- order ---
    await tsfga.writeRelationConfig({
      objectType: "order_d4m",
      relation: "listing",
      directlyAssignable: [{ type: "listing_d4m" }],
      ...plain,
    });
    await tsfga.writeRelationConfig({
      objectType: "order_d4m",
      relation: "buyer",
      directlyAssignable: [person, escrowPerson],
      ...plain,
    });
    await tsfga.writeRelationConfig({
      objectType: "order_d4m",
      relation: "seller",
      directlyAssignable: [],
      ...plain,
      tupleToUserset: [{ tupleset: "listing", computedUserset: "manager" }],
    });
    await tsfga.writeRelationConfig({
      objectType: "order_d4m",
      relation: "auditor",
      directlyAssignable: [{ type: "user_d4m", condition: "order_ref_d4m" }],
      ...plain,
    });
    await tsfga.writeRelationConfig({
      objectType: "order_d4m",
      relation: "blocked",
      directlyAssignable: [{ type: "user_d4m", wildcard: true }],
      ...plain,
    });
    await tsfga.writeRelationConfig({
      objectType: "order_d4m",
      relation: "banned",
      directlyAssignable: [],
      ...plain,
      tupleToUserset: [{ tupleset: "listing", computedUserset: "banned" }],
    });
    await tsfga.writeRelationConfig({
      objectType: "order_d4m",
      relation: "can_release",
      directlyAssignable: [],
      ...plain,
      impliedBy: ["buyer", "auditor"],
      excludedBy: "blocked",
    });
    await tsfga.writeRelationConfig({
      objectType: "order_d4m",
      relation: "can_view",
      directlyAssignable: [],
      ...plain,
      impliedBy: ["buyer", "seller", "auditor"],
      excludedBy: "banned",
    });

    // --- dispute ---
    await tsfga.writeRelationConfig({
      objectType: "dispute_d4m",
      relation: "order",
      directlyAssignable: [{ type: "order_d4m" }],
      ...plain,
    });
    await tsfga.writeRelationConfig({
      objectType: "dispute_d4m",
      relation: "arbiter",
      directlyAssignable: [person, groupMember],
      ...plain,
    });
    await tsfga.writeRelationConfig({
      objectType: "dispute_d4m",
      relation: "party",
      directlyAssignable: [],
      ...plain,
      tupleToUserset: [
        { tupleset: "order", computedUserset: "buyer" },
        { tupleset: "order", computedUserset: "seller" },
      ],
    });
    await tsfga.writeRelationConfig({
      objectType: "dispute_d4m",
      relation: "banned",
      directlyAssignable: [],
      ...plain,
      tupleToUserset: [{ tupleset: "order", computedUserset: "banned" }],
    });
    await tsfga.writeRelationConfig({
      objectType: "dispute_d4m",
      relation: "can_comment",
      directlyAssignable: [],
      ...plain,
      impliedBy: ["party", "arbiter"],
      excludedBy: "banned",
    });

    // === Tuples (mirroring ./market/tuples.yaml) ===
    const tuples: AddTupleRequest[] = [
      {
        objectType: "group_d4m",
        objectId: uuid("g_ops"),
        relation: "member",
        subjectType: "user_d4m",
        subjectId: uuid("ivy"),
      },
      {
        objectType: "group_d4m",
        objectId: uuid("g_staff"),
        relation: "member",
        subjectType: "group_d4m",
        subjectId: uuid("g_ops"),
        subjectRelation: "member",
      },
      {
        objectType: "group_d4m",
        objectId: uuid("g_staff"),
        relation: "member",
        subjectType: "user_d4m",
        subjectId: uuid("hank"),
      },
      {
        objectType: "group_d4m",
        objectId: uuid("g_arb"),
        relation: "member",
        subjectType: "user_d4m",
        subjectId: uuid("judy"),
      },
      {
        objectType: "merchant_d4m",
        objectId: uuid("m_acme"),
        relation: "owner",
        subjectType: "user_d4m",
        subjectId: uuid("mona"),
      },
      {
        objectType: "merchant_d4m",
        objectId: uuid("m_acme"),
        relation: "staff",
        subjectType: "group_d4m",
        subjectId: uuid("g_staff"),
        subjectRelation: "member",
      },
      {
        objectType: "merchant_d4m",
        objectId: uuid("m_acme"),
        relation: "banned",
        subjectType: "user_d4m",
        subjectId: uuid("hank"),
      },
      {
        objectType: "merchant_d4m",
        objectId: uuid("m_bad"),
        relation: "owner",
        subjectType: "user_d4m",
        subjectId: uuid("nate"),
      },
      {
        objectType: "merchant_d4m",
        objectId: uuid("m_bad"),
        relation: "staff",
        subjectType: "user_d4m",
        subjectId: uuid("quinn"),
      },
      {
        objectType: "merchant_d4m",
        objectId: uuid("m_bad"),
        relation: "banned",
        subjectType: "user_d4m",
        subjectId: "*",
      },
      {
        objectType: "seller_d4m",
        objectId: uuid("s_alpha"),
        relation: "merchant",
        subjectType: "merchant_d4m",
        subjectId: uuid("m_acme"),
      },
      {
        objectType: "seller_d4m",
        objectId: uuid("s_alpha"),
        relation: "operator",
        subjectType: "user_d4m",
        subjectId: uuid("pete"),
      },
      {
        objectType: "seller_d4m",
        objectId: uuid("s_beta"),
        relation: "merchant",
        subjectType: "merchant_d4m",
        subjectId: uuid("m_bad"),
      },
      {
        objectType: "seller_d4m",
        objectId: uuid("s_beta"),
        relation: "operator",
        subjectType: "user_d4m",
        subjectId: uuid("quinn"),
      },
      {
        objectType: "listing_d4m",
        objectId: uuid("l_boots"),
        relation: "seller",
        subjectType: "seller_d4m",
        subjectId: uuid("s_alpha"),
      },
      {
        objectType: "listing_d4m",
        objectId: uuid("l_hat"),
        relation: "seller",
        subjectType: "seller_d4m",
        subjectId: uuid("s_beta"),
      },
      {
        objectType: "listing_d4m",
        objectId: uuid("l_boots"),
        relation: "editor",
        subjectType: "user_d4m",
        subjectId: uuid("rita"),
      },
      {
        objectType: "listing_d4m",
        objectId: uuid("l_boots"),
        relation: "editor",
        subjectType: "user_d4m",
        subjectId: uuid("sam"),
        conditionName: "escrow_state_d4m",
        conditionContext: { allowed: ["draft", "live"] },
      },
      {
        objectType: "listing_d4m",
        objectId: uuid("l_boots"),
        relation: "verified",
        subjectType: "user_d4m",
        subjectId: uuid("pete"),
      },
      {
        objectType: "listing_d4m",
        objectId: uuid("l_hat"),
        relation: "verified",
        subjectType: "group_d4m",
        subjectId: uuid("g_ops"),
        subjectRelation: "member",
      },
      {
        objectType: "order_d4m",
        objectId: uuid("ord1"),
        relation: "listing",
        subjectType: "listing_d4m",
        subjectId: uuid("l_boots"),
      },
      {
        objectType: "order_d4m",
        objectId: uuid("ord1"),
        relation: "buyer",
        subjectType: "user_d4m",
        subjectId: uuid("tina"),
      },
      {
        objectType: "order_d4m",
        objectId: uuid("ord1"),
        relation: "buyer",
        subjectType: "user_d4m",
        subjectId: uuid("hank"),
      },
      {
        objectType: "order_d4m",
        objectId: uuid("ord1"),
        relation: "buyer",
        subjectType: "user_d4m",
        subjectId: uuid("umar"),
        conditionName: "escrow_state_d4m",
        conditionContext: { allowed: ["funded", "shipped"] },
      },
      {
        objectType: "order_d4m",
        objectId: uuid("ord1"),
        relation: "buyer",
        subjectType: "user_d4m",
        subjectId: uuid("wes"),
        conditionName: "escrow_state_d4m",
        conditionContext: { allowed: [] },
      },
      {
        objectType: "order_d4m",
        objectId: uuid("ord1"),
        relation: "auditor",
        subjectType: "user_d4m",
        subjectId: uuid("vera"),
        conditionName: "order_ref_d4m",
      },
      {
        objectType: "order_d4m",
        objectId: uuid("ord2"),
        relation: "listing",
        subjectType: "listing_d4m",
        subjectId: uuid("l_hat"),
      },
      {
        objectType: "order_d4m",
        objectId: uuid("ord2"),
        relation: "buyer",
        subjectType: "user_d4m",
        subjectId: uuid("tina"),
      },
      {
        objectType: "order_d4m",
        objectId: uuid("ord2"),
        relation: "blocked",
        subjectType: "user_d4m",
        subjectId: "*",
      },
      {
        objectType: "dispute_d4m",
        objectId: uuid("d1"),
        relation: "order",
        subjectType: "order_d4m",
        subjectId: uuid("ord1"),
      },
      {
        objectType: "dispute_d4m",
        objectId: uuid("d1"),
        relation: "arbiter",
        subjectType: "group_d4m",
        subjectId: uuid("g_arb"),
        subjectRelation: "member",
      },
      {
        objectType: "dispute_d4m",
        objectId: uuid("d2"),
        relation: "order",
        subjectType: "order_d4m",
        subjectId: uuid("ord2"),
      },
      {
        objectType: "dispute_d4m",
        objectId: uuid("d2"),
        relation: "arbiter",
        subjectType: "user_d4m",
        subjectId: uuid("judy"),
      },
    ];
    for (const tuple of tuples) await tsfga.addTuple(tuple);

    storeId = await fgaCreateStore("market");
    fgaClient = new OpenFgaClient({ apiUrl: process.env.FGA_API_URL, storeId });
    authorizationModelId = await fgaWriteModel(storeId, "./market/model.dsl");
    await fgaWriteTuples(
      storeId,
      "./market/tuples.yaml",
      authorizationModelId,
      uuidMap,
    );
  });

  afterAll(async () => {
    await rollbackTransaction(db);
    await destroyDb();
  });

  // --- The merchant, and the group nested inside its staff ---

  test("1: the merchant's two admin arms", async () => {
    // The nested group carries the staff grant.
    await can("group_d4m", "g_staff", "member", "ivy", true);
    await can("merchant_d4m", "m_acme", "can_administer", "ivy", true);
    // The owner reaches it by the other arm.
    await can("merchant_d4m", "m_acme", "can_administer", "mona", true);
    await can("merchant_d4m", "m_acme", "staff", "mona", false);
    await can("merchant_d4m", "m_acme", "can_administer", "zed", false);
  });

  // --- The ban, travelling merchant to seller to listing ---

  test("2: the seller inherits the merchant's ban", async () => {
    await can("merchant_d4m", "m_acme", "banned", "hank", true);
    await can("seller_d4m", "s_alpha", "banned", "hank", true);
    await can("listing_d4m", "l_boots", "banned", "hank", true);
    // And it cuts the staff grant it sits beside.
    await can("merchant_d4m", "m_acme", "can_administer", "hank", true);
    await can("seller_d4m", "s_alpha", "can_manage", "hank", false);
  });

  test("3: the operator and the merchant admins manage", async () => {
    await can("seller_d4m", "s_alpha", "can_manage", "pete", true);
    await can("seller_d4m", "s_alpha", "can_manage", "mona", true);
    await can("seller_d4m", "s_alpha", "can_manage", "ivy", true);
  });

  test("4: the wildcard ban empties the other merchant's seller", async () => {
    await can("merchant_d4m", "m_bad", "can_administer", "quinn", true);
    await can("seller_d4m", "s_beta", "banned", "quinn", true);
    await can("seller_d4m", "s_beta", "can_manage", "quinn", false);
    await can("seller_d4m", "s_beta", "can_manage", "nate", false);
  });

  // --- The listing ---

  test("5: manager mirrors the seller's can_manage", async () => {
    await can("listing_d4m", "l_boots", "manager", "pete", true);
    await can("listing_d4m", "l_boots", "manager", "hank", false);
    // A direct editor edits; a banned manager does not.
    await can("listing_d4m", "l_boots", "can_edit", "rita", true);
    await can("listing_d4m", "l_boots", "can_edit", "ivy", true);
    await can("listing_d4m", "l_boots", "can_edit", "hank", false);
  });

  test("6: the intersection needs both operands", async () => {
    // `verified and can_manage from seller`: pete has both.
    await can("listing_d4m", "l_boots", "can_publish", "pete", true);
    // mona manages but is not verified.
    await can("listing_d4m", "l_boots", "can_publish", "mona", false);
    // rita edits but neither manages nor is verified.
    await can("listing_d4m", "l_boots", "can_publish", "rita", false);
  });

  test("7: verified alone does not publish the banned listing", async () => {
    await can("listing_d4m", "l_hat", "verified", "ivy", true);
    await can("listing_d4m", "l_hat", "can_publish", "ivy", false);
    await can("listing_d4m", "l_hat", "can_edit", "quinn", false);
  });

  // --- The escrow condition ---

  test("8: the escrow state is matched against the tuple's list", async () => {
    await can("listing_d4m", "l_boots", "can_edit", "sam", true, DRAFT);
    await can("listing_d4m", "l_boots", "can_edit", "sam", true, LIVE);
    // A state outside the list denies.
    await can("listing_d4m", "l_boots", "can_edit", "sam", false, SOLD);
    // A missing state refuses.
    await can("listing_d4m", "l_boots", "can_edit", "sam", "refused");
  });

  test("9: an empty allow-list is a denial, not a refusal", async () => {
    await can("order_d4m", "ord1", "can_release", "wes", false, FUNDED);
    await can("order_d4m", "ord1", "can_view", "wes", false, FUNDED);
  });

  test("10: the conditioned buyer is a buyer when funded", async () => {
    await can("order_d4m", "ord1", "buyer", "umar", true, FUNDED);
    await can("order_d4m", "ord1", "can_view", "umar", true, FUNDED);
    await can("order_d4m", "ord1", "can_view", "umar", false, SOLD);
  });

  // --- The order ---

  test("11: the unconditioned buyer views the order", async () => {
    await can("order_d4m", "ord1", "can_view", "tina", true);
  });

  test("12: the seller side reaches the order through two TTUs", async () => {
    await can("order_d4m", "ord1", "seller", "pete", true);
    await can("order_d4m", "ord1", "can_view", "mona", true);
    await can("order_d4m", "ord1", "can_view", "ivy", true);
  });

  test("13: a banned buyer may release but may not view", async () => {
    await can("order_d4m", "ord1", "buyer", "hank", true);
    await can("order_d4m", "ord1", "can_release", "hank", true);
    await can("order_d4m", "ord1", "can_view", "hank", false);
  });

  // --- The order-reference pattern ---

  test("14: the auditor's reference matches", async () => {
    await can("order_d4m", "ord1", "auditor", "vera", true, GOOD_REF);
    await can("order_d4m", "ord1", "can_release", "vera", true, GOOD_REF);
  });

  test("15: the reference is anchored at both ends and sized", async () => {
    await can("order_d4m", "ord1", "auditor", "vera", false, {
      ref: "ord-1234xweb",
    });
    // Added negative: the suffix is case-sensitive, as the old
    // pattern's `[a-z]+` was. Without a cell like this one a
    // rewrite to `true` would pass.
    //
    // Recorded rather than smoothed over: the first value tried
    // here was `ord-abcd.web`, which the old pattern rejected for
    // having no digits and which this rewrite **admits** — prefix,
    // suffix and length all hold. That is a real widening, and it
    // is acceptable only because no cell in this fixture uses such
    // a value. The added-negative rule is what surfaced it.
    await can("order_d4m", "ord1", "auditor", "vera", false, {
      ref: "ord-1234.WEB",
    });
    await can("order_d4m", "ord1", "auditor", "vera", false, {
      ref: "ord-12.web",
    });
    await can("order_d4m", "ord1", "auditor", "vera", false, {
      ref: "x-ord-1234.web-y",
    });
  });

  test("16: a missing reference refuses", async () => {
    await can("order_d4m", "ord1", "auditor", "vera", "refused");
  });

  // --- The wildcard blocked, and the four-hop ban ---

  test("17: the wildcard block and the four-hop ban", async () => {
    await can("order_d4m", "ord2", "buyer", "tina", true);
    await can("order_d4m", "ord2", "can_release", "tina", false);
    // The merchant's wildcard ban reaches the order four hops down.
    await can("order_d4m", "ord2", "banned", "tina", true);
    await can("order_d4m", "ord2", "can_view", "tina", false);
  });

  // --- The dispute ---

  test("18: party resolves through both TTU arms", async () => {
    await can("dispute_d4m", "d1", "party", "tina", true);
    await can("dispute_d4m", "d1", "party", "pete", true);
    await can("dispute_d4m", "d1", "party", "zed", false);
    // And the arbiter comments through the nested group.
    await can("dispute_d4m", "d1", "arbiter", "judy", true);
    await can("dispute_d4m", "d1", "can_comment", "judy", true);
  });

  test("19: the ban beats both arms of can_comment", async () => {
    await can("dispute_d4m", "d1", "party", "hank", true);
    await can("dispute_d4m", "d1", "can_comment", "hank", false);
  });

  test("20: the wildcard ban takes the dispute from its arbiter", async () => {
    await can("dispute_d4m", "d2", "arbiter", "judy", true);
    await can("dispute_d4m", "d2", "banned", "judy", true);
    await can("dispute_d4m", "d2", "can_comment", "judy", false);
  });

  // --- Contextual tuples, in every shape ---

  test("21: a bare contextual subject", async () => {
    await can("order_d4m", "ord1", "can_view", "zed", false);
    await canWith(
      "order_d4m",
      "ord1",
      "can_view",
      "zed",
      [
        {
          objectType: "order_d4m",
          objectId: uuid("ord1"),
          relation: "buyer",
          subjectType: "user_d4m",
          subjectId: uuid("zed"),
        },
      ],
      true,
    );
  });

  test("22: a contextual userset subject", async () => {
    await can("listing_d4m", "l_boots", "can_publish", "ivy", false);
    await canWith(
      "listing_d4m",
      "l_boots",
      "can_publish",
      "ivy",
      [
        {
          objectType: "listing_d4m",
          objectId: uuid("l_boots"),
          relation: "verified",
          subjectType: "group_d4m",
          subjectId: uuid("g_staff"),
          subjectRelation: "member",
        },
      ],
      true,
    );
  });

  test("23: a conditioned contextual tuple", async () => {
    const overlay: AddTupleRequest[] = [
      {
        objectType: "order_d4m",
        objectId: uuid("ord1"),
        relation: "buyer",
        subjectType: "user_d4m",
        subjectId: uuid("zed"),
        conditionName: "escrow_state_d4m",
        conditionContext: { allowed: ["funded"] },
      },
    ];
    await canWith(
      "order_d4m",
      "ord1",
      "can_view",
      "zed",
      overlay,
      true,
      FUNDED,
    );
    await canWith("order_d4m", "ord1", "can_view", "zed", overlay, false, SOLD);
  });

  test("24: a typed contextual wildcard", async () => {
    await can("order_d4m", "ord1", "can_release", "tina", true);
    await canWith(
      "order_d4m",
      "ord1",
      "can_release",
      "tina",
      [
        {
          objectType: "order_d4m",
          objectId: uuid("ord1"),
          relation: "blocked",
          subjectType: "user_d4m",
          subjectId: "*",
        },
      ],
      false,
    );
  });

  test("25: a contextual tuple shadowing a stored one", async () => {
    // The stored row lets umar through on "funded"; the contextual
    // row on the same object+relation+subject names "draft".
    const overlay: AddTupleRequest[] = [
      {
        objectType: "order_d4m",
        objectId: uuid("ord1"),
        relation: "buyer",
        subjectType: "user_d4m",
        subjectId: uuid("umar"),
        conditionName: "escrow_state_d4m",
        conditionContext: { allowed: ["draft"] },
      },
    ];
    await canWith("order_d4m", "ord1", "buyer", "umar", overlay, true, DRAFT);
    await canWith("order_d4m", "ord1", "buyer", "umar", overlay, false, SOLD);
  });

  test("26: a contextual tuple the model does not admit", async () => {
    await canWith(
      "order_d4m",
      "ord1",
      "can_release",
      "zed",
      [
        {
          objectType: "order_d4m",
          objectId: uuid("ord1"),
          relation: "blocked",
          subjectType: "user_d4m",
          subjectId: uuid("zed"),
        },
      ],
      "refused",
    );
  });

  // --- listObjects ---

  test("27: the listings rita edits, the orders tina views", async () => {
    await expectListObjectsConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "listing_d4m",
        relation: "can_edit",
        subjectType: "user_d4m",
        subjectId: uuid("rita"),
      },
      [uuid("l_boots")],
    );
    // ord2 is gone, four hops below the wildcard ban.
    await expectListObjectsConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "order_d4m",
        relation: "can_view",
        subjectType: "user_d4m",
        subjectId: uuid("tina"),
      },
      [uuid("ord1")],
    );
  });

  test("28: the disputes judy may comment on", async () => {
    await expectListObjectsConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "dispute_d4m",
        relation: "can_comment",
        subjectType: "user_d4m",
        subjectId: uuid("judy"),
      },
      [uuid("d1")],
    );
  });

  test("29: the listings sam may edit depend on the escrow state", async () => {
    await expectListObjectsConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "listing_d4m",
        relation: "can_edit",
        subjectType: "user_d4m",
        subjectId: uuid("sam"),
        context: LIVE,
      },
      [uuid("l_boots")],
    );
    await expectListObjectsConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "listing_d4m",
        relation: "can_edit",
        subjectType: "user_d4m",
        subjectId: uuid("sam"),
        context: SOLD,
      },
      [],
    );
  });

  test("30: a contextual arbiter row widens listObjects", async () => {
    await expectListObjectsConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "dispute_d4m",
        relation: "can_comment",
        subjectType: "user_d4m",
        subjectId: uuid("zed"),
        contextualTuples: [
          {
            objectType: "dispute_d4m",
            objectId: uuid("d1"),
            relation: "arbiter",
            subjectType: "user_d4m",
            subjectId: uuid("zed"),
          },
        ],
      },
      [uuid("d1")],
    );
  });

  // --- listSubjects against upstream's ListUsers ---

  test("31: the direct editors of a listing, under a context", async () => {
    const ours = (
      await tsfga.listSubjects("listing_d4m", uuid("l_boots"), "editor", {
        context: DRAFT,
      })
    )
      .map(renderSubject)
      .sort();
    const theirs = (
      await fgaListUsers(storeId, authorizationModelId, {
        objectType: "listing_d4m",
        objectId: uuid("l_boots"),
        relation: "editor",
        filters: [{ type: "user_d4m" }],
        context: DRAFT,
      })
    )
      .map(renderSubject)
      .sort();
    // Sorted; rita's assigned id sorts before sam's.
    expect(ours).toEqual([
      `user_d4m:${uuid("rita")}`,
      `user_d4m:${uuid("sam")}`,
    ]);
    expect(ours).toEqual(theirs);
  });

  test("32: the arbiters of a dispute are a userset row", async () => {
    const ours = (
      await tsfga.listSubjects("dispute_d4m", uuid("d1"), "arbiter")
    ).map(renderSubject);
    expect(ours).toEqual([`group_d4m:${uuid("g_arb")}#member`]);
    // Upstream resolves the userset rather than reporting it, so
    // the comparison is containment over both filter shapes.
    const upstream = new Set([
      ...(
        await fgaListUsers(storeId, authorizationModelId, {
          objectType: "dispute_d4m",
          objectId: uuid("d1"),
          relation: "arbiter",
          filters: [{ type: "group_d4m", relation: "member" }],
        })
      ).map(renderSubject),
      ...(
        await fgaListUsers(storeId, authorizationModelId, {
          objectType: "dispute_d4m",
          objectId: uuid("d1"),
          relation: "arbiter",
          filters: [{ type: "user_d4m" }],
        })
      ).map(renderSubject),
    ]);
    for (const row of ours) expect(upstream.has(row)).toBe(true);
  });

  test("33: the wildcard ban is reported as a wildcard by both", async () => {
    const ours = (
      await tsfga.listSubjects("merchant_d4m", uuid("m_bad"), "banned")
    )
      .map(renderSubject)
      .sort();
    const theirs = (
      await fgaListUsers(storeId, authorizationModelId, {
        objectType: "merchant_d4m",
        objectId: uuid("m_bad"),
        relation: "banned",
        filters: [{ type: "user_d4m" }],
      })
    )
      .map(renderSubject)
      .sort();
    expect(ours).toEqual(["user_d4m:*"]);
    expect(ours).toEqual(theirs);
  });

  // --- checkMany over one scope ---

  test("34: a batch mixing subject shapes, contexts and refusals", async () => {
    const items = [
      {
        objectType: "dispute_d4m",
        objectId: uuid("d1"),
        relation: "can_comment",
        subjectType: "user_d4m",
        subjectId: uuid("tina"),
      },
      {
        objectType: "dispute_d4m",
        objectId: uuid("d2"),
        relation: "can_comment",
        subjectType: "user_d4m",
        subjectId: uuid("judy"),
      },
      {
        objectType: "listing_d4m",
        objectId: uuid("l_boots"),
        relation: "can_edit",
        subjectType: "user_d4m",
        subjectId: uuid("sam"),
        context: LIVE,
      },
      {
        objectType: "listing_d4m",
        objectId: uuid("l_boots"),
        relation: "can_edit",
        subjectType: "user_d4m",
        subjectId: uuid("sam"),
        context: SOLD,
      },
      {
        objectType: "listing_d4m",
        objectId: uuid("l_boots"),
        relation: "can_edit",
        subjectType: "user_d4m",
        subjectId: uuid("sam"),
      },
      {
        objectType: "order_d4m",
        objectId: uuid("ord1"),
        relation: "can_release",
        subjectType: "user_d4m",
        subjectId: uuid("vera"),
        context: GOOD_REF,
      },
      {
        objectType: "listing_d4m",
        objectId: uuid("l_hat"),
        relation: "verified",
        subjectType: "group_d4m",
        subjectId: uuid("g_ops"),
        subjectRelation: "member",
      },
      {
        objectType: "order_d4m",
        objectId: uuid("ord1"),
        relation: "can_view",
        subjectType: "user_d4m",
        subjectId: uuid("hank"),
      },
    ];
    const [ours, theirs] = await Promise.all([
      tsfga.checkMany(items),
      fgaBatchCheck(storeId, authorizationModelId, items),
    ]);
    const mine = ours.map((outcome) =>
      outcome.error === undefined ? outcome.allowed : "refused",
    );
    const upstream = theirs.map((outcome) =>
      "error" in outcome ? "refused" : outcome.allowed,
    );
    expect(mine).toEqual(upstream);
    expect(mine).toEqual([
      true,
      false,
      true,
      false,
      "refused",
      true,
      true,
      false,
    ]);
  });

  // --- The write gate ---

  test("35: a condition is required, and must be the right one", async () => {
    await expectWriteConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "order_d4m",
        objectId: uuid("ord1"),
        relation: "auditor",
        subjectType: "user_d4m",
        subjectId: uuid("zed"),
      },
      "refused",
    );
    // And not somebody else's condition.
    await expectWriteConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "listing_d4m",
        objectId: uuid("l_boots"),
        relation: "editor",
        subjectType: "user_d4m",
        subjectId: uuid("zed"),
        conditionName: "order_ref_d4m",
      },
      "refused",
    );
  });

  test("36: a buyer is a person, a block is a wildcard", async () => {
    await expectWriteConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "order_d4m",
        objectId: uuid("ord1"),
        relation: "buyer",
        subjectType: "user_d4m",
        subjectId: "*",
      },
      "refused",
    );
    await expectWriteConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "order_d4m",
        objectId: uuid("ord1"),
        relation: "blocked",
        subjectType: "user_d4m",
        subjectId: uuid("zed"),
      },
      "refused",
    );
  });

  test("37: an editor may not be a userset", async () => {
    await expectWriteConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "listing_d4m",
        objectId: uuid("l_boots"),
        relation: "editor",
        subjectType: "group_d4m",
        subjectId: uuid("g_ops"),
        subjectRelation: "member",
      },
      "refused",
    );
  });

  test("38: nothing may be written on a computed relation", async () => {
    await expectWriteConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "merchant_d4m",
        objectId: uuid("m_acme"),
        relation: "can_administer",
        subjectType: "user_d4m",
        subjectId: uuid("zed"),
      },
      "refused",
    );
  });

  test("39: the legal writes both engines accept", async () => {
    await expectWriteConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "listing_d4m",
        objectId: uuid("l_boots"),
        relation: "verified",
        subjectType: "user_d4m",
        subjectId: uuid("zed"),
      },
      "accepted",
    );
    await expectWriteConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "order_d4m",
        objectId: uuid("ord1"),
        relation: "auditor",
        subjectType: "user_d4m",
        subjectId: uuid("zed"),
        conditionName: "order_ref_d4m",
      },
      "accepted",
    );
  });

  // --- Revocation ---

  test("40: revoking the wildcard ban restores the whole branch", async () => {
    await revoke({
      objectType: "merchant_d4m",
      objectId: uuid("m_bad"),
      relation: "banned",
      subjectType: "user_d4m",
      subjectId: "*",
    });
    await can("seller_d4m", "s_beta", "can_manage", "quinn", true);
    await can("listing_d4m", "l_hat", "can_edit", "quinn", true);
    await can("order_d4m", "ord2", "can_view", "tina", true);
    await can("dispute_d4m", "d2", "can_comment", "judy", true);
    // The block on ord2 is local and survives.
    await can("order_d4m", "ord2", "can_release", "tina", false);
  });

  test("41: revoking the nested group edge cuts ivy off", async () => {
    await revoke({
      objectType: "group_d4m",
      objectId: uuid("g_staff"),
      relation: "member",
      subjectType: "group_d4m",
      subjectId: uuid("g_ops"),
      subjectRelation: "member",
    });
    await can("merchant_d4m", "m_acme", "can_administer", "ivy", false);
    await can("listing_d4m", "l_boots", "can_edit", "ivy", false);
    await can("order_d4m", "ord1", "can_view", "ivy", false);
    // hank's own staff row is direct, so the edge above it is not
    // what he held.
    await can("merchant_d4m", "m_acme", "can_administer", "hank", true);
  });

  test("42: revoking the TTU arm cuts the merchant owner off", async () => {
    await can("order_d4m", "ord1", "can_view", "mona", true);
    await revoke({
      objectType: "seller_d4m",
      objectId: uuid("s_alpha"),
      relation: "merchant",
      subjectType: "merchant_d4m",
      subjectId: uuid("m_acme"),
    });
    await can("order_d4m", "ord1", "can_view", "mona", false);
    await can("listing_d4m", "l_boots", "can_edit", "mona", false);
    // The operator arm is direct on the seller and survives.
    await can("order_d4m", "ord1", "can_view", "pete", true);
    // And so does the ban's minuend, now that nothing feeds it.
    await can("listing_d4m", "l_boots", "banned", "hank", false);
    await can("listing_d4m", "l_boots", "can_edit", "hank", false);
  });

  test("the relation configs say what the model says", () => {
    expectConfigsMatchModel("./market/model.dsl", fixture, {
      coverage: "complete",
    });
  });
});
