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
import { fgaBatchCheck } from "./batch/upstream.ts";
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
 * Slack Connect: a channel shared across an organisation boundary,
 * where the *same* invitation means different things depending on
 * which side of the boundary the subject stands.
 *
 * The seam is that `invited` is one relation resolved by two
 * intersections that differ only in their tupleset —
 * `internal_member` is `invited and active_principal from
 * owner_org`, `external_candidate` is `invited and
 * active_principal from shared_org` — and only the external half
 * is then cut by `internal_only`. So an "internal only" flag has
 * to remove the partner's people from a channel they are
 * genuinely invited to while leaving the host's people alone,
 * which is a subtraction applied to *one operand's* side of a
 * union of two intersections. Getting it wrong leaks a channel
 * across a company boundary, which is the one thing Slack Connect
 * exists to prevent.
 *
 * Around it: `active_principal` is itself `(member or guest) but
 * not suspended` and every invitation names it as a **userset**,
 * so each membership test expands a rewrite rather than a direct
 * relation; a guest whose membership expires by condition; a
 * verified-domain condition whose RE2 pattern is **built by
 * concatenation** at evaluation time, so the tuple's domain
 * becomes part of the pattern (unescaped dots and all — both
 * engines must read `acme.com` the same permissive way); and a
 * message whose `can_delete` reaches an org admin three dispatches
 * away through a chain of TTUs.
 */

const CONDITIONS: ConditionDefinition[] = [
  {
    name: "guest_window_d4x",
    expression: "now < expires_at",
    parameters: { now: "timestamp", expires_at: "timestamp" },
  },
  {
    name: "verified_domain_d4x",
    expression: 'email.endsWith("@" + domain)',
    parameters: { email: "string", domain: "string" },
  },
];

const GUEST_EXPIRY = "2026-06-01T00:00:00Z";
const IN_GUEST_WINDOW = { now: "2026-05-01T00:00:00Z" };
const PAST_GUEST_WINDOW = { now: "2026-07-01T00:00:00Z" };
const GOOD_EMAIL = { email: "bea@acme.com" };
const WRONG_EMAIL = { email: "bea@evil.com" };
/** Everything any arm of the model may ask for. */
const ALL = { ...IN_GUEST_WINDOW, ...GOOD_EMAIL };

const uuidMap = new Map<string, string>([
  ["ann", "00000000-0000-4000-d580-000000000001"],
  ["acme", "00000000-0000-4000-d580-000000000002"],
  ["bea", "00000000-0000-4000-d580-000000000003"],
  ["gus", "00000000-0000-4000-d580-000000000004"],
  ["vic", "00000000-0000-4000-d580-000000000005"],
  ["vendor", "00000000-0000-4000-d580-000000000006"],
  ["wes", "00000000-0000-4000-d580-000000000007"],
  ["rob", "00000000-0000-4000-d580-000000000008"],
  ["rogue", "00000000-0000-4000-d580-000000000009"],
  ["c_general", "00000000-0000-4000-d580-000000000010"],
  ["c_ops", "00000000-0000-4000-d580-000000000011"],
  ["c_ann", "00000000-0000-4000-d580-000000000012"],
  ["m1", "00000000-0000-4000-d580-000000000013"],
  ["m2", "00000000-0000-4000-d580-000000000014"],
  ["zed", "00000000-0000-4000-d580-000000000015"],
]);

function uuid(name: string): string {
  const id = uuidMap.get(name);
  if (!id) throw new Error(`No UUID for ${name}`);
  return id;
}

