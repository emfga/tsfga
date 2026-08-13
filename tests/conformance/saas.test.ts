import { afterAll, beforeAll, describe, test } from "bun:test";
import { createTsfga, type TsfgaClient } from "@tsfga/core";
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
  fgaWriteTuples,
} from "./helpers/openfga.ts";

/**
 * A multi-tenant B2B SaaS: SCIM-provisioned identity groups, a
 * tenant subscription, and workspaces that inherit from it.
 *
 * Three shapes are the reason this fixture exists.
 *
 * **The tenant link is condition-gated.** `workspace_a6s.tenant` is
 * `[tenant_a6s with subscription_active_a6s]`, so when a
 * subscription lapses the *tupleset row* stops matching and the
 * whole tuple-to-userset edge disappears — while the tenant itself
 * still grants everything it granted before. That is the difference
 * between "the link is switched off" and "the target denies", and
 * only the first is being tested here.
 *
 * **Access is time-bounded on a userset restriction.**
 * `idp_group_a6s#member with within_window_a6s` sits beside the bare
 * `idp_group_a6s#member`, so the same relation holds a conditioned
 * and an unconditioned userset row and each must be matched exactly.
 * The window's `expires_at` comes from the tuple and its `now` from
 * the request, which also makes this the model where a request that
 * binds no `now` still answers — the unconditioned sibling row held,
 * so the condition error is never raised.
 *
 * **`can_write` is a double negation.** `member but not frozen`,
 * where `frozen` is itself `legal_hold but not admin`. A workspace
 * under legal hold freezes its members and not its admins, so a
 * grant has to survive an exclusion nested inside an exclusion.
 */

const uuidMap = new Map<string, string>([
  ["alice", "00000000-0000-4000-d450-000000080001"],
  ["bob", "00000000-0000-4000-d450-000000080002"],
  ["carol", "00000000-0000-4000-d450-000000080003"],
  ["dave", "00000000-0000-4000-d450-000000080004"],
  ["erin", "00000000-0000-4000-d450-000000080005"],
  ["frank", "00000000-0000-4000-d450-000000080006"],
  ["g_all", "00000000-0000-4000-d450-000000080010"],
  ["g_staff", "00000000-0000-4000-d450-000000080011"],
  ["g_contractors", "00000000-0000-4000-d450-000000080012"],
  ["t_acme", "00000000-0000-4000-d450-000000080020"],
  ["t_lapsed", "00000000-0000-4000-d450-000000080021"],
  ["t_susp", "00000000-0000-4000-d450-000000080022"],
  ["w_main", "00000000-0000-4000-d450-000000080030"],
  ["w_lapsed", "00000000-0000-4000-d450-000000080031"],
  ["w_hold", "00000000-0000-4000-d450-000000080032"],
  ["w_susp", "00000000-0000-4000-d450-000000080033"],
]);

function uuid(name: string): string {
  const id = uuidMap.get(name);
  if (!id) throw new Error(`No UUID for ${name}`);
  return id;
}

/** Inside the contractor window. */
const NOW_OK = { now: "2026-06-01T00:00:00Z" };
/** After it. */
const NOW_EXPIRED = { now: "2028-01-01T00:00:00Z" };
/** Still inside the suspension grace period. */
const IN_GRACE = { grace_days: 10 };
/** Past it. */
const PAST_GRACE = { grace_days: 45 };

