import { afterAll, beforeAll, describe, test } from "bun:test";
import { createTsfga, type TsfgaClient } from "@tsfga/core";
import type { DB } from "@tsfga/kysely";
import { KyselyTupleStore } from "@tsfga/kysely";
import type { Kysely } from "kysely";
import {
  type CheckOutcome,
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
 * An AWS IAM-shaped model: account -> policy -> principal, with
 * explicit deny beating every allow.
 *
 * `can_access` is `explicit_allow but not explicit_deny`, and both
 * sides are unions of two tuple-to-usersets — so a decision needs
 * four independent policy evaluations, two of them two dispatches
 * deep (`resource -> account -> policy -> group#member -> group#member`).
 *
 * The service control policy is the sharp part: a *conditioned
 * wildcard* (`user_a6i:* with outside_vpc_a6i`) sitting on the
 * subtract side of the exclusion. A request from inside the VPC
 * leaves the condition false and the deny silent; a request from
 * outside denies everyone, the account root user included. A request
 * that binds no `source_vpc` at all leaves a declared parameter
 * unbound *inside a subtrahend*, which is where a fail-open would
 * hurt most.
 */

const uuidMap = new Map<string, string>([
  ["alice", "00000000-0000-4000-d450-000000050001"],
  ["bob", "00000000-0000-4000-d450-000000050002"],
  ["carol", "00000000-0000-4000-d450-000000050003"],
  ["dave", "00000000-0000-4000-d450-000000050004"],
  ["erin", "00000000-0000-4000-d450-000000050005"],
  ["frank", "00000000-0000-4000-d450-000000050006"],
  ["devs", "00000000-0000-4000-d450-000000050010"],
  ["leads", "00000000-0000-4000-d450-000000050011"],
  ["p_read", "00000000-0000-4000-d450-000000050020"],
  ["p_admin", "00000000-0000-4000-d450-000000050021"],
  ["p_deny_ext", "00000000-0000-4000-d450-000000050022"],
  ["p_scp_vpc", "00000000-0000-4000-d450-000000050023"],
  ["prod", "00000000-0000-4000-d450-000000050030"],
  ["dev", "00000000-0000-4000-d450-000000050031"],
  ["bucket", "00000000-0000-4000-d450-000000050040"],
  ["queue", "00000000-0000-4000-d450-000000050041"],
  ["table", "00000000-0000-4000-d450-000000050042"],
]);

function uuid(name: string): string {
  const id = uuidMap.get(name);
  if (!id) throw new Error(`No UUID for ${name}`);
  return id;
}

/** Inside the corporate VPC: the SCP deny stays silent. */
const INSIDE = { source_vpc: "vpc-acme" };
/** Outside it: the SCP deny covers every principal. */
const OUTSIDE = { source_vpc: "vpc-public" };

describe("AWS IAM Model Conformance", () => {
  let db: Kysely<DB>;
  let storeId: string;
  let authorizationModelId: string;
  let tsfga: TsfgaClient;
  let fixture: FixtureRecord;

  function can(
    object: string,
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
        objectType: "resource_a6i",
        objectId: uuid(object),
        relation,
        subjectType: "user_a6i",
        subjectId: uuid(subject),
        ...(context ? { context } : {}),
      },
      expected,
    );
  }

  beforeAll(async () => {
    db = getDb();
    await beginTransaction(db);

    tsfga = createTsfga(new KyselyTupleStore(db));
    fixture = recordFixture(tsfga);

    await tsfga.writeConditionDefinition({
      name: "outside_vpc_a6i",
      expression: 'source_vpc != "vpc-acme"',
      parameters: { source_vpc: "string" },
    });

    // === group_a6i ===
    await tsfga.writeRelationConfig({
      objectType: "group_a6i",
      relation: "member",
      directlyAssignable: [
        { type: "user_a6i" },
        { type: "group_a6i", relation: "member" },
      ],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });

    // === policy_a6i ===
    await tsfga.writeRelationConfig({
      objectType: "policy_a6i",
      relation: "allowed_principal",
      directlyAssignable: [
        { type: "user_a6i" },
        { type: "group_a6i", relation: "member" },
        { type: "user_a6i", wildcard: true },
      ],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });
    await tsfga.writeRelationConfig({
      objectType: "policy_a6i",
      relation: "denied_principal",
      directlyAssignable: [
        { type: "user_a6i" },
        { type: "group_a6i", relation: "member" },
        { type: "user_a6i", wildcard: true, condition: "outside_vpc_a6i" },
      ],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });

    // === account_a6i ===
    await tsfga.writeRelationConfig({
      objectType: "account_a6i",
      relation: "root_user",
      directlyAssignable: [{ type: "user_a6i" }],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });
    for (const relation of ["attached_policy", "scp"]) {
      await tsfga.writeRelationConfig({
        objectType: "account_a6i",
        relation,
        directlyAssignable: [{ type: "policy_a6i" }],
        impliedBy: null,
        computedUserset: null,
        tupleToUserset: null,
        excludedBy: null,
        intersection: null,
      });
    }
    await tsfga.writeRelationConfig({
      objectType: "account_a6i",
      relation: "allow",
      directlyAssignable: [],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: [
        { tupleset: "attached_policy", computedUserset: "allowed_principal" },
      ],
      excludedBy: null,
      intersection: null,
    });
    await tsfga.writeRelationConfig({
      objectType: "account_a6i",
      relation: "deny",
      directlyAssignable: [],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: [
        { tupleset: "scp", computedUserset: "denied_principal" },
      ],
      excludedBy: null,
      intersection: null,
    });

    // === resource_a6i ===
    await tsfga.writeRelationConfig({
      objectType: "resource_a6i",
      relation: "account",
      directlyAssignable: [{ type: "account_a6i" }],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });
    await tsfga.writeRelationConfig({
      objectType: "resource_a6i",
      relation: "resource_policy",
      directlyAssignable: [{ type: "policy_a6i" }],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });
    await tsfga.writeRelationConfig({
      objectType: "resource_a6i",
      relation: "explicit_allow",
      directlyAssignable: [],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: [
        { tupleset: "resource_policy", computedUserset: "allowed_principal" },
        { tupleset: "account", computedUserset: "allow" },
      ],
      excludedBy: null,
      intersection: null,
    });
    await tsfga.writeRelationConfig({
      objectType: "resource_a6i",
      relation: "explicit_deny",
      directlyAssignable: [],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: [
        { tupleset: "resource_policy", computedUserset: "denied_principal" },
        { tupleset: "account", computedUserset: "deny" },
      ],
      excludedBy: null,
      intersection: null,
    });
    await tsfga.writeRelationConfig({
      objectType: "resource_a6i",
      relation: "can_access",
      directlyAssignable: [],
      impliedBy: null,
      computedUserset: "explicit_allow",
      tupleToUserset: null,
      excludedBy: "explicit_deny",
      intersection: null,
    });
    await tsfga.writeRelationConfig({
      objectType: "resource_a6i",
      relation: "can_administer",
      directlyAssignable: [],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: [{ tupleset: "account", computedUserset: "root_user" }],
      excludedBy: "explicit_deny",
      intersection: null,
    });

    // === Tuples ===
    const user = (
      objectType: string,
      object: string,
      relation: string,
      subject: string,
    ) =>
      tsfga.addTuple({
        objectType,
        objectId: uuid(object),
        relation,
        subjectType: "user_a6i",
        subjectId: uuid(subject),
      });

    await user("group_a6i", "devs", "member", "bob");
    await tsfga.addTuple({
      objectType: "group_a6i",
      objectId: uuid("devs"),
      relation: "member",
      subjectType: "group_a6i",
      subjectId: uuid("leads"),
      subjectRelation: "member",
    });
    await user("group_a6i", "leads", "member", "carol");
    await user("group_a6i", "leads", "member", "dave");

    await tsfga.addTuple({
      objectType: "policy_a6i",
      objectId: uuid("p_read"),
      relation: "allowed_principal",
      subjectType: "user_a6i",
      subjectId: "*",
    });
    await tsfga.addTuple({
      objectType: "policy_a6i",
      objectId: uuid("p_admin"),
      relation: "allowed_principal",
      subjectType: "group_a6i",
      subjectId: uuid("devs"),
      subjectRelation: "member",
    });
    await user("policy_a6i", "p_deny_ext", "denied_principal", "carol");
    await tsfga.addTuple({
      objectType: "policy_a6i",
      objectId: uuid("p_scp_vpc"),
      relation: "denied_principal",
      subjectType: "user_a6i",
      subjectId: "*",
      conditionName: "outside_vpc_a6i",
    });

    await user("account_a6i", "prod", "root_user", "alice");
    await tsfga.addTuple({
      objectType: "account_a6i",
      objectId: uuid("prod"),
      relation: "attached_policy",
      subjectType: "policy_a6i",
      subjectId: uuid("p_admin"),
    });
    await tsfga.addTuple({
      objectType: "account_a6i",
      objectId: uuid("prod"),
      relation: "scp",
      subjectType: "policy_a6i",
      subjectId: uuid("p_scp_vpc"),
    });
    await user("account_a6i", "dev", "root_user", "erin");
    await tsfga.addTuple({
      objectType: "account_a6i",
      objectId: uuid("dev"),
      relation: "attached_policy",
      subjectType: "policy_a6i",
      subjectId: uuid("p_read"),
    });

    for (const [resource, account] of [
      ["bucket", "prod"],
      ["queue", "prod"],
      ["table", "dev"],
    ] as Array<[string, string]>) {
      await tsfga.addTuple({
        objectType: "resource_a6i",
        objectId: uuid(resource),
        relation: "account",
        subjectType: "account_a6i",
        subjectId: uuid(account),
      });
    }
    await tsfga.addTuple({
      objectType: "resource_a6i",
      objectId: uuid("bucket"),
      relation: "resource_policy",
      subjectType: "policy_a6i",
      subjectId: uuid("p_deny_ext"),
    });

    storeId = await fgaCreateStore("iam");
    authorizationModelId = await fgaWriteModel(storeId, "./iam/model.dsl");
    await fgaWriteTuples(
      storeId,
      "./iam/tuples.yaml",
      authorizationModelId,
      uuidMap,
    );
  });

  afterAll(async () => {
    await rollbackTransaction(db);
    await destroyDb();
  });

  // --- Nested group membership feeding the policy ---

  test("1: carol is a devs member through group_a6i:leads#member", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "group_a6i",
        objectId: uuid("devs"),
        relation: "member",
        subjectType: "user_a6i",
        subjectId: uuid("carol"),
      },
      true,
    );
  });

  test("2: erin is in no group", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "group_a6i",
        objectId: uuid("devs"),
        relation: "member",
        subjectType: "user_a6i",
        subjectId: uuid("erin"),
      },
      false,
    );
  });

  test("3: the account allow reaches carol through the nested group", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "account_a6i",
        objectId: uuid("prod"),
        relation: "allow",
        subjectType: "user_a6i",
        subjectId: uuid("carol"),
      },
      true,
    );
  });

  // --- Allow, with the SCP silent (request inside the VPC) ---

  test("4: bob accesses the bucket from inside the VPC", async () => {
    await can("bucket", "can_access", "bob", true, INSIDE);
  });

  test("5: dave accesses the bucket through the nested group", async () => {
    await can("bucket", "can_access", "dave", true, INSIDE);
  });

  test("6: erin has no allow on the bucket", async () => {
    await can("bucket", "can_access", "erin", false, INSIDE);
  });

  test("7: frank has no allow on the bucket", async () => {
    await can("bucket", "can_access", "frank", false, INSIDE);
  });

  // --- Resource-policy deny beats the account allow ---

  test("8: carol is allowed on the bucket", async () => {
    await can("bucket", "explicit_allow", "carol", true, INSIDE);
  });

  test("9: and denied on it by the resource policy", async () => {
    await can("bucket", "explicit_deny", "carol", true, INSIDE);
  });

  test("10: so the deny wins and she cannot access it", async () => {
    await can("bucket", "can_access", "carol", false, INSIDE);
  });

  test("11: the same deny does not follow her to the queue", async () => {
    await can("queue", "can_access", "carol", true, INSIDE);
  });

  // --- The conditioned SCP wildcard on the subtract side ---

  test("12: from outside the VPC the SCP denies bob", async () => {
    await can("bucket", "can_access", "bob", false, OUTSIDE);
  });

  test("13: it denies him on the queue too", async () => {
    await can("queue", "can_access", "bob", false, OUTSIDE);
  });

  test("14: the SCP fires as an explicit_deny in its own right", async () => {
    await can("queue", "explicit_deny", "bob", true, OUTSIDE);
  });

  test("15: and stays silent inside the VPC", async () => {
    await can("queue", "explicit_deny", "bob", false, INSIDE);
  });

  test("16: the deny does not manufacture an allow for erin", async () => {
    await can("queue", "can_access", "erin", false, OUTSIDE);
  });

  test("17: the dev account has no SCP, so location is irrelevant", async () => {
    await can("table", "can_access", "frank", true, OUTSIDE);
  });

  test("18: the dev account's wildcard allow admits anyone", async () => {
    await can("table", "can_access", "erin", true, INSIDE);
  });

  // --- Explicit deny beating the account root ---

  test("19: alice administers the bucket from inside the VPC", async () => {
    await can("bucket", "can_administer", "alice", true, INSIDE);
  });

  test("20: the SCP denies even the root user from outside", async () => {
    await can("bucket", "can_administer", "alice", false, OUTSIDE);
  });

  test("21: erin is root of dev, not of prod", async () => {
    await can("bucket", "can_administer", "erin", false, INSIDE);
  });

  test("22: erin administers the table she is root of", async () => {
    await can("table", "can_administer", "erin", true, OUTSIDE);
  });

  test("23: bob is nobody's root user", async () => {
    await can("queue", "can_administer", "bob", false, INSIDE);
  });

  test("24: alice has no allow of her own — root is not a principal", async () => {
    await can("queue", "can_access", "alice", false, INSIDE);
  });

  // --- An unbound parameter inside the subtrahend ---

  test("25: a request binding no source_vpc is refused by both engines", async () => {
    await can("queue", "can_access", "bob", "refused");
  });

  test("26: the same refusal reaches the administer path", async () => {
    await can("queue", "can_administer", "alice", "refused");
  });

  test("27: a resource whose account has no SCP still answers", async () => {
    await can("table", "can_access", "frank", true);
  });

  // --- listObjects across allow and deny ---

  test("28: what bob reaches from inside the VPC", async () => {
    await expectListObjectsConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "resource_a6i",
        relation: "can_access",
        subjectType: "user_a6i",
        subjectId: uuid("bob"),
        context: INSIDE,
      },
      [uuid("bucket"), uuid("queue"), uuid("table")],
    );
  });

  test("29: what bob reaches from outside it", async () => {
    await expectListObjectsConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "resource_a6i",
        relation: "can_access",
        subjectType: "user_a6i",
        subjectId: uuid("bob"),
        context: OUTSIDE,
      },
      [uuid("table")],
    );
  });

  test("30: what carol reaches from inside the VPC", async () => {
    await expectListObjectsConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "resource_a6i",
        relation: "can_access",
        subjectType: "user_a6i",
        subjectId: uuid("carol"),
        context: INSIDE,
      },
      [uuid("queue"), uuid("table")],
    );
  });

  test("the relation configs say what the model says", () => {
    expectConfigsMatchModel("./iam/model.dsl", fixture, {
      coverage: "complete",
    });
  });
});