describe("Slack Connect Model Conformance", () => {
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
    extra?: {
      context?: Record<string, unknown>;
      contextualTuples?: AddTupleRequest[];
    },
  ): Promise<void> {
    return expectConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType,
        objectId: uuid(objectId),
        relation,
        subjectType: "user_d4x",
        subjectId: uuid(subject),
        ...(extra?.context ? { context: extra.context } : {}),
        ...(extra?.contextualTuples
          ? { contextualTuples: extra.contextualTuples }
          : {}),
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
    assertUuidMapCovers("./connect/tuples.yaml", uuidMap);

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
    const person = { type: "user_d4x" } as const;
    const anyone = { type: "user_d4x", wildcard: true } as const;

    // --- org ---
    await tsfga.writeRelationConfig({
      objectType: "org_d4x",
      relation: "member",
      directlyAssignable: [
        person,
        { type: "user_d4x", condition: "verified_domain_d4x" },
      ],
      ...plain,
    });
    await tsfga.writeRelationConfig({
      objectType: "org_d4x",
      relation: "guest",
      directlyAssignable: [{ type: "user_d4x", condition: "guest_window_d4x" }],
      ...plain,
    });
    await tsfga.writeRelationConfig({
      objectType: "org_d4x",
      relation: "admin",
      directlyAssignable: [person],
      ...plain,
    });
    await tsfga.writeRelationConfig({
      objectType: "org_d4x",
      relation: "suspended",
      directlyAssignable: [person, anyone],
      ...plain,
    });
    await tsfga.writeRelationConfig({
      objectType: "org_d4x",
      relation: "principal",
      directlyAssignable: [],
      ...plain,
      impliedBy: ["member", "guest"],
    });
    await tsfga.writeRelationConfig({
      objectType: "org_d4x",
      relation: "active_principal",
      directlyAssignable: [],
      ...plain,
      computedUserset: "principal",
      excludedBy: "suspended",
    });

    // --- channel ---
    await tsfga.writeRelationConfig({
      objectType: "channel_d4x",
      relation: "owner_org",
      directlyAssignable: [{ type: "org_d4x" }],
      ...plain,
    });
    await tsfga.writeRelationConfig({
      objectType: "channel_d4x",
      relation: "shared_org",
      directlyAssignable: [{ type: "org_d4x" }],
      ...plain,
    });
    await tsfga.writeRelationConfig({
      objectType: "channel_d4x",
      relation: "invited",
      directlyAssignable: [
        person,
        { type: "org_d4x", relation: "member" },
        { type: "org_d4x", relation: "active_principal" },
      ],
      ...plain,
    });
    await tsfga.writeRelationConfig({
      objectType: "channel_d4x",
      relation: "internal_only",
      directlyAssignable: [anyone],
      ...plain,
    });
    await tsfga.writeRelationConfig({
      objectType: "channel_d4x",
      relation: "banned",
      directlyAssignable: [person, { type: "org_d4x", relation: "member" }],
      ...plain,
    });
    await tsfga.writeRelationConfig({
      objectType: "channel_d4x",
      relation: "readonly",
      directlyAssignable: [person, anyone],
      ...plain,
    });
    await tsfga.writeRelationConfig({
      objectType: "channel_d4x",
      relation: "moderators",
      directlyAssignable: [],
      ...plain,
      tupleToUserset: [{ tupleset: "owner_org", computedUserset: "admin" }],
    });
    await tsfga.writeRelationConfig({
      objectType: "channel_d4x",
      relation: "internal_member",
      directlyAssignable: [],
      ...plain,
      intersection: [
        { type: "computedUserset", relation: "invited" },
        {
          type: "tupleToUserset",
          tupleset: "owner_org",
          computedUserset: "active_principal",
        },
      ],
    });
    await tsfga.writeRelationConfig({
      objectType: "channel_d4x",
      relation: "external_candidate",
      directlyAssignable: [],
      ...plain,
      intersection: [
        { type: "computedUserset", relation: "invited" },
        {
          type: "tupleToUserset",
          tupleset: "shared_org",
          computedUserset: "active_principal",
        },
      ],
    });
    await tsfga.writeRelationConfig({
      objectType: "channel_d4x",
      relation: "external_member",
      directlyAssignable: [],
      ...plain,
      computedUserset: "external_candidate",
      excludedBy: "internal_only",
    });
    await tsfga.writeRelationConfig({
      objectType: "channel_d4x",
      relation: "can_view",
      directlyAssignable: [],
      ...plain,
      impliedBy: ["internal_member", "external_member"],
      excludedBy: "banned",
    });
    await tsfga.writeRelationConfig({
      objectType: "channel_d4x",
      relation: "can_post",
      directlyAssignable: [],
      ...plain,
      computedUserset: "can_view",
      excludedBy: "readonly",
    });

    // --- message ---
    await tsfga.writeRelationConfig({
      objectType: "message_d4x",
      relation: "channel",
      directlyAssignable: [{ type: "channel_d4x" }],
      ...plain,
    });
    await tsfga.writeRelationConfig({
      objectType: "message_d4x",
      relation: "author",
      directlyAssignable: [person],
      ...plain,
    });
    await tsfga.writeRelationConfig({
      objectType: "message_d4x",
      relation: "moderator",
      directlyAssignable: [],
      ...plain,
      tupleToUserset: [{ tupleset: "channel", computedUserset: "moderators" }],
    });
    await tsfga.writeRelationConfig({
      objectType: "message_d4x",
      relation: "can_view",
      directlyAssignable: [],
      ...plain,
      tupleToUserset: [{ tupleset: "channel", computedUserset: "can_view" }],
    });
    await tsfga.writeRelationConfig({
      objectType: "message_d4x",
      relation: "can_edit",
      directlyAssignable: [],
      ...plain,
      intersection: [
        { type: "computedUserset", relation: "author" },
        {
          type: "tupleToUserset",
          tupleset: "channel",
          computedUserset: "can_post",
        },
      ],
    });
    await tsfga.writeRelationConfig({
      objectType: "message_d4x",
      relation: "can_delete",
      directlyAssignable: [],
      ...plain,
      impliedBy: ["can_edit", "moderator"],
    });

    // === Tuples (mirroring ./connect/tuples.yaml) ===
    const tuples: AddTupleRequest[] = [
      {
        objectType: "org_d4x",
        objectId: uuid("acme"),
        relation: "member",
        subjectType: "user_d4x",
        subjectId: uuid("ann"),
      },
      {
        objectType: "org_d4x",
        objectId: uuid("acme"),
        relation: "member",
        subjectType: "user_d4x",
        subjectId: uuid("bea"),
        conditionName: "verified_domain_d4x",
        conditionContext: { domain: "acme.com" },
      },
      {
        objectType: "org_d4x",
        objectId: uuid("acme"),
        relation: "admin",
        subjectType: "user_d4x",
        subjectId: uuid("ann"),
      },
      {
        objectType: "org_d4x",
        objectId: uuid("acme"),
        relation: "guest",
        subjectType: "user_d4x",
        subjectId: uuid("gus"),
        conditionName: "guest_window_d4x",
        conditionContext: { expires_at: GUEST_EXPIRY },
      },
      {
        objectType: "org_d4x",
        objectId: uuid("vendor"),
        relation: "member",
        subjectType: "user_d4x",
        subjectId: uuid("vic"),
      },
      {
        objectType: "org_d4x",
        objectId: uuid("vendor"),
        relation: "member",
        subjectType: "user_d4x",
        subjectId: uuid("wes"),
      },
      {
        objectType: "org_d4x",
        objectId: uuid("vendor"),
        relation: "suspended",
        subjectType: "user_d4x",
        subjectId: uuid("wes"),
      },
      {
        objectType: "org_d4x",
        objectId: uuid("rogue"),
        relation: "member",
        subjectType: "user_d4x",
        subjectId: uuid("rob"),
      },
      {
        objectType: "channel_d4x",
        objectId: uuid("c_general"),
        relation: "owner_org",
        subjectType: "org_d4x",
        subjectId: uuid("acme"),
      },
      {
        objectType: "channel_d4x",
        objectId: uuid("c_general"),
        relation: "shared_org",
        subjectType: "org_d4x",
        subjectId: uuid("vendor"),
      },
      {
        objectType: "channel_d4x",
        objectId: uuid("c_general"),
        relation: "invited",
        subjectType: "org_d4x",
        subjectId: uuid("acme"),
        subjectRelation: "member",
      },
      {
        objectType: "channel_d4x",
        objectId: uuid("c_general"),
        relation: "invited",
        subjectType: "org_d4x",
        subjectId: uuid("vendor"),
        subjectRelation: "active_principal",
      },
      {
        objectType: "channel_d4x",
        objectId: uuid("c_general"),
        relation: "invited",
        subjectType: "user_d4x",
        subjectId: uuid("gus"),
      },
      {
        objectType: "channel_d4x",
        objectId: uuid("c_general"),
        relation: "banned",
        subjectType: "user_d4x",
        subjectId: uuid("bea"),
      },
      {
        objectType: "channel_d4x",
        objectId: uuid("c_ops"),
        relation: "owner_org",
        subjectType: "org_d4x",
        subjectId: uuid("acme"),
      },
      {
        objectType: "channel_d4x",
        objectId: uuid("c_ops"),
        relation: "shared_org",
        subjectType: "org_d4x",
        subjectId: uuid("vendor"),
      },
      {
        objectType: "channel_d4x",
        objectId: uuid("c_ops"),
        relation: "invited",
        subjectType: "org_d4x",
        subjectId: uuid("acme"),
        subjectRelation: "member",
      },
      {
        objectType: "channel_d4x",
        objectId: uuid("c_ops"),
        relation: "invited",
        subjectType: "org_d4x",
        subjectId: uuid("vendor"),
        subjectRelation: "active_principal",
      },
      {
        objectType: "channel_d4x",
        objectId: uuid("c_ops"),
        relation: "internal_only",
        subjectType: "user_d4x",
        subjectId: "*",
      },
      {
        objectType: "channel_d4x",
        objectId: uuid("c_ann"),
        relation: "owner_org",
        subjectType: "org_d4x",
        subjectId: uuid("acme"),
      },
      {
        objectType: "channel_d4x",
        objectId: uuid("c_ann"),
        relation: "shared_org",
        subjectType: "org_d4x",
        subjectId: uuid("vendor"),
      },
      {
        objectType: "channel_d4x",
        objectId: uuid("c_ann"),
        relation: "invited",
        subjectType: "org_d4x",
        subjectId: uuid("acme"),
        subjectRelation: "member",
      },
      {
        objectType: "channel_d4x",
        objectId: uuid("c_ann"),
        relation: "readonly",
        subjectType: "user_d4x",
        subjectId: "*",
      },
      {
        objectType: "message_d4x",
        objectId: uuid("m1"),
        relation: "channel",
        subjectType: "channel_d4x",
        subjectId: uuid("c_general"),
      },
      {
        objectType: "message_d4x",
        objectId: uuid("m1"),
        relation: "author",
        subjectType: "user_d4x",
        subjectId: uuid("ann"),
      },
      {
        objectType: "message_d4x",
        objectId: uuid("m2"),
        relation: "channel",
        subjectType: "channel_d4x",
        subjectId: uuid("c_general"),
      },
      {
        objectType: "message_d4x",
        objectId: uuid("m2"),
        relation: "author",
        subjectType: "user_d4x",
        subjectId: uuid("vic"),
      },
    ];
    for (const tuple of tuples) await tsfga.addTuple(tuple);

    storeId = await fgaCreateStore("connect");
    fgaClient = new OpenFgaClient({ apiUrl: process.env.FGA_API_URL, storeId });
    authorizationModelId = await fgaWriteModel(storeId, "./connect/model.dsl");
    await fgaWriteTuples(
      storeId,
      "./connect/tuples.yaml",
      authorizationModelId,
      uuidMap,
    );
  });

  afterAll(async () => {
    await rollbackTransaction(db);
    await destroyDb();
  });

  // --- The two organisations ---

  test("1: a plain member is an active principal", async () => {
    await can("org_d4x", "acme", "member", "ann", true);
    await can("org_d4x", "acme", "active_principal", "ann", true);
  });

  test("2: a domain-verified member needs the request to say so", async () => {
    await can("org_d4x", "acme", "member", "bea", true, {
      context: GOOD_EMAIL,
    });
    await can("org_d4x", "acme", "member", "bea", false, {
      context: WRONG_EMAIL,
    });
    await can("org_d4x", "acme", "member", "bea", "refused");
  });

  test("3: the concatenated suffix is anchored to the `@`", async () => {
    // `"@" + domain` is still built from the tuple's own `domain`,
    // so the condition narrows on data rather than on a literal.
    // A subdomain ends with `.acme.com` and not with `@acme.com`,
    // which is what keeps the suffix from being a substring test.
    //
    // The cell that used to sit here asserted the *other* half of
    // the old pattern — that the spliced dot stayed a
    // metacharacter, so `bea@acmeXcom` was admitted. That is a
    // statement about regular expressions rather than about this
    // model, and it is retired to `docs/cel-js/` rather than
    // rewritten: no string predicate admits it, and moving its
    // expectation to suit the rewrite is exactly the substitution
    // the rewrite rule forbids.
    await can("org_d4x", "acme", "member", "bea", false, {
      context: { email: "bea@sub.acme.com" },
    });
    // Added negative: a value the old pattern rejected, which the
    // rewrite must also reject. Without a cell like this one a
    // rewrite to `true` would pass.
    await can("org_d4x", "acme", "member", "bea", false, {
      context: { email: "acme.com" },
    });
  });

  test("4: a guest is a principal only inside the window", async () => {
    await can("org_d4x", "acme", "active_principal", "gus", true, {
      context: IN_GUEST_WINDOW,
    });
    await can("org_d4x", "acme", "active_principal", "gus", false, {
      context: PAST_GUEST_WINDOW,
    });
  });

  test("5: a suspension takes the partner member out", async () => {
    await can("org_d4x", "vendor", "member", "wes", true);
    await can("org_d4x", "vendor", "active_principal", "wes", false);
    await can("org_d4x", "vendor", "active_principal", "vic", true);
  });

  // --- The shared channel ---

  test("6: the host's own member is an internal member", async () => {
    await can("channel_d4x", "c_general", "invited", "ann", true);
    await can("channel_d4x", "c_general", "internal_member", "ann", true);
    await can("channel_d4x", "c_general", "can_view", "ann", true);
  });

  test("7: the partner's member is an external member", async () => {
    await can("channel_d4x", "c_general", "invited", "vic", true);
    await can("channel_d4x", "c_general", "internal_member", "vic", false);
    await can("channel_d4x", "c_general", "external_member", "vic", true);
    await can("channel_d4x", "c_general", "can_view", "vic", true);
  });

  test("8: the suspended partner member is not invited at all", async () => {
    await can("channel_d4x", "c_general", "invited", "wes", false);
    await can("channel_d4x", "c_general", "can_view", "wes", false);
  });

  test("9: an unrelated org reaches nothing", async () => {
    await can("channel_d4x", "c_general", "can_view", "rob", false);
  });

  test("10: the guest is invited by name and cleared by the clock", async () => {
    await can("channel_d4x", "c_general", "can_view", "gus", true, {
      context: IN_GUEST_WINDOW,
    });
    await can("channel_d4x", "c_general", "can_view", "gus", false, {
      context: PAST_GUEST_WINDOW,
    });
  });

  test("11: the ban is applied after both intersections", async () => {
    await can("channel_d4x", "c_general", "internal_member", "bea", true, {
      context: GOOD_EMAIL,
    });
    await can("channel_d4x", "c_general", "banned", "bea", true);
    await can("channel_d4x", "c_general", "can_view", "bea", false, {
      context: GOOD_EMAIL,
    });
  });

  // --- The internal-only flag, which cuts one side of the union ---

  test("12: internal-only leaves the host's people untouched", async () => {
    await can("channel_d4x", "c_ops", "internal_member", "ann", true);
    await can("channel_d4x", "c_ops", "can_view", "ann", true);
  });

  test("13: and removes the partner's, though they are invited", async () => {
    await can("channel_d4x", "c_ops", "invited", "vic", true);
    await can("channel_d4x", "c_ops", "external_candidate", "vic", true);
    await can("channel_d4x", "c_ops", "external_member", "vic", false);
    await can("channel_d4x", "c_ops", "can_view", "vic", false);
  });

  test("14: the flag does not reach the channel beside it", async () => {
    await can("channel_d4x", "c_general", "can_view", "vic", true);
  });

  test("15: the guest is internal, so internal-only keeps him", async () => {
    await can("channel_d4x", "c_ops", "can_view", "gus", false, {
      context: IN_GUEST_WINDOW,
    });
    // gus is not invited to c_ops at all — only acme#member is,
    // and a guest is not a member. The internal/external split is
    // about the *org*, the invitation is about the row.
    //
    // The context is carried even though gus's own answer does not
    // need it: expanding `acme#member` reads bea's conditioned row
    // too, and a context that cannot evaluate it is the pinned
    // sibling-error shape rather than anything this fixture is
    // about.
    await can("channel_d4x", "c_ops", "invited", "gus", false, {
      context: ALL,
    });
  });

  // --- Posting, and the read-only channel ---

  test("16: a read-only channel is viewable but not postable", async () => {
    await can("channel_d4x", "c_ann", "can_view", "ann", true);
    await can("channel_d4x", "c_ann", "can_post", "ann", false);
  });

  test("17: the partner is not invited to announcements at all", async () => {
    await can("channel_d4x", "c_ann", "can_view", "vic", false);
  });

  test("18: the shared channel stays postable", async () => {
    await can("channel_d4x", "c_general", "can_post", "ann", true);
    await can("channel_d4x", "c_general", "can_post", "vic", true);
  });

  // --- Messages, three dispatches from the org admin ---

  test("19: a message is visible to whoever sees its channel", async () => {
    await can("message_d4x", "m1", "can_view", "vic", true);
    await can("message_d4x", "m1", "can_view", "rob", false);
  });

  test("20: only the author edits, and only where posting is open", async () => {
    await can("message_d4x", "m1", "can_edit", "ann", true);
    await can("message_d4x", "m1", "can_edit", "vic", false);
    await can("message_d4x", "m2", "can_edit", "vic", true);
  });

  test("21: the host's admin moderates across the boundary", async () => {
    await can("message_d4x", "m2", "moderator", "ann", true);
    await can("message_d4x", "m2", "can_delete", "ann", true);
    await can("message_d4x", "m2", "can_delete", "vic", true);
    await can("message_d4x", "m1", "can_delete", "vic", false);
  });

  test("22: the partner has no moderator anywhere", async () => {
    await can("message_d4x", "m1", "moderator", "vic", false);
  });

  // --- Contextual tuples, in every shape ---

  test("23: a bare contextual invitation grants", async () => {
    await can("channel_d4x", "c_general", "can_view", "zed", false);
    await can("channel_d4x", "c_general", "can_view", "zed", true, {
      contextualTuples: [
        {
          objectType: "channel_d4x",
          objectId: uuid("c_general"),
          relation: "invited",
          subjectType: "user_d4x",
          subjectId: uuid("zed"),
        },
        {
          objectType: "org_d4x",
          objectId: uuid("acme"),
          relation: "member",
          subjectType: "user_d4x",
          subjectId: uuid("zed"),
        },
      ],
    });
  });

  test("24: a contextual userset invitation opens the partner side", async () => {
    await can("channel_d4x", "c_ann", "can_view", "vic", true, {
      contextualTuples: [
        {
          objectType: "channel_d4x",
          objectId: uuid("c_ann"),
          relation: "invited",
          subjectType: "org_d4x",
          subjectId: uuid("vendor"),
          subjectRelation: "active_principal",
        },
      ],
    });
    // …and the suspended partner member still does not get in.
    await can("channel_d4x", "c_ann", "can_view", "wes", false, {
      contextualTuples: [
        {
          objectType: "channel_d4x",
          objectId: uuid("c_ann"),
          relation: "invited",
          subjectType: "org_d4x",
          subjectId: uuid("vendor"),
          subjectRelation: "active_principal",
        },
      ],
    });
  });

  test("25: a conditioned contextual membership answers on the clock", async () => {
    const tuple: AddTupleRequest = {
      objectType: "org_d4x",
      objectId: uuid("acme"),
      relation: "guest",
      subjectType: "user_d4x",
      subjectId: uuid("zed"),
      conditionName: "guest_window_d4x",
      conditionContext: { expires_at: GUEST_EXPIRY },
    };
    const invite: AddTupleRequest = {
      objectType: "channel_d4x",
      objectId: uuid("c_general"),
      relation: "invited",
      subjectType: "user_d4x",
      subjectId: uuid("zed"),
    };
    await can("channel_d4x", "c_general", "can_view", "zed", true, {
      context: IN_GUEST_WINDOW,
      contextualTuples: [tuple, invite],
    });
    await can("channel_d4x", "c_general", "can_view", "zed", false, {
      context: PAST_GUEST_WINDOW,
      contextualTuples: [tuple, invite],
    });
  });

  test("26: a contextual wildcard closes the shared channel", async () => {
    await can("channel_d4x", "c_general", "can_view", "vic", false, {
      contextualTuples: [
        {
          objectType: "channel_d4x",
          objectId: uuid("c_general"),
          relation: "internal_only",
          subjectType: "user_d4x",
          subjectId: "*",
        },
      ],
    });
    // …and leaves the host's own people alone, which is the whole
    // point of putting the subtraction on one operand only.
    await can("channel_d4x", "c_general", "can_view", "ann", true, {
      contextualTuples: [
        {
          objectType: "channel_d4x",
          objectId: uuid("c_general"),
          relation: "internal_only",
          subjectType: "user_d4x",
          subjectId: "*",
        },
      ],
    });
  });

  test("27: a contextual row shadowing a stored conditioned one", async () => {
    // bea's stored membership demands a verified domain; the
    // request sends an unconditioned row on the same key, so the
    // check can only answer from the contextual row.
    await can("org_d4x", "acme", "member", "bea", true, {
      contextualTuples: [
        {
          objectType: "org_d4x",
          objectId: uuid("acme"),
          relation: "member",
          subjectType: "user_d4x",
          subjectId: uuid("bea"),
        },
      ],
    });
  });

  test("28: and the mirror image, shadowing an unconditioned row", async () => {
    await can("org_d4x", "acme", "member", "ann", false, {
      contextualTuples: [
        {
          objectType: "org_d4x",
          objectId: uuid("acme"),
          relation: "member",
          subjectType: "user_d4x",
          subjectId: uuid("ann"),
          conditionName: "verified_domain_d4x",
          conditionContext: { domain: "acme.com" },
        },
      ],
      context: { email: "ann@evil.com" },
    });
  });

  test("29: a contextual row the model does not admit refuses", async () => {
    await can("channel_d4x", "c_general", "can_view", "zed", "refused", {
      contextualTuples: [
        {
          objectType: "channel_d4x",
          objectId: uuid("c_general"),
          relation: "invited",
          subjectType: "user_d4x",
          subjectId: "*",
        },
      ],
    });
  });

  // --- listObjects ---

  test("30: the channels the host's member reaches", async () => {
    await expectListObjectsConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "channel_d4x",
        relation: "can_view",
        subjectType: "user_d4x",
        subjectId: uuid("ann"),
      },
      [uuid("c_general"), uuid("c_ops"), uuid("c_ann")],
    );
  });

  test("31: the channels the partner reaches, after internal-only", async () => {
    await expectListObjectsConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "channel_d4x",
        relation: "can_view",
        subjectType: "user_d4x",
        subjectId: uuid("vic"),
      },
      [uuid("c_general")],
    );
  });

  test("32: the channels the suspended partner member reaches", async () => {
    await expectListObjectsConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "channel_d4x",
        relation: "can_view",
        subjectType: "user_d4x",
        subjectId: uuid("wes"),
      },
      [],
    );
  });

  test("33: the channels bea reaches once the domain verifies", async () => {
    await expectListObjectsConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "channel_d4x",
        relation: "can_view",
        subjectType: "user_d4x",
        subjectId: uuid("bea"),
        context: GOOD_EMAIL,
      },
      [uuid("c_ops"), uuid("c_ann")],
    );
    await expectListObjectsConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "channel_d4x",
        relation: "can_view",
        subjectType: "user_d4x",
        subjectId: uuid("bea"),
        context: WRONG_EMAIL,
      },
      [],
    );
  });

  test("34: the channels the guest reaches, by the clock", async () => {
    await expectListObjectsConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "channel_d4x",
        relation: "can_view",
        subjectType: "user_d4x",
        subjectId: uuid("gus"),
        context: IN_GUEST_WINDOW,
      },
      [uuid("c_general")],
    );
    await expectListObjectsConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "channel_d4x",
        relation: "can_view",
        subjectType: "user_d4x",
        subjectId: uuid("gus"),
        context: PAST_GUEST_WINDOW,
      },
      [],
    );
  });

  test("35: the messages the partner may delete", async () => {
    await expectListObjectsConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "message_d4x",
        relation: "can_delete",
        subjectType: "user_d4x",
        subjectId: uuid("vic"),
      },
      [uuid("m2")],
    );
  });

  test("36: a contextual invitation widens the channel list", async () => {
    await expectListObjectsConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "channel_d4x",
        relation: "can_view",
        subjectType: "user_d4x",
        subjectId: uuid("vic"),
        contextualTuples: [
          {
            objectType: "channel_d4x",
            objectId: uuid("c_ann"),
            relation: "invited",
            subjectType: "org_d4x",
            subjectId: uuid("vendor"),
            subjectRelation: "active_principal",
          },
        ],
      },
      [uuid("c_general"), uuid("c_ann")],
    );
  });

  // --- checkMany over one scope ---

  test("37: a batch mixing sides of the boundary and a refusal", async () => {
    const items = [
      {
        objectType: "channel_d4x",
        objectId: uuid("c_general"),
        relation: "can_view",
        subjectType: "user_d4x",
        subjectId: uuid("ann"),
      },
      {
        objectType: "channel_d4x",
        objectId: uuid("c_ops"),
        relation: "can_view",
        subjectType: "user_d4x",
        subjectId: uuid("vic"),
      },
      {
        objectType: "channel_d4x",
        objectId: uuid("c_general"),
        relation: "can_view",
        subjectType: "user_d4x",
        subjectId: uuid("vic"),
      },
      {
        objectType: "org_d4x",
        objectId: uuid("acme"),
        relation: "member",
        subjectType: "user_d4x",
        subjectId: uuid("bea"),
      },
      {
        objectType: "org_d4x",
        objectId: uuid("acme"),
        relation: "member",
        subjectType: "user_d4x",
        subjectId: uuid("bea"),
        context: GOOD_EMAIL,
      },
      {
        objectType: "channel_d4x",
        objectId: uuid("c_general"),
        relation: "can_view",
        subjectType: "user_d4x",
        subjectId: uuid("gus"),
        context: IN_GUEST_WINDOW,
      },
      {
        objectType: "message_d4x",
        objectId: uuid("m2"),
        relation: "can_delete",
        subjectType: "user_d4x",
        subjectId: uuid("ann"),
      },
      {
        objectType: "channel_d4x",
        objectId: uuid("c_ann"),
        relation: "can_post",
        subjectType: "user_d4x",
        subjectId: uuid("ann"),
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
      "refused",
      true,
      true,
      true,
      false,
    ]);
  });

  // --- The write gate ---

  test("38: an invitation may name either userset, not any userset", async () => {
    await expectWriteConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "channel_d4x",
        objectId: uuid("c_ann"),
        relation: "invited",
        subjectType: "org_d4x",
        subjectId: uuid("vendor"),
        subjectRelation: "member",
      },
      "accepted",
    );
    await expectWriteConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "channel_d4x",
        objectId: uuid("c_ann"),
        relation: "invited",
        subjectType: "org_d4x",
        subjectId: uuid("vendor"),
        subjectRelation: "admin",
      },
      "refused",
    );
  });

  test("39: a guest row must carry its window", async () => {
    await expectWriteConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "org_d4x",
        objectId: uuid("acme"),
        relation: "guest",
        subjectType: "user_d4x",
        subjectId: uuid("zed"),
      },
      "refused",
    );
    await expectWriteConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "org_d4x",
        objectId: uuid("acme"),
        relation: "guest",
        subjectType: "user_d4x",
        subjectId: uuid("zed"),
        conditionName: "verified_domain_d4x",
        conditionContext: { domain: "acme.com" },
      },
      "refused",
    );
  });

  test("40: internal-only is a wildcard and nothing else", async () => {
    await expectWriteConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "channel_d4x",
        objectId: uuid("c_ann"),
        relation: "internal_only",
        subjectType: "user_d4x",
        subjectId: uuid("zed"),
      },
      "refused",
    );
    await expectWriteConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "channel_d4x",
        objectId: uuid("c_ann"),
        relation: "internal_only",
        subjectType: "user_d4x",
        subjectId: "*",
      },
      "accepted",
    );
  });

  test("41: a ban may name a member userset, never a wildcard", async () => {
    await expectWriteConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "channel_d4x",
        objectId: uuid("c_general"),
        relation: "banned",
        subjectType: "user_d4x",
        subjectId: "*",
      },
      "refused",
    );
    await expectWriteConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "channel_d4x",
        objectId: uuid("c_general"),
        relation: "banned",
        subjectType: "org_d4x",
        subjectId: uuid("rogue"),
        subjectRelation: "member",
      },
      "accepted",
    );
  });

  test("42: nothing may be written on a computed relation", async () => {
    await expectWriteConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "channel_d4x",
        objectId: uuid("c_general"),
        relation: "can_view",
        subjectType: "user_d4x",
        subjectId: uuid("zed"),
      },
      "refused",
    );
    await expectWriteConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "org_d4x",
        objectId: uuid("acme"),
        relation: "active_principal",
        subjectType: "user_d4x",
        subjectId: uuid("zed"),
      },
      "refused",
    );
  });

  test("43: the writes just made are visible to a check", async () => {
    // Test 38 invited the partner to c_ann and test 40 then made
    // c_ann internal-only, so the invitation stands and the view
    // does not — the two writes compose exactly as the stored
    // model does.
    await can("channel_d4x", "c_ann", "invited", "vic", true);
    await can("channel_d4x", "c_ann", "external_candidate", "vic", true);
    await can("channel_d4x", "c_ann", "can_view", "vic", false);
    await can("channel_d4x", "c_ann", "can_view", "ann", true);
    await can("channel_d4x", "c_ops", "can_view", "ann", true);
  });

  // --- Revocation ---

  test("44: revoking the internal-only flag lets the partner back in", async () => {
    await revoke({
      objectType: "channel_d4x",
      objectId: uuid("c_ops"),
      relation: "internal_only",
      subjectType: "user_d4x",
      subjectId: "*",
    });
    await can("channel_d4x", "c_ops", "can_view", "vic", true);
    await can("channel_d4x", "c_ops", "can_view", "ann", true);
  });

  test("45: revoking the partner's invitation closes it again", async () => {
    await revoke({
      objectType: "channel_d4x",
      objectId: uuid("c_ops"),
      relation: "invited",
      subjectType: "org_d4x",
      subjectId: uuid("vendor"),
      subjectRelation: "active_principal",
    });
    await can("channel_d4x", "c_ops", "can_view", "vic", false);
    await can("channel_d4x", "c_general", "can_view", "vic", true);
  });

  test("46: revoking the suspension restores the partner member", async () => {
    await revoke({
      objectType: "org_d4x",
      objectId: uuid("vendor"),
      relation: "suspended",
      subjectType: "user_d4x",
      subjectId: uuid("wes"),
    });
    await can("org_d4x", "vendor", "active_principal", "wes", true);
    await can("channel_d4x", "c_general", "can_view", "wes", true);
  });

  test("47: revoking the shared-org link cuts every external member", async () => {
    await revoke({
      objectType: "channel_d4x",
      objectId: uuid("c_general"),
      relation: "shared_org",
      subjectType: "org_d4x",
      subjectId: uuid("vendor"),
    });
    await can("channel_d4x", "c_general", "can_view", "vic", false);
    await can("channel_d4x", "c_general", "can_view", "ann", true);
    await can("message_d4x", "m2", "can_delete", "vic", false);
    await can("message_d4x", "m2", "can_delete", "ann", true);
  });

  test("the relation configs say what the model says", () => {
    expectConfigsMatchModel("./connect/model.dsl", fixture, {
      coverage: "complete",
    });
  });
});