describe("Multi-tenant SaaS Model Conformance", () => {
  let db: Kysely<DB>;
  let storeId: string;
  let authorizationModelId: string;
  let tsfga: TsfgaClient;
  let fixture: FixtureRecord;

  function can(
    objectType: string,
    object: string,
    relation: string,
    subject: string,
    expected: boolean,
    context?: Record<string, unknown>,
  ): Promise<void> {
    return expectConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType,
        objectId: uuid(object),
        relation,
        subjectType: "user_a6s",
        subjectId: uuid(subject),
        ...(context ? { context } : {}),
      },
      expected,
    );
  }

  const onTenant = (
    object: string,
    relation: string,
    subject: string,
    expected: boolean,
    context?: Record<string, unknown>,
  ) => can("tenant_a6s", object, relation, subject, expected, context);

  const onWorkspace = (
    object: string,
    relation: string,
    subject: string,
    expected: boolean,
    context?: Record<string, unknown>,
  ) => can("workspace_a6s", object, relation, subject, expected, context);

  beforeAll(async () => {
    db = getDb();
    await beginTransaction(db);

    tsfga = createTsfga(new KyselyTupleStore(db));
    fixture = recordFixture(tsfga);

    await tsfga.writeConditionDefinition({
      name: "within_window_a6s",
      expression: "now < expires_at",
      parameters: { now: "timestamp", expires_at: "timestamp" },
    });
    await tsfga.writeConditionDefinition({
      name: "past_grace_a6s",
      expression: "grace_days > 30",
      parameters: { grace_days: "int" },
    });
    await tsfga.writeConditionDefinition({
      name: "subscription_active_a6s",
      expression: "subscription_active",
      parameters: { subscription_active: "bool" },
    });

    // === idp_group_a6s ===
    await tsfga.writeRelationConfig({
      objectType: "idp_group_a6s",
      relation: "member",
      directlyAssignable: [
        { type: "user_a6s" },
        { type: "user_a6s", wildcard: true },
      ],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });

    // === tenant_a6s ===
    await tsfga.writeRelationConfig({
      objectType: "tenant_a6s",
      relation: "subscriber",
      directlyAssignable: [
        { type: "user_a6s" },
        { type: "idp_group_a6s", relation: "member" },
        {
          type: "idp_group_a6s",
          relation: "member",
          condition: "within_window_a6s",
        },
      ],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });
    await tsfga.writeRelationConfig({
      objectType: "tenant_a6s",
      relation: "suspended",
      directlyAssignable: [
        { type: "user_a6s", wildcard: true, condition: "past_grace_a6s" },
      ],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });
    await tsfga.writeRelationConfig({
      objectType: "tenant_a6s",
      relation: "admin",
      directlyAssignable: [{ type: "user_a6s" }],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });
    await tsfga.writeRelationConfig({
      objectType: "tenant_a6s",
      relation: "active_member",
      directlyAssignable: [],
      impliedBy: null,
      computedUserset: "subscriber",
      tupleToUserset: null,
      excludedBy: "suspended",
      intersection: null,
    });

    // === workspace_a6s ===
    await tsfga.writeRelationConfig({
      objectType: "workspace_a6s",
      relation: "tenant",
      directlyAssignable: [
        { type: "tenant_a6s", condition: "subscription_active_a6s" },
      ],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });
    await tsfga.writeRelationConfig({
      objectType: "workspace_a6s",
      relation: "direct_member",
      directlyAssignable: [{ type: "user_a6s" }],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });
    await tsfga.writeRelationConfig({
      objectType: "workspace_a6s",
      relation: "legal_hold",
      directlyAssignable: [{ type: "user_a6s", wildcard: true }],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });
    await tsfga.writeRelationConfig({
      objectType: "workspace_a6s",
      relation: "admin",
      directlyAssignable: [{ type: "user_a6s" }],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: [{ tupleset: "tenant", computedUserset: "admin" }],
      excludedBy: null,
      intersection: null,
    });
    await tsfga.writeRelationConfig({
      objectType: "workspace_a6s",
      relation: "member",
      directlyAssignable: [],
      impliedBy: ["direct_member"],
      computedUserset: null,
      tupleToUserset: [
        { tupleset: "tenant", computedUserset: "active_member" },
      ],
      excludedBy: null,
      intersection: null,
    });
    await tsfga.writeRelationConfig({
      objectType: "workspace_a6s",
      relation: "frozen",
      directlyAssignable: [],
      impliedBy: null,
      computedUserset: "legal_hold",
      tupleToUserset: null,
      excludedBy: "admin",
      intersection: null,
    });
    await tsfga.writeRelationConfig({
      objectType: "workspace_a6s",
      relation: "can_read",
      directlyAssignable: [],
      impliedBy: null,
      computedUserset: "member",
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });
    await tsfga.writeRelationConfig({
      objectType: "workspace_a6s",
      relation: "can_write",
      directlyAssignable: [],
      impliedBy: null,
      computedUserset: "member",
      tupleToUserset: null,
      excludedBy: "frozen",
      intersection: null,
    });
    await tsfga.writeRelationConfig({
      objectType: "workspace_a6s",
      relation: "can_purge",
      directlyAssignable: [],
      impliedBy: null,
      computedUserset: "admin",
      tupleToUserset: null,
      excludedBy: "frozen",
      intersection: null,
    });

    // === Tuples ===
    await tsfga.addTuple({
      objectType: "idp_group_a6s",
      objectId: uuid("g_all"),
      relation: "member",
      subjectType: "user_a6s",
      subjectId: "*",
    });
    for (const [group, person] of [
      ["g_staff", "alice"],
      ["g_staff", "bob"],
      ["g_contractors", "carol"],
    ] as Array<[string, string]>) {
      await tsfga.addTuple({
        objectType: "idp_group_a6s",
        objectId: uuid(group),
        relation: "member",
        subjectType: "user_a6s",
        subjectId: uuid(person),
      });
    }

    await tsfga.addTuple({
      objectType: "tenant_a6s",
      objectId: uuid("t_acme"),
      relation: "subscriber",
      subjectType: "idp_group_a6s",
      subjectId: uuid("g_staff"),
      subjectRelation: "member",
    });
    await tsfga.addTuple({
      objectType: "tenant_a6s",
      objectId: uuid("t_acme"),
      relation: "subscriber",
      subjectType: "idp_group_a6s",
      subjectId: uuid("g_contractors"),
      subjectRelation: "member",
      conditionName: "within_window_a6s",
      conditionContext: { expires_at: "2027-01-01T00:00:00Z" },
    });
    await tsfga.addTuple({
      objectType: "tenant_a6s",
      objectId: uuid("t_acme"),
      relation: "admin",
      subjectType: "user_a6s",
      subjectId: uuid("alice"),
    });

    await tsfga.addTuple({
      objectType: "tenant_a6s",
      objectId: uuid("t_lapsed"),
      relation: "subscriber",
      subjectType: "idp_group_a6s",
      subjectId: uuid("g_all"),
      subjectRelation: "member",
    });

    await tsfga.addTuple({
      objectType: "tenant_a6s",
      objectId: uuid("t_susp"),
      relation: "subscriber",
      subjectType: "idp_group_a6s",
      subjectId: uuid("g_staff"),
      subjectRelation: "member",
    });
    await tsfga.addTuple({
      objectType: "tenant_a6s",
      objectId: uuid("t_susp"),
      relation: "suspended",
      subjectType: "user_a6s",
      subjectId: "*",
      conditionName: "past_grace_a6s",
    });

    for (const [workspace, tenant, active] of [
      ["w_main", "t_acme", true],
      ["w_lapsed", "t_lapsed", false],
      ["w_hold", "t_acme", true],
      ["w_susp", "t_susp", true],
    ] as Array<[string, string, boolean]>) {
      await tsfga.addTuple({
        objectType: "workspace_a6s",
        objectId: uuid(workspace),
        relation: "tenant",
        subjectType: "tenant_a6s",
        subjectId: uuid(tenant),
        conditionName: "subscription_active_a6s",
        conditionContext: { subscription_active: active },
      });
    }
    await tsfga.addTuple({
      objectType: "workspace_a6s",
      objectId: uuid("w_main"),
      relation: "direct_member",
      subjectType: "user_a6s",
      subjectId: uuid("dave"),
    });
    await tsfga.addTuple({
      objectType: "workspace_a6s",
      objectId: uuid("w_lapsed"),
      relation: "direct_member",
      subjectType: "user_a6s",
      subjectId: uuid("erin"),
    });
    await tsfga.addTuple({
      objectType: "workspace_a6s",
      objectId: uuid("w_hold"),
      relation: "legal_hold",
      subjectType: "user_a6s",
      subjectId: "*",
    });

    storeId = await fgaCreateStore("saas");
    authorizationModelId = await fgaWriteModel(storeId, "./saas/model.dsl");
    await fgaWriteTuples(
      storeId,
      "./saas/tuples.yaml",
      authorizationModelId,
      uuidMap,
    );
  });

  afterAll(async () => {
    await rollbackTransaction(db);
    await destroyDb();
  });

  // --- A conditioned and an unconditioned userset on one relation ---

  test("1: staff subscribe unconditionally", async () => {
    await onTenant("t_acme", "subscriber", "bob", true, NOW_OK);
  });

  test("2: a contractor subscribes inside the window", async () => {
    await onTenant("t_acme", "subscriber", "carol", true, NOW_OK);
  });

  test("3: and stops when the window closes", async () => {
    await onTenant("t_acme", "subscriber", "carol", false, NOW_EXPIRED);
  });

  test("4: the window does not affect staff", async () => {
    await onTenant("t_acme", "subscriber", "bob", true, NOW_EXPIRED);
  });

  test("5: an unlisted user subscribes to nothing", async () => {
    await onTenant("t_acme", "subscriber", "frank", false, NOW_OK);
  });

  test("6: a request binding no `now` still answers, the sibling row held", async () => {
    await onTenant("t_acme", "subscriber", "bob", true);
  });

  test("7: and answers false for a user no row reaches", async () => {
    await onTenant("t_acme", "subscriber", "frank", false);
  });

  // --- Suspension: a conditioned wildcard subtracting a userset ---

  test("8: inside the grace period the subscription still counts", async () => {
    await onTenant("t_susp", "active_member", "bob", true, IN_GRACE);
  });

  test("9: past it the tenant suspends everyone", async () => {
    await onTenant("t_susp", "active_member", "bob", false, PAST_GRACE);
  });

  test("10: suspension does not remove the subscription itself", async () => {
    await onTenant("t_susp", "subscriber", "bob", true, PAST_GRACE);
  });

  test("11: the suspension wildcard covers a non-subscriber too", async () => {
    await onTenant("t_susp", "suspended", "frank", true, PAST_GRACE);
  });

  test("12: which still grants him nothing", async () => {
    await onTenant("t_susp", "active_member", "frank", false, IN_GRACE);
  });

  // --- The condition-gated tenant link ---

  test("13: an active subscription carries the tenant grant into the workspace", async () => {
    await onWorkspace("w_main", "member", "bob", true, NOW_OK);
  });

  test("14: a contractor reaches it too, inside her window", async () => {
    await onWorkspace("w_main", "member", "carol", true, NOW_OK);
  });

  test("15: and loses it when the window closes", async () => {
    await onWorkspace("w_main", "member", "carol", false, NOW_EXPIRED);
  });

  test("16: the lapsed tenant still grants every subscriber", async () => {
    await onTenant("t_lapsed", "active_member", "frank", true, NOW_OK);
  });

  test("17: but the lapsed link carries none of it into the workspace", async () => {
    await onWorkspace("w_lapsed", "member", "frank", false, NOW_OK);
  });

  test("18: a direct member is untouched by the lapse", async () => {
    await onWorkspace("w_lapsed", "member", "erin", true, NOW_OK);
  });

  test("19: the lapse also cuts the admin edge", async () => {
    await onWorkspace("w_lapsed", "admin", "alice", false, NOW_OK);
  });

  test("20: while the active link carries it", async () => {
    await onWorkspace("w_main", "admin", "alice", true, NOW_OK);
  });

  test("21: a direct workspace member needs no tenant at all", async () => {
    await onWorkspace("w_main", "member", "dave", true, NOW_OK);
  });

  test("22: and an outsider gets nothing", async () => {
    await onWorkspace("w_main", "member", "frank", false, NOW_OK);
  });

  // --- Suspension reaching through the link ---

  test("23: the suspended tenant's workspace still admits bob in grace", async () => {
    await onWorkspace("w_susp", "member", "bob", true, IN_GRACE);
  });

  test("24: and shuts him out past it", async () => {
    await onWorkspace("w_susp", "member", "bob", false, PAST_GRACE);
  });

  test("25: writing follows membership there", async () => {
    await onWorkspace("w_susp", "can_write", "bob", true, IN_GRACE);
  });

  test("26: and stops with it", async () => {
    await onWorkspace("w_susp", "can_write", "bob", false, PAST_GRACE);
  });

  // --- Double negation: legal hold freezes members, not admins ---

  test("27: the hold does not remove membership", async () => {
    await onWorkspace("w_hold", "member", "bob", true, NOW_OK);
  });

  test("28: nor reading", async () => {
    await onWorkspace("w_hold", "can_read", "bob", true, NOW_OK);
  });

  test("29: bob is frozen by it", async () => {
    await onWorkspace("w_hold", "frozen", "bob", true, NOW_OK);
  });

  test("30: alice is not — the inner exclusion spares admins", async () => {
    await onWorkspace("w_hold", "frozen", "alice", false, NOW_OK);
  });

  test("31: so bob cannot write", async () => {
    await onWorkspace("w_hold", "can_write", "bob", false, NOW_OK);
  });

  test("32: and alice can, through the double negation", async () => {
    await onWorkspace("w_hold", "can_write", "alice", true, NOW_OK);
  });

  test("33: alice can purge the held workspace", async () => {
    await onWorkspace("w_hold", "can_purge", "alice", true, NOW_OK);
  });

  test("34: bob cannot", async () => {
    await onWorkspace("w_hold", "can_purge", "bob", false, NOW_OK);
  });

  test("35: a frozen non-member is still not a writer", async () => {
    await onWorkspace("w_hold", "can_write", "frank", false, NOW_OK);
  });

  test("36: nothing is frozen where there is no hold", async () => {
    await onWorkspace("w_main", "frozen", "bob", false, NOW_OK);
  });

  test("37: so bob writes in w_main", async () => {
    await onWorkspace("w_main", "can_write", "bob", true, NOW_OK);
  });

  test("38: dave is a member but no admin, so he cannot purge", async () => {
    await onWorkspace("w_main", "can_purge", "dave", false, NOW_OK);
  });

  test("38b: alice administers no workspace of the suspended tenant", async () => {
    await onWorkspace("w_susp", "admin", "alice", false, IN_GRACE);
  });

  // --- listObjects over the whole thing ---

  test("39: what bob may write, in grace and inside the window", async () => {
    await expectListObjectsConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "workspace_a6s",
        relation: "can_write",
        subjectType: "user_a6s",
        subjectId: uuid("bob"),
        context: { ...NOW_OK, ...IN_GRACE },
      },
      [uuid("w_main"), uuid("w_susp")],
    );
  });

  test("40: what bob may write once the grace period lapses", async () => {
    await expectListObjectsConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "workspace_a6s",
        relation: "can_write",
        subjectType: "user_a6s",
        subjectId: uuid("bob"),
        context: { ...NOW_OK, ...PAST_GRACE },
      },
      [uuid("w_main")],
    );
  });

  test("41: what carol may read after her window closes", async () => {
    await expectListObjectsConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "workspace_a6s",
        relation: "can_read",
        subjectType: "user_a6s",
        subjectId: uuid("carol"),
        context: { ...NOW_EXPIRED, ...IN_GRACE },
      },
      [],
    );
  });

  test("42: what alice may purge", async () => {
    await expectListObjectsConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "workspace_a6s",
        relation: "can_purge",
        subjectType: "user_a6s",
        subjectId: uuid("alice"),
        context: { ...NOW_OK, ...IN_GRACE },
      },
      // Not w_susp: that tenant has no admin tuple, so the admin
      // edge carries nothing even though its link is live.
      [uuid("w_main"), uuid("w_hold")],
    );
  });

  test("the relation configs say what the model says", () => {
    expectConfigsMatchModel("./saas/model.dsl", fixture, {
      coverage: "complete",
    });
  });
});
