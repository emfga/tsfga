import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  type ConditionDefinition,
  createTsfga,
  type TsfgaClient,
  TsfgaError,
} from "@tsfga/core";
import type { DB } from "@tsfga/kysely";
import { KyselyTupleStore } from "@tsfga/kysely";
import type { Kysely } from "kysely";
import {
  type CheckOutcome,
  expectConfigsMatchModel,
  expectConformance,
  expectListObjectsConformance,
  expectPinnedListObjectsDivergence,
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
  fgaListObjects,
  fgaWriteModel,
  fgaWriteTuples,
} from "./helpers/openfga.ts";
import {
  assertUuidMapCovers,
  assertUuidMapInjective,
} from "./helpers/uuid-map.ts";

/**
 * A Terraform-Cloud/Vault-shaped model where the conditions carry
 * the policy rather than decorating it: a source-IP allow-list, a
 * change window, an environment tag matched case-insensitively, a
 * spend ceiling, and a secret-path allow-list.
 *
 * Four seams are the point of this fixture.
 *
 * **A case-insensitive tag without a regular expression.**
 * `env_tagged_c3v` used to be a `matches()` call carrying the
 * inline flag group `(?i)`. `matches()` is not supported at all
 * now — it is absent from the declaration allow-list, so a
 * condition naming it is refused at write — and the condition is
 * a list membership over the spellings it accepts. That is the
 * shape a model has to take here, and this fixture is the
 * ordinary-model demonstration of it.
 *
 * **Tuple context beats request context.** `erin`'s `reader` row
 * pins `ip` in the tuple, so a request naming a different IP
 * changes nothing; `dan`'s row leaves it open, so the request
 * decides.
 *
 * **A missing parameter is a refusal, not a `false`.** Both
 * engines decline the whole check rather than reading an absent
 * `ip` as "not allowed" — the fail-open reading is the dangerous
 * one, and it is the one a naive implementation picks.
 *
 * **A condition sits under an intersection and under an
 * exclusion.** `run_c3v.can_apply` is `approver and can_apply from
 * workspace`, so a spend ceiling has to hold *and* survive a
 * workspace lock evaluated one dispatch away.
 */

const CONDITIONS: ConditionDefinition[] = [
  {
    name: "ip_allowed_c3v",
    expression: 'ip in ["10.0.4.7", "10.0.9.9"]',
    parameters: { ip: "string" },
  },
  {
    name: "business_hours_c3v",
    expression:
      'now >= timestamp("2026-01-01T09:00:00Z") && ' +
      'now < timestamp("2026-01-01T17:00:00Z")',
    parameters: { now: "timestamp" },
  },
  {
    name: "env_tagged_c3v",
    expression: 'env in ["prod", "PROD", "Prod", "production", "Production"]',
    parameters: { env: "string" },
  },
  {
    name: "under_budget_c3v",
    expression: "cost <= budget",
    parameters: { cost: "double", budget: "double" },
  },
  {
    name: "path_allowed_c3v",
    expression: "path in allowed",
    parameters: { path: "string", allowed: "list<string>" },
  },
];

const IN_HOURS = "2026-01-01T10:00:00Z";
const OUT_OF_HOURS = "2026-01-01T20:00:00Z";

const uuidMap = new Map<string, string>([
  ["alice", "00000000-0000-4000-d576-000000000001"],
  ["acme", "00000000-0000-4000-d576-000000000002"],
  ["bob", "00000000-0000-4000-d576-000000000003"],
  ["carol", "00000000-0000-4000-d576-000000000004"],
  ["platform", "00000000-0000-4000-d576-000000000005"],
  ["dev", "00000000-0000-4000-d576-000000000006"],
  ["dan", "00000000-0000-4000-d576-000000000007"],
  ["erin", "00000000-0000-4000-d576-000000000008"],
  ["prod", "00000000-0000-4000-d576-000000000009"],
  ["staging", "00000000-0000-4000-d576-000000000010"],
  ["run1", "00000000-0000-4000-d576-000000000011"],
  ["run2", "00000000-0000-4000-d576-000000000012"],
  ["db-creds", "00000000-0000-4000-d576-000000000013"],
  ["frank", "00000000-0000-4000-d576-000000000014"],
]);

function uuid(name: string): string {
  const id = uuidMap.get(name);
  if (!id) throw new Error(`No UUID for ${name}`);
  return id;
}

describe("Vault Model Conformance", () => {
  let db: Kysely<DB>;
  let storeId: string;
  let authorizationModelId: string;
  let tsfga: TsfgaClient;
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
        subjectType: "user_c3v",
        subjectId: uuid(subject),
        ...(context ? { context } : {}),
      },
      expected,
    );
  }

  beforeAll(async () => {
    assertUuidMapInjective(uuidMap);
    assertUuidMapCovers("./vault/tuples.yaml", uuidMap);

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

    // === org_c3v ===
    await tsfga.writeRelationConfig({
      objectType: "org_c3v",
      relation: "owner",
      directlyAssignable: [{ type: "user_c3v" }],
      ...plain,
    });
    await tsfga.writeRelationConfig({
      objectType: "org_c3v",
      relation: "member",
      directlyAssignable: [{ type: "user_c3v" }],
      ...plain,
      impliedBy: ["owner"],
    });

    // === team_c3v ===
    await tsfga.writeRelationConfig({
      objectType: "team_c3v",
      relation: "org",
      directlyAssignable: [{ type: "org_c3v" }],
      ...plain,
    });
    await tsfga.writeRelationConfig({
      objectType: "team_c3v",
      relation: "member",
      directlyAssignable: [
        { type: "user_c3v" },
        { type: "team_c3v", relation: "member" },
      ],
      ...plain,
    });
    await tsfga.writeRelationConfig({
      objectType: "team_c3v",
      relation: "maintainer",
      directlyAssignable: [{ type: "user_c3v" }],
      ...plain,
    });

    // === workspace_c3v ===
    await tsfga.writeRelationConfig({
      objectType: "workspace_c3v",
      relation: "org",
      directlyAssignable: [{ type: "org_c3v" }],
      ...plain,
    });
    await tsfga.writeRelationConfig({
      objectType: "workspace_c3v",
      relation: "locked",
      directlyAssignable: [{ type: "user_c3v", wildcard: true }],
      ...plain,
    });
    await tsfga.writeRelationConfig({
      objectType: "workspace_c3v",
      relation: "reader",
      directlyAssignable: [
        { type: "team_c3v", relation: "member" },
        { type: "user_c3v", condition: "ip_allowed_c3v" },
      ],
      ...plain,
    });
    await tsfga.writeRelationConfig({
      objectType: "workspace_c3v",
      relation: "writer",
      directlyAssignable: [
        { type: "user_c3v" },
        {
          type: "team_c3v",
          relation: "member",
          condition: "business_hours_c3v",
        },
      ],
      ...plain,
    });
    await tsfga.writeRelationConfig({
      objectType: "workspace_c3v",
      relation: "admin",
      directlyAssignable: [
        { type: "user_c3v" },
        { type: "team_c3v", relation: "maintainer" },
      ],
      ...plain,
    });
    await tsfga.writeRelationConfig({
      objectType: "workspace_c3v",
      relation: "deployer",
      directlyAssignable: [{ type: "user_c3v", condition: "env_tagged_c3v" }],
      ...plain,
    });
    await tsfga.writeRelationConfig({
      objectType: "workspace_c3v",
      relation: "can_read",
      directlyAssignable: [],
      ...plain,
      impliedBy: ["reader", "writer", "admin"],
      tupleToUserset: [{ tupleset: "org", computedUserset: "owner" }],
    });
    await tsfga.writeRelationConfig({
      objectType: "workspace_c3v",
      relation: "can_queue_plan",
      directlyAssignable: [],
      ...plain,
      impliedBy: ["writer", "admin"],
    });
    await tsfga.writeRelationConfig({
      objectType: "workspace_c3v",
      relation: "can_apply",
      directlyAssignable: [],
      ...plain,
      computedUserset: "can_queue_plan",
      excludedBy: "locked",
    });

    // === run_c3v ===
    await tsfga.writeRelationConfig({
      objectType: "run_c3v",
      relation: "workspace",
      directlyAssignable: [{ type: "workspace_c3v" }],
      ...plain,
    });
    await tsfga.writeRelationConfig({
      objectType: "run_c3v",
      relation: "requester",
      directlyAssignable: [{ type: "user_c3v" }],
      ...plain,
    });
    await tsfga.writeRelationConfig({
      objectType: "run_c3v",
      relation: "approver",
      directlyAssignable: [{ type: "user_c3v", condition: "under_budget_c3v" }],
      ...plain,
    });
    await tsfga.writeRelationConfig({
      objectType: "run_c3v",
      relation: "can_apply",
      directlyAssignable: [],
      ...plain,
      intersection: [
        { type: "computedUserset", relation: "approver" },
        {
          type: "tupleToUserset",
          tupleset: "workspace",
          computedUserset: "can_apply",
        },
      ],
    });

    // === secret_c3v ===
    await tsfga.writeRelationConfig({
      objectType: "secret_c3v",
      relation: "workspace",
      directlyAssignable: [{ type: "workspace_c3v" }],
      ...plain,
    });
    await tsfga.writeRelationConfig({
      objectType: "secret_c3v",
      relation: "path_reader",
      directlyAssignable: [{ type: "user_c3v", condition: "path_allowed_c3v" }],
      ...plain,
    });
    await tsfga.writeRelationConfig({
      objectType: "secret_c3v",
      relation: "can_read",
      directlyAssignable: [],
      ...plain,
      impliedBy: ["path_reader"],
      tupleToUserset: [{ tupleset: "workspace", computedUserset: "admin" }],
    });

    // === Tuples (mirroring ./vault/tuples.yaml) ===
    await tsfga.addTuple({
      objectType: "org_c3v",
      objectId: uuid("acme"),
      relation: "owner",
      subjectType: "user_c3v",
      subjectId: uuid("alice"),
    });
    for (const user of ["bob", "carol"]) {
      await tsfga.addTuple({
        objectType: "org_c3v",
        objectId: uuid("acme"),
        relation: "member",
        subjectType: "user_c3v",
        subjectId: uuid(user),
      });
    }

    await tsfga.addTuple({
      objectType: "team_c3v",
      objectId: uuid("platform"),
      relation: "org",
      subjectType: "org_c3v",
      subjectId: uuid("acme"),
    });
    for (const user of ["bob", "carol"]) {
      await tsfga.addTuple({
        objectType: "team_c3v",
        objectId: uuid("platform"),
        relation: "member",
        subjectType: "user_c3v",
        subjectId: uuid(user),
      });
    }
    await tsfga.addTuple({
      objectType: "team_c3v",
      objectId: uuid("platform"),
      relation: "maintainer",
      subjectType: "user_c3v",
      subjectId: uuid("bob"),
    });

    for (const workspace of ["dev", "prod", "staging"]) {
      await tsfga.addTuple({
        objectType: "workspace_c3v",
        objectId: uuid(workspace),
        relation: "org",
        subjectType: "org_c3v",
        subjectId: uuid("acme"),
      });
    }
    await tsfga.addTuple({
      objectType: "workspace_c3v",
      objectId: uuid("dev"),
      relation: "reader",
      subjectType: "team_c3v",
      subjectId: uuid("platform"),
      subjectRelation: "member",
    });
    await tsfga.addTuple({
      objectType: "workspace_c3v",
      objectId: uuid("dev"),
      relation: "reader",
      subjectType: "user_c3v",
      subjectId: uuid("dan"),
      conditionName: "ip_allowed_c3v",
    });
    await tsfga.addTuple({
      objectType: "workspace_c3v",
      objectId: uuid("dev"),
      relation: "reader",
      subjectType: "user_c3v",
      subjectId: uuid("erin"),
      conditionName: "ip_allowed_c3v",
      conditionContext: { ip: "10.0.4.7" },
    });

    await tsfga.addTuple({
      objectType: "workspace_c3v",
      objectId: uuid("prod"),
      relation: "writer",
      subjectType: "team_c3v",
      subjectId: uuid("platform"),
      subjectRelation: "member",
      conditionName: "business_hours_c3v",
    });
    await tsfga.addTuple({
      objectType: "workspace_c3v",
      objectId: uuid("prod"),
      relation: "admin",
      subjectType: "team_c3v",
      subjectId: uuid("platform"),
      subjectRelation: "maintainer",
    });
    await tsfga.addTuple({
      objectType: "workspace_c3v",
      objectId: uuid("prod"),
      relation: "deployer",
      subjectType: "user_c3v",
      subjectId: uuid("carol"),
      conditionName: "env_tagged_c3v",
    });

    await tsfga.addTuple({
      objectType: "workspace_c3v",
      objectId: uuid("staging"),
      relation: "writer",
      subjectType: "user_c3v",
      subjectId: uuid("carol"),
    });
    await tsfga.addTuple({
      objectType: "workspace_c3v",
      objectId: uuid("staging"),
      relation: "locked",
      subjectType: "user_c3v",
      subjectId: "*",
    });

    await tsfga.addTuple({
      objectType: "run_c3v",
      objectId: uuid("run1"),
      relation: "workspace",
      subjectType: "workspace_c3v",
      subjectId: uuid("prod"),
    });
    await tsfga.addTuple({
      objectType: "run_c3v",
      objectId: uuid("run1"),
      relation: "requester",
      subjectType: "user_c3v",
      subjectId: uuid("carol"),
    });
    await tsfga.addTuple({
      objectType: "run_c3v",
      objectId: uuid("run1"),
      relation: "approver",
      subjectType: "user_c3v",
      subjectId: uuid("bob"),
      conditionName: "under_budget_c3v",
      conditionContext: { budget: 100 },
    });
    await tsfga.addTuple({
      objectType: "run_c3v",
      objectId: uuid("run2"),
      relation: "workspace",
      subjectType: "workspace_c3v",
      subjectId: uuid("staging"),
    });
    await tsfga.addTuple({
      objectType: "run_c3v",
      objectId: uuid("run2"),
      relation: "approver",
      subjectType: "user_c3v",
      subjectId: uuid("carol"),
      conditionName: "under_budget_c3v",
      conditionContext: { budget: 100 },
    });

    await tsfga.addTuple({
      objectType: "secret_c3v",
      objectId: uuid("db-creds"),
      relation: "workspace",
      subjectType: "workspace_c3v",
      subjectId: uuid("prod"),
    });
    await tsfga.addTuple({
      objectType: "secret_c3v",
      objectId: uuid("db-creds"),
      relation: "path_reader",
      subjectType: "user_c3v",
      subjectId: uuid("carol"),
      conditionName: "path_allowed_c3v",
      conditionContext: { allowed: ["secret/db", "secret/cache"] },
    });

    storeId = await fgaCreateStore("vault");
    authorizationModelId = await fgaWriteModel(storeId, "./vault/model.dsl");
    await fgaWriteTuples(
      storeId,
      "./vault/tuples.yaml",
      authorizationModelId,
      uuidMap,
    );
  });

  afterAll(async () => {
    await rollbackTransaction(db);
    await destroyDb();
  });

  // --- The IP allow-list, matched with RE2 ---

  test("1: dan reads dev from an allowed address", async () => {
    await can("workspace_c3v", "dev", "reader", "dan", true, {
      ip: "10.0.4.7",
    });
  });

  test("2: and not from anywhere else", async () => {
    await can("workspace_c3v", "dev", "reader", "dan", false, {
      ip: "192.168.1.1",
    });
  });

  test("3: an address that merely starts the same is not on it", async () => {
    await can("workspace_c3v", "dev", "reader", "dan", false, {
      ip: "110.0.4.7",
    });
  });

  test("4: nor is a longer address sharing a prefix", async () => {
    await can("workspace_c3v", "dev", "reader", "dan", false, {
      ip: "10.0.4.77777",
    });
    // Added negative: an address inside the same /16 that nobody
    // put on the list. A membership test admits exactly what it
    // enumerates, which is the property this cell holds shut.
    await can("workspace_c3v", "dev", "reader", "dan", false, {
      ip: "10.0.4.8",
    });
  });

  test("5: a missing parameter refuses the whole check", async () => {
    await can("workspace_c3v", "dev", "reader", "dan", "refused");
  });

  test("6: erin's tuple pins the address, so the request is ignored", async () => {
    await can("workspace_c3v", "dev", "reader", "erin", true, {
      ip: "192.168.1.1",
    });
  });

  test("7: erin needs no request context at all", async () => {
    await can("workspace_c3v", "dev", "reader", "erin", true);
  });

  test("8: an unconditioned userset row is unaffected by any of it", async () => {
    await can("workspace_c3v", "dev", "reader", "bob", true);
  });

  // --- The change window ---

  test("9: bob writes prod inside the window", async () => {
    await can("workspace_c3v", "prod", "writer", "bob", true, {
      now: IN_HOURS,
    });
  });

  test("10: and not outside it", async () => {
    await can("workspace_c3v", "prod", "writer", "bob", false, {
      now: OUT_OF_HOURS,
    });
  });

  test("11: carol likewise, through the same conditioned userset", async () => {
    await can("workspace_c3v", "prod", "writer", "carol", true, {
      now: IN_HOURS,
    });
    await can("workspace_c3v", "prod", "writer", "carol", false, {
      now: OUT_OF_HOURS,
    });
  });

  test("12: bob still queues a plan out of hours — he is an admin", async () => {
    await can("workspace_c3v", "prod", "can_queue_plan", "bob", true, {
      now: OUT_OF_HOURS,
    });
  });

  test("13: carol does not — the window was her only arm", async () => {
    await can("workspace_c3v", "prod", "can_queue_plan", "carol", false, {
      now: OUT_OF_HOURS,
    });
  });

  test("14: the boundary is closed below and open above", async () => {
    await can("workspace_c3v", "prod", "writer", "carol", true, {
      now: "2026-01-01T09:00:00Z",
    });
    await can("workspace_c3v", "prod", "writer", "carol", false, {
      now: "2026-01-01T17:00:00Z",
    });
  });

  // --- the case-insensitive tag, spelled as a list ---

  test("15: the environment tag matches case-insensitively", async () => {
    await can("workspace_c3v", "prod", "deployer", "carol", true, {
      env: "Production",
    });
  });

  test("16: and in upper case", async () => {
    await can("workspace_c3v", "prod", "deployer", "carol", true, {
      env: "PROD",
    });
  });

  test("17: and in the short lower-case form", async () => {
    await can("workspace_c3v", "prod", "deployer", "carol", true, {
      env: "prod",
    });
  });

  test("18: but `preprod` is not `prod`", async () => {
    await can("workspace_c3v", "prod", "deployer", "carol", false, {
      env: "preprod",
    });
  });

  test("19: nor is `production-eu`", async () => {
    await can("workspace_c3v", "prod", "deployer", "carol", false, {
      env: "production-eu",
    });
  });

  // --- The spend ceiling under an intersection ---

  test("20: bob approves run1 under budget", async () => {
    await can("run_c3v", "run1", "can_apply", "bob", true, { cost: 50 });
  });

  test("21: and not over it", async () => {
    await can("run_c3v", "run1", "can_apply", "bob", false, { cost: 150 });
  });

  test("22: the ceiling is inclusive", async () => {
    await can("run_c3v", "run1", "can_apply", "bob", true, { cost: 100 });
  });

  test("23: the requester is not an approver", async () => {
    await can("run_c3v", "run1", "can_apply", "carol", false, { cost: 10 });
  });

  test("24: a workspace lock beats a satisfied budget", async () => {
    await can("run_c3v", "run2", "approver", "carol", true, { cost: 10 });
    await can("workspace_c3v", "staging", "can_queue_plan", "carol", true);
    await can("workspace_c3v", "staging", "can_apply", "carol", false);
    await can("run_c3v", "run2", "can_apply", "carol", false, { cost: 10 });
  });

  test("25: a missing cost refuses rather than denying", async () => {
    await can("run_c3v", "run1", "can_apply", "bob", "refused");
  });

  // --- The secret path allow-list ---

  test("26: carol reads an allowed path", async () => {
    await can("secret_c3v", "db-creds", "can_read", "carol", true, {
      path: "secret/db",
    });
  });

  test("27: and the second one", async () => {
    await can("secret_c3v", "db-creds", "can_read", "carol", true, {
      path: "secret/cache",
    });
  });

  test("28: and not one outside the list", async () => {
    await can("secret_c3v", "db-creds", "can_read", "carol", false, {
      path: "secret/root",
    });
  });

  test("29: a prefix of an allowed path is not allowed", async () => {
    await can("secret_c3v", "db-creds", "can_read", "carol", false, {
      path: "secret/d",
    });
  });

  test("30: the workspace admin reads it with no path at all", async () => {
    await can("secret_c3v", "db-creds", "can_read", "bob", true);
  });

  test("31: carol without a path is refused, not denied", async () => {
    await can("secret_c3v", "db-creds", "can_read", "carol", "refused");
  });

  // --- The unconditioned arms around them ---

  test("32: the org owner reads every workspace", async () => {
    await can("workspace_c3v", "prod", "can_read", "alice", true);
    await can("workspace_c3v", "staging", "can_read", "alice", true);
  });

  test("33: an org member is not an org owner", async () => {
    await can("org_c3v", "acme", "owner", "bob", false);
    await can("org_c3v", "acme", "member", "alice", true);
  });

  test("34: a stranger reads nothing", async () => {
    await can("workspace_c3v", "dev", "can_read", "frank", false, {
      ip: "10.0.4.7",
    });
  });

  // --- listObjects with the same context ---

  test("35: the workspaces bob reads in hours", async () => {
    await expectListObjectsConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "workspace_c3v",
        relation: "can_read",
        subjectType: "user_c3v",
        subjectId: uuid("bob"),
        context: { now: IN_HOURS },
      },
      [uuid("dev"), uuid("prod")],
    );
  });

  test("36: the workspaces carol reads out of hours", async () => {
    await expectListObjectsConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "workspace_c3v",
        relation: "can_read",
        subjectType: "user_c3v",
        subjectId: uuid("carol"),
        context: { now: OUT_OF_HOURS },
      },
      [uuid("dev"), uuid("staging")],
    );
  });

  test("37: the workspaces dan reads from an allowed address", async () => {
    await expectListObjectsConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "workspace_c3v",
        relation: "can_read",
        subjectType: "user_c3v",
        subjectId: uuid("dan"),
        context: { ip: "10.0.4.7" },
      },
      [uuid("dev")],
    );
  });

  /**
   * What a `listObjects` call did, as one comparable string.
   *
   * `expectListObjectsConformance` cannot express "one engine
   * refused", and the two rows below are exactly that.
   */
  async function listOutcomes(
    subject: string,
    context?: Record<string, unknown>,
  ): Promise<{ tsfga: string; openfga: string }> {
    const params = {
      objectType: "workspace_c3v",
      relation: "can_read",
      subjectType: "user_c3v",
      subjectId: uuid(subject),
      ...(context ? { context } : {}),
    };
    const mine = await tsfga
      .listObjects(params)
      .then((objects) => `answered:${[...objects].sort().join(",")}`)
      .catch((error: unknown) => {
        if (error instanceof TsfgaError) return "refused";
        throw error;
      });
    const theirs = await fgaListObjects(storeId, authorizationModelId, params)
      .then((objects) => `answered:${[...objects].sort().join(",")}`)
      .catch(() => "refused");
    return { tsfga: mine, openfga: theirs };
  }

  test("a row the subject cannot reach still refuses the list", async () => {
    // dan is in no team, so upstream's reverse walk never reaches
    // `workspace_c3v:prod#writer` — the `team_c3v:platform#member
    // with business_hours_c3v` row whose `now` the request omits.
    // It answers the empty set. tsfga runs a check per candidate,
    // reads that row on `prod`, and refuses the whole call.
    const { tsfga: mine, openfga: theirs } = await listOutcomes("dan", {
      ip: "192.168.1.1",
    });
    expect(mine).toBe(theirs);
    expect(mine).toBe("answered:");
  });

  test("and a row it can reach does not refuse it here", async () => {
    // The mirror image of the row above, and the residue of the
    // rule that fixes it. carol *is* in `team_c3v:platform`, so
    // upstream's reverse expansion reaches
    // `workspace_c3v:prod#writer@team_c3v:platform#member with
    // business_hours_c3v`, cannot evaluate it without `now`, and
    // declines the whole call. tsfga meets the same row on a
    // userset scan -- not a read naming the request subject -- so
    // it drops `prod` and answers with the workspaces that
    // resolved.
    //
    // **No local predicate separates carol from dan.** It is the
    // same row, read at the same point, with the same local
    // information: `findCheckTuples` on `prod#writer` issues a
    // direct probe for both and returns nothing for both, and
    // "did this candidate's subtree reach the subject?" cannot be
    // answered without evaluating the condition that just failed.
    // Separating them needs reverse reachability over the stored
    // rows, which tsfga performs at the model level only. So one
    // of the two rows must diverge; the direction chosen is this
    // one, because it under-reports rather than grants -- every
    // object returned here passes a full `check`, and supplying
    // `now` makes both engines agree.
    //
    // The same divergence is pinned from the agreeing side in
    // `list-objects-probes.test.ts`, where nothing else granted
    // and the old rule's "raise if the granted set is empty" hid
    // it. It is one divergence, stated twice.
    await expectPinnedListObjectsDivergence(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "workspace_c3v",
        relation: "can_read",
        subjectType: "user_c3v",
        subjectId: uuid("carol"),
      },
      { openfga: "refused", tsfga: [uuid("dev"), uuid("staging")] },
    );
  });

  test("with `now` supplied, carol's list agrees again", async () => {
    // The boundary beside the pin: the divergence is the missing
    // context, not the shape. With `business_hours_c3v` evaluable
    // there is no error to drop and no error to join, so both
    // engines answer the same set.
    await expectListObjectsConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "workspace_c3v",
        relation: "can_read",
        subjectType: "user_c3v",
        subjectId: uuid("carol"),
        context: { now: IN_HOURS },
      },
      [uuid("dev"), uuid("staging"), uuid("prod")],
    );
  });

  // --- The write gate on the conditioned restrictions ---

  test("39: a reader row must name the condition", async () => {
    await expectWriteConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "workspace_c3v",
        objectId: uuid("prod"),
        relation: "reader",
        subjectType: "user_c3v",
        subjectId: uuid("frank"),
      },
      "refused",
    );
  });

  test("40: naming it is enough", async () => {
    await expectWriteConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "workspace_c3v",
        objectId: uuid("prod"),
        relation: "reader",
        subjectType: "user_c3v",
        subjectId: uuid("frank"),
        conditionName: "ip_allowed_c3v",
      },
      "accepted",
    );
  });

  test("41: naming a different one is not", async () => {
    await expectWriteConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "workspace_c3v",
        objectId: uuid("dev"),
        relation: "reader",
        subjectType: "user_c3v",
        subjectId: uuid("frank"),
        conditionName: "env_tagged_c3v",
      },
      "refused",
    );
  });

  test("42: the userset arm takes no condition", async () => {
    await expectWriteConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "workspace_c3v",
        objectId: uuid("prod"),
        relation: "reader",
        subjectType: "team_c3v",
        subjectId: uuid("platform"),
        subjectRelation: "member",
        conditionName: "ip_allowed_c3v",
      },
      "refused",
    );
  });

  test("43: the writer userset arm requires one", async () => {
    await expectWriteConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "workspace_c3v",
        objectId: uuid("dev"),
        relation: "writer",
        subjectType: "team_c3v",
        subjectId: uuid("platform"),
        subjectRelation: "member",
      },
      "refused",
    );
  });

  test("44: an undefined condition is refused", async () => {
    await expectWriteConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "workspace_c3v",
        objectId: uuid("dev"),
        relation: "reader",
        subjectType: "user_c3v",
        subjectId: uuid("frank"),
        conditionName: "no_such_condition_c3v",
      },
      "refused",
    );
  });

  test("45: the row written in test 40 now answers on context", async () => {
    await can("workspace_c3v", "prod", "reader", "frank", true, {
      ip: "10.0.9.9",
    });
    await can("workspace_c3v", "prod", "reader", "frank", false, {
      ip: "172.16.0.1",
    });
  });

  test("the relation configs say what the model says", () => {
    expectConfigsMatchModel("./vault/model.dsl", fixture, {
      coverage: "complete",
    });
  });
});
