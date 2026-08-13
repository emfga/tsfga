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
 * An incident-response platform, Sentry/PagerDuty shaped:
 * `org → team → service → alert_rule → incident`, every level a
 * tuple-to-userset, with a self-recursive team tree hanging off the
 * top of it.
 *
 * The seam is distance. A responder grant written at the
 * organisation has to travel four hops of hierarchy and then the
 * whole team tree before it reaches an incident, so an ordinary
 * "who may acknowledge this page" question is twenty dispatches
 * deep. The tree is thirty teams long and two services hang off it
 * — one at `t15`, comfortably inside the default budget of 25, and
 * one at `t30`, past it — so the same model answers on both sides
 * of the boundary.
 *
 * Around it: the on-call rotation, which is a conditioned tuple
 * carrying the window while the request carries the clock;
 * `can_ack` as a three-armed union under an exclusion, so a
 * suppression has to beat a responder, an on-call and an escalation
 * target at once; a public status page granted to `user_d4c:*` and
 * a bar written the same way, so a wildcard appears on both sides
 * of a `but not`; an intersection one of whose operands is itself a
 * tuple-to-userset; and two RE2 patterns, one bounded class and one
 * escaped dot.
 */

const CONDITIONS: ConditionDefinition[] = [
  {
    name: "on_shift_d4c",
    expression: "now >= shift_start && now < shift_end",
    parameters: {
      now: "timestamp",
      shift_start: "timestamp",
      shift_end: "timestamp",
    },
  },
  {
    name: "sev_scope_d4c",
    expression: 'severity in ["sev-1", "sev-2", "sev-3"]',
    parameters: { severity: "string" },
  },
  {
    name: "webhook_host_d4c",
    expression: 'endpoint.startsWith("https://hooks.acme.io/")',
    parameters: { endpoint: "string" },
  },
];

const SHIFT = {
  shift_start: "2026-06-01T08:00:00Z",
  shift_end: "2026-06-01T20:00:00Z",
};
const MID_SHIFT = { now: "2026-06-01T12:00:00Z" };
const SHIFT_OPENS = { now: "2026-06-01T08:00:00Z" };
const SHIFT_CLOSES = { now: "2026-06-01T20:00:00Z" };
const BEFORE_SHIFT = { now: "2026-06-01T07:59:59Z" };
const SEV2 = { severity: "sev-2" };
const SEV9 = { severity: "sev-9" };
const HOOK_OK = { endpoint: "https://hooks.acme.io/alerts" };
const HOOK_BAD = { endpoint: "https://hooksxacme.io/alerts" };

/** The leaf team of the tree, and the depth of the tree itself. */
const TEAM_DEPTH = 30;

function teamId(index: number): string {
  return `t${String(index).padStart(2, "0")}`;
}

const uuidMap = new Map<string, string>([
  ["alice", "00000000-0000-4000-d585-000000000001"],
  ["g_sre", "00000000-0000-4000-d585-000000000002"],
  ["g_ops", "00000000-0000-4000-d585-000000000003"],
  ["bob", "00000000-0000-4000-d585-000000000004"],
  ["lena", "00000000-0000-4000-d585-000000000005"],
  ["g_page", "00000000-0000-4000-d585-000000000006"],
  ["carol", "00000000-0000-4000-d585-000000000007"],
  ["acme", "00000000-0000-4000-d585-000000000008"],
  ["t01", "00000000-0000-4000-d585-000000000009"],
  ["t02", "00000000-0000-4000-d585-000000000010"],
  ["t03", "00000000-0000-4000-d585-000000000011"],
  ["t04", "00000000-0000-4000-d585-000000000012"],
  ["t05", "00000000-0000-4000-d585-000000000013"],
  ["t06", "00000000-0000-4000-d585-000000000014"],
  ["t07", "00000000-0000-4000-d585-000000000015"],
  ["t08", "00000000-0000-4000-d585-000000000016"],
  ["t09", "00000000-0000-4000-d585-000000000017"],
  ["t10", "00000000-0000-4000-d585-000000000018"],
  ["t11", "00000000-0000-4000-d585-000000000019"],
  ["t12", "00000000-0000-4000-d585-000000000020"],
  ["t13", "00000000-0000-4000-d585-000000000021"],
  ["t14", "00000000-0000-4000-d585-000000000022"],
  ["t15", "00000000-0000-4000-d585-000000000023"],
  ["t16", "00000000-0000-4000-d585-000000000024"],
  ["t17", "00000000-0000-4000-d585-000000000025"],
  ["t18", "00000000-0000-4000-d585-000000000026"],
  ["t19", "00000000-0000-4000-d585-000000000027"],
  ["t20", "00000000-0000-4000-d585-000000000028"],
  ["t21", "00000000-0000-4000-d585-000000000029"],
  ["t22", "00000000-0000-4000-d585-000000000030"],
  ["t23", "00000000-0000-4000-d585-000000000031"],
  ["t24", "00000000-0000-4000-d585-000000000032"],
  ["t25", "00000000-0000-4000-d585-000000000033"],
  ["t26", "00000000-0000-4000-d585-000000000034"],
  ["t27", "00000000-0000-4000-d585-000000000035"],
  ["t28", "00000000-0000-4000-d585-000000000036"],
  ["t29", "00000000-0000-4000-d585-000000000037"],
  ["t30", "00000000-0000-4000-d585-000000000038"],
  ["dave", "00000000-0000-4000-d585-000000000039"],
  ["erin", "00000000-0000-4000-d585-000000000040"],
  ["svc_api", "00000000-0000-4000-d585-000000000041"],
  ["svc_deep", "00000000-0000-4000-d585-000000000042"],
  ["frank", "00000000-0000-4000-d585-000000000043"],
  ["gina", "00000000-0000-4000-d585-000000000044"],
  ["hank", "00000000-0000-4000-d585-000000000045"],
  ["svc_edge", "00000000-0000-4000-d585-000000000046"],
  ["r_cpu", "00000000-0000-4000-d585-000000000047"],
  ["r_deep", "00000000-0000-4000-d585-000000000048"],
  ["ivan", "00000000-0000-4000-d585-000000000049"],
  ["hookbot", "00000000-0000-4000-d585-000000000050"],
  ["inc1", "00000000-0000-4000-d585-000000000051"],
  ["inc2", "00000000-0000-4000-d585-000000000052"],
  ["inc_deep", "00000000-0000-4000-d585-000000000053"],
  ["jill", "00000000-0000-4000-d585-000000000054"],
  ["kim", "00000000-0000-4000-d585-000000000055"],
  ["zed", "00000000-0000-4000-d585-000000000056"],
  ["yara", "00000000-0000-4000-d585-000000000057"],
]);

function uuid(name: string): string {
  const id = uuidMap.get(name);
  if (!id) throw new Error(`No UUID for ${name}`);
  return id;
}

describe("On-call Platform Model Conformance", () => {
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
        subjectType: "user_d4c",
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
        subjectType: "user_d4c",
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
    assertUuidMapCovers("./oncall/tuples.yaml", uuidMap);

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
    const person = { type: "user_d4c" } as const;
    const anyone = { type: "user_d4c", wildcard: true } as const;
    const groupMember = { type: "group_d4c", relation: "member" } as const;
    const onShift = {
      type: "user_d4c",
      condition: "on_shift_d4c",
    } as const;
    const sevScoped = {
      type: "user_d4c",
      condition: "sev_scope_d4c",
    } as const;

    await tsfga.writeRelationConfig({
      objectType: "group_d4c",
      relation: "member",
      directlyAssignable: [person, groupMember],
      ...plain,
    });

    // --- org ---
    await tsfga.writeRelationConfig({
      objectType: "org_d4c",
      relation: "admin",
      directlyAssignable: [person, groupMember],
      ...plain,
    });
    await tsfga.writeRelationConfig({
      objectType: "org_d4c",
      relation: "member",
      directlyAssignable: [person, groupMember],
      ...plain,
      impliedBy: ["admin"],
    });

    // --- team: the self-recursive tree ---
    await tsfga.writeRelationConfig({
      objectType: "team_d4c",
      relation: "org",
      directlyAssignable: [{ type: "org_d4c" }],
      ...plain,
    });
    await tsfga.writeRelationConfig({
      objectType: "team_d4c",
      relation: "parent_team",
      directlyAssignable: [{ type: "team_d4c" }],
      ...plain,
    });
    await tsfga.writeRelationConfig({
      objectType: "team_d4c",
      relation: "member",
      directlyAssignable: [person, groupMember],
      ...plain,
      tupleToUserset: [
        { tupleset: "parent_team", computedUserset: "member" },
        { tupleset: "org", computedUserset: "member" },
      ],
    });
    await tsfga.writeRelationConfig({
      objectType: "team_d4c",
      relation: "on_call",
      directlyAssignable: [onShift],
      ...plain,
    });
    await tsfga.writeRelationConfig({
      objectType: "team_d4c",
      relation: "escalation",
      directlyAssignable: [person, groupMember],
      ...plain,
    });

    // --- service ---
    await tsfga.writeRelationConfig({
      objectType: "service_d4c",
      relation: "team",
      directlyAssignable: [{ type: "team_d4c" }],
      ...plain,
    });
    await tsfga.writeRelationConfig({
      objectType: "service_d4c",
      relation: "responder",
      directlyAssignable: [person, groupMember],
      ...plain,
      tupleToUserset: [{ tupleset: "team", computedUserset: "member" }],
    });
    await tsfga.writeRelationConfig({
      objectType: "service_d4c",
      relation: "on_call",
      directlyAssignable: [onShift],
      ...plain,
      tupleToUserset: [{ tupleset: "team", computedUserset: "on_call" }],
    });
    await tsfga.writeRelationConfig({
      objectType: "service_d4c",
      relation: "escalation",
      directlyAssignable: [person],
      ...plain,
      tupleToUserset: [{ tupleset: "team", computedUserset: "escalation" }],
    });
    await tsfga.writeRelationConfig({
      objectType: "service_d4c",
      relation: "public_status",
      directlyAssignable: [anyone],
      ...plain,
    });
    await tsfga.writeRelationConfig({
      objectType: "service_d4c",
      relation: "barred",
      directlyAssignable: [person, anyone],
      ...plain,
    });
    await tsfga.writeRelationConfig({
      objectType: "service_d4c",
      relation: "can_view_status",
      directlyAssignable: [],
      ...plain,
      impliedBy: ["responder", "public_status"],
      excludedBy: "barred",
    });

    // --- alert rule ---
    await tsfga.writeRelationConfig({
      objectType: "alert_rule_d4c",
      relation: "service",
      directlyAssignable: [{ type: "service_d4c" }],
      ...plain,
    });
    await tsfga.writeRelationConfig({
      objectType: "alert_rule_d4c",
      relation: "editor",
      directlyAssignable: [person, groupMember],
      ...plain,
    });
    await tsfga.writeRelationConfig({
      objectType: "alert_rule_d4c",
      relation: "notifier",
      directlyAssignable: [{ type: "user_d4c", condition: "webhook_host_d4c" }],
      ...plain,
    });
    await tsfga.writeRelationConfig({
      objectType: "alert_rule_d4c",
      relation: "responder",
      directlyAssignable: [person],
      ...plain,
      tupleToUserset: [{ tupleset: "service", computedUserset: "responder" }],
    });
    await tsfga.writeRelationConfig({
      objectType: "alert_rule_d4c",
      relation: "on_call",
      directlyAssignable: [],
      ...plain,
      tupleToUserset: [{ tupleset: "service", computedUserset: "on_call" }],
    });
    await tsfga.writeRelationConfig({
      objectType: "alert_rule_d4c",
      relation: "escalation",
      directlyAssignable: [],
      ...plain,
      tupleToUserset: [{ tupleset: "service", computedUserset: "escalation" }],
    });
    await tsfga.writeRelationConfig({
      objectType: "alert_rule_d4c",
      relation: "can_tune",
      directlyAssignable: [],
      ...plain,
      intersection: [
        { type: "computedUserset", relation: "editor" },
        {
          type: "tupleToUserset",
          tupleset: "service",
          computedUserset: "responder",
        },
      ],
    });

    // --- incident ---
    await tsfga.writeRelationConfig({
      objectType: "incident_d4c",
      relation: "rule",
      directlyAssignable: [{ type: "alert_rule_d4c" }],
      ...plain,
    });
    await tsfga.writeRelationConfig({
      objectType: "incident_d4c",
      relation: "responder",
      directlyAssignable: [person, sevScoped],
      ...plain,
      tupleToUserset: [{ tupleset: "rule", computedUserset: "responder" }],
    });
    await tsfga.writeRelationConfig({
      objectType: "incident_d4c",
      relation: "on_call",
      directlyAssignable: [],
      ...plain,
      tupleToUserset: [{ tupleset: "rule", computedUserset: "on_call" }],
    });
    await tsfga.writeRelationConfig({
      objectType: "incident_d4c",
      relation: "escalation_target",
      directlyAssignable: [groupMember],
      ...plain,
      tupleToUserset: [{ tupleset: "rule", computedUserset: "escalation" }],
    });
    await tsfga.writeRelationConfig({
      objectType: "incident_d4c",
      relation: "suppressed",
      directlyAssignable: [person, anyone],
      ...plain,
    });
    await tsfga.writeRelationConfig({
      objectType: "incident_d4c",
      relation: "can_ack",
      directlyAssignable: [],
      ...plain,
      impliedBy: ["responder", "on_call", "escalation_target"],
      excludedBy: "suppressed",
    });

    // === Tuples (mirroring ./oncall/tuples.yaml) ===
    const tuples: AddTupleRequest[] = [
      {
        objectType: "group_d4c",
        objectId: uuid("g_sre"),
        relation: "member",
        subjectType: "user_d4c",
        subjectId: uuid("alice"),
      },
      {
        objectType: "group_d4c",
        objectId: uuid("g_ops"),
        relation: "member",
        subjectType: "group_d4c",
        subjectId: uuid("g_sre"),
        subjectRelation: "member",
      },
      {
        objectType: "group_d4c",
        objectId: uuid("g_ops"),
        relation: "member",
        subjectType: "user_d4c",
        subjectId: uuid("bob"),
      },
      {
        objectType: "group_d4c",
        objectId: uuid("g_page"),
        relation: "member",
        subjectType: "user_d4c",
        subjectId: uuid("lena"),
      },
      {
        objectType: "org_d4c",
        objectId: uuid("acme"),
        relation: "admin",
        subjectType: "user_d4c",
        subjectId: uuid("carol"),
      },
      {
        objectType: "org_d4c",
        objectId: uuid("acme"),
        relation: "member",
        subjectType: "group_d4c",
        subjectId: uuid("g_ops"),
        subjectRelation: "member",
      },
      {
        objectType: "team_d4c",
        objectId: uuid(teamId(1)),
        relation: "org",
        subjectType: "org_d4c",
        subjectId: uuid("acme"),
      },
    ];
    for (let index = 2; index <= TEAM_DEPTH; index++) {
      tuples.push({
        objectType: "team_d4c",
        objectId: uuid(teamId(index)),
        relation: "parent_team",
        subjectType: "team_d4c",
        subjectId: uuid(teamId(index - 1)),
      });
    }
    tuples.push(
      {
        objectType: "team_d4c",
        objectId: uuid("t15"),
        relation: "on_call",
        subjectType: "user_d4c",
        subjectId: uuid("dave"),
        conditionName: "on_shift_d4c",
        conditionContext: SHIFT,
      },
      {
        objectType: "team_d4c",
        objectId: uuid("t15"),
        relation: "escalation",
        subjectType: "user_d4c",
        subjectId: uuid("erin"),
      },
      {
        objectType: "service_d4c",
        objectId: uuid("svc_api"),
        relation: "team",
        subjectType: "team_d4c",
        subjectId: uuid("t15"),
      },
      {
        objectType: "service_d4c",
        objectId: uuid("svc_deep"),
        relation: "team",
        subjectType: "team_d4c",
        subjectId: uuid("t30"),
      },
      {
        objectType: "service_d4c",
        objectId: uuid("svc_api"),
        relation: "responder",
        subjectType: "user_d4c",
        subjectId: uuid("frank"),
      },
      {
        objectType: "service_d4c",
        objectId: uuid("svc_api"),
        relation: "responder",
        subjectType: "user_d4c",
        subjectId: uuid("gina"),
      },
      {
        objectType: "service_d4c",
        objectId: uuid("svc_api"),
        relation: "barred",
        subjectType: "user_d4c",
        subjectId: uuid("gina"),
      },
      {
        objectType: "service_d4c",
        objectId: uuid("svc_api"),
        relation: "public_status",
        subjectType: "user_d4c",
        subjectId: "*",
      },
      {
        objectType: "service_d4c",
        objectId: uuid("svc_edge"),
        relation: "responder",
        subjectType: "user_d4c",
        subjectId: uuid("hank"),
      },
      {
        objectType: "service_d4c",
        objectId: uuid("svc_edge"),
        relation: "barred",
        subjectType: "user_d4c",
        subjectId: "*",
      },
      {
        objectType: "service_d4c",
        objectId: uuid("svc_edge"),
        relation: "public_status",
        subjectType: "user_d4c",
        subjectId: "*",
      },
      {
        objectType: "alert_rule_d4c",
        objectId: uuid("r_cpu"),
        relation: "service",
        subjectType: "service_d4c",
        subjectId: uuid("svc_api"),
      },
      {
        objectType: "alert_rule_d4c",
        objectId: uuid("r_deep"),
        relation: "service",
        subjectType: "service_d4c",
        subjectId: uuid("svc_deep"),
      },
      {
        objectType: "alert_rule_d4c",
        objectId: uuid("r_cpu"),
        relation: "editor",
        subjectType: "user_d4c",
        subjectId: uuid("frank"),
      },
      {
        objectType: "alert_rule_d4c",
        objectId: uuid("r_cpu"),
        relation: "editor",
        subjectType: "user_d4c",
        subjectId: uuid("ivan"),
      },
      {
        objectType: "alert_rule_d4c",
        objectId: uuid("r_cpu"),
        relation: "notifier",
        subjectType: "user_d4c",
        subjectId: uuid("hookbot"),
        conditionName: "webhook_host_d4c",
      },
      {
        objectType: "incident_d4c",
        objectId: uuid("inc1"),
        relation: "rule",
        subjectType: "alert_rule_d4c",
        subjectId: uuid("r_cpu"),
      },
      {
        objectType: "incident_d4c",
        objectId: uuid("inc2"),
        relation: "rule",
        subjectType: "alert_rule_d4c",
        subjectId: uuid("r_cpu"),
      },
      {
        objectType: "incident_d4c",
        objectId: uuid("inc_deep"),
        relation: "rule",
        subjectType: "alert_rule_d4c",
        subjectId: uuid("r_deep"),
      },
      {
        objectType: "incident_d4c",
        objectId: uuid("inc1"),
        relation: "responder",
        subjectType: "user_d4c",
        subjectId: uuid("jill"),
      },
      {
        objectType: "incident_d4c",
        objectId: uuid("inc1"),
        relation: "responder",
        subjectType: "user_d4c",
        subjectId: uuid("kim"),
        conditionName: "sev_scope_d4c",
      },
      {
        objectType: "incident_d4c",
        objectId: uuid("inc1"),
        relation: "escalation_target",
        subjectType: "group_d4c",
        subjectId: uuid("g_page"),
        subjectRelation: "member",
      },
      {
        objectType: "incident_d4c",
        objectId: uuid("inc1"),
        relation: "suppressed",
        subjectType: "user_d4c",
        subjectId: uuid("jill"),
      },
      {
        objectType: "incident_d4c",
        objectId: uuid("inc2"),
        relation: "suppressed",
        subjectType: "user_d4c",
        subjectId: "*",
      },
    );
    for (const tuple of tuples) await tsfga.addTuple(tuple);

    storeId = await fgaCreateStore("oncall");
    fgaClient = new OpenFgaClient({ apiUrl: process.env.FGA_API_URL, storeId });
    authorizationModelId = await fgaWriteModel(storeId, "./oncall/model.dsl");
    await fgaWriteTuples(
      storeId,
      "./oncall/tuples.yaml",
      authorizationModelId,
      uuidMap,
    );
  });

  afterAll(async () => {
    await rollbackTransaction(db);
    await destroyDb();
  });

  // --- The organisation and the nested group ---

  test("1: the nested group carries alice into the org", async () => {
    await can("group_d4c", "g_ops", "member", "alice", true);
    await can("org_d4c", "acme", "member", "alice", true);
  });

  test("2: the admin is a member by the other arm", async () => {
    await can("org_d4c", "acme", "member", "carol", true);
    await can("org_d4c", "acme", "admin", "bob", false);
  });

  test("3: a stranger holds nothing in the org", async () => {
    await can("org_d4c", "acme", "member", "zed", false);
    await can("org_d4c", "acme", "member", "lena", false);
  });

  // --- The team tree, level by level ---

  test("4: the org grant reaches the root team and the leaf", async () => {
    await can("team_d4c", "t01", "member", "alice", true);
    await can("team_d4c", "t15", "member", "alice", true);
  });

  test("5: and the service hanging off t15", async () => {
    await can("service_d4c", "svc_api", "responder", "alice", true);
    await can("service_d4c", "svc_api", "responder", "lena", false);
  });

  test("6: and the alert rule above the service", async () => {
    await can("alert_rule_d4c", "r_cpu", "responder", "alice", true);
    await can("alert_rule_d4c", "r_cpu", "responder", "lena", false);
  });

  test("7: and the incident above the rule, inside the budget", async () => {
    await can("incident_d4c", "inc1", "responder", "alice", true);
    await can("incident_d4c", "inc1", "can_ack", "alice", true);
  });

  test("8: bob and carol arrive by the same road", async () => {
    await can("incident_d4c", "inc1", "can_ack", "bob", true);
    await can("incident_d4c", "inc1", "can_ack", "carol", true);
  });

  test("9: and a stranger arrives nowhere", async () => {
    await can("incident_d4c", "inc1", "can_ack", "zed", false);
  });

  // --- The on-call rotation ---

  test("10: dave is on call at his own team in the window", async () => {
    await can("team_d4c", "t15", "on_call", "dave", true, MID_SHIFT);
    await can("service_d4c", "svc_api", "on_call", "dave", true, MID_SHIFT);
  });

  test("11: and the shift climbs to the incident", async () => {
    await can("alert_rule_d4c", "r_cpu", "on_call", "dave", true, MID_SHIFT);
    await can("incident_d4c", "inc1", "on_call", "dave", true, MID_SHIFT);
    await can("incident_d4c", "inc1", "can_ack", "dave", true, MID_SHIFT);
  });

  test("12: the window opens inclusively and closes exclusively", async () => {
    await can("incident_d4c", "inc1", "on_call", "dave", true, SHIFT_OPENS);
    await can("incident_d4c", "inc1", "on_call", "dave", false, SHIFT_CLOSES);
  });

  test("13: and nothing before it starts", async () => {
    await can("incident_d4c", "inc1", "on_call", "dave", false, BEFORE_SHIFT);
    await can("incident_d4c", "inc1", "can_ack", "dave", false, BEFORE_SHIFT);
  });

  test("14: a missing clock refuses on the on-call arm", async () => {
    await can("team_d4c", "t15", "on_call", "dave", "refused");
    await can("incident_d4c", "inc1", "on_call", "dave", "refused");
  });

  test("15: the rotation is one team's, not the tree's", async () => {
    await can("team_d4c", "t14", "on_call", "dave", false, MID_SHIFT);
    await can("service_d4c", "svc_deep", "on_call", "dave", false, MID_SHIFT);
  });

  // --- The escalation arm ---

  test("16: erin escalates through the team tuple-to-userset", async () => {
    await can("service_d4c", "svc_api", "escalation", "erin", true);
    await can("incident_d4c", "inc1", "escalation_target", "erin", true);
    await can("incident_d4c", "inc1", "can_ack", "erin", true);
  });

  test("17: lena escalates through the group userset", async () => {
    await can("incident_d4c", "inc1", "escalation_target", "lena", true);
    await can("incident_d4c", "inc1", "can_ack", "lena", true);
  });

  test("18: the escalation does not reach the other service", async () => {
    await can("incident_d4c", "inc_deep", "escalation_target", "erin", false);
    await can("incident_d4c", "inc2", "escalation_target", "lena", false);
  });

  // --- The exclusion under the three-armed union ---

  test("19: jill responds but is suppressed", async () => {
    await can("incident_d4c", "inc1", "responder", "jill", true);
    await can("incident_d4c", "inc1", "can_ack", "jill", false);
  });

  test("20: the wildcard suppression closes inc2 to everybody", async () => {
    await can("incident_d4c", "inc2", "responder", "alice", true);
    await can("incident_d4c", "inc2", "can_ack", "alice", false);
    await can("incident_d4c", "inc2", "can_ack", "erin", false);
  });

  test("21: and leaves inc1 alone", async () => {
    await can("incident_d4c", "inc1", "suppressed", "alice", false);
    await can("incident_d4c", "inc1", "can_ack", "alice", true);
  });

  // --- The severity condition, on the twice-admitted type ---

  test("22: kim acks an in-range severity", async () => {
    await can("incident_d4c", "inc1", "can_ack", "kim", true, SEV2);
  });

  test("23: and not one outside the class", async () => {
    await can("incident_d4c", "inc1", "can_ack", "kim", false, SEV9);
  });

  test("24: the membership is exact at both ends", async () => {
    await can("incident_d4c", "inc1", "can_ack", "kim", false, {
      severity: "sev-1x",
    });
    await can("incident_d4c", "inc1", "can_ack", "kim", false, {
      severity: "xsev-1",
    });
    // Added negative: a severity just past the enumerated range,
    // which the old character class rejected too. A list admits
    // exactly what it lists, and this is the cell that says so.
    await can("incident_d4c", "inc1", "can_ack", "kim", false, {
      severity: "sev-4",
    });
    // Added negative for the webhook rewrite: the host prefix must
    // be a prefix. The old pattern was anchored, so a host reached
    // through a redirect parameter was rejected.
    await can("alert_rule_d4c", "r_cpu", "notifier", "hookbot", false, {
      endpoint: "https://evil.example/?to=https://hooks.acme.io/",
    });
  });

  test("25: a missing severity refuses", async () => {
    await can("incident_d4c", "inc1", "responder", "kim", "refused");
  });

  test("26: the unconditioned arm of the same type still stands", async () => {
    await can("incident_d4c", "inc1", "responder", "jill", true);
  });

  // --- The public status page, and the wildcard bar ---

  test("27: anyone reads the public status page", async () => {
    await can("service_d4c", "svc_api", "public_status", "zed", true);
    await can("service_d4c", "svc_api", "can_view_status", "zed", true);
  });

  test("28: unless they are barred by name", async () => {
    await can("service_d4c", "svc_api", "responder", "gina", true);
    await can("service_d4c", "svc_api", "can_view_status", "gina", false);
  });

  test("29: a wildcard bar closes the page to its own responder", async () => {
    await can("service_d4c", "svc_edge", "responder", "hank", true);
    await can("service_d4c", "svc_edge", "can_view_status", "hank", false);
    await can("service_d4c", "svc_edge", "can_view_status", "zed", false);
  });

  // --- The intersection with a tuple-to-userset operand ---

  test("30: frank is an editor and a responder", async () => {
    await can("alert_rule_d4c", "r_cpu", "can_tune", "frank", true);
  });

  test("31: ivan edits without responding", async () => {
    await can("alert_rule_d4c", "r_cpu", "editor", "ivan", true);
    await can("alert_rule_d4c", "r_cpu", "can_tune", "ivan", false);
  });

  test("32: gina responds without editing", async () => {
    await can("alert_rule_d4c", "r_cpu", "can_tune", "gina", false);
    await can("alert_rule_d4c", "r_cpu", "can_tune", "alice", false);
  });

  // --- The webhook pattern and its escaped dot ---

  test("33: the notifier matches its host", async () => {
    await can("alert_rule_d4c", "r_cpu", "notifier", "hookbot", true, HOOK_OK);
  });

  test("34: the escaped dot is a dot, not any character", async () => {
    await can(
      "alert_rule_d4c",
      "r_cpu",
      "notifier",
      "hookbot",
      false,
      HOOK_BAD,
    );
    await can("alert_rule_d4c", "r_cpu", "notifier", "hookbot", "refused");
  });

  // --- The depth boundary ---

  test("35: the deep service is past the budget", async () => {
    // t20 is 22 dispatches from alice's group row and answers; t30
    // is 32 and does not. inc_deep hangs off t30, so the same
    // question that inc1 answers in 20 dispatches exhausts here —
    // and both engines refuse rather than deny.
    await can("team_d4c", "t20", "member", "alice", true);
    await can("team_d4c", "t30", "member", "alice", "refused");
    await can("incident_d4c", "inc_deep", "responder", "alice", "refused");
    await can("incident_d4c", "inc_deep", "can_ack", "alice", "refused");
  });

  // --- Contextual tuples, in every shape ---

  test("36: a bare contextual responder", async () => {
    await canWith(
      "incident_d4c",
      "inc1",
      "can_ack",
      "zed",
      [
        {
          objectType: "incident_d4c",
          objectId: uuid("inc1"),
          relation: "responder",
          subjectType: "user_d4c",
          subjectId: uuid("zed"),
        },
      ],
      true,
    );
  });

  test("37: a contextual userset subject", async () => {
    await canWith(
      "alert_rule_d4c",
      "r_deep",
      "responder",
      "lena",
      [
        {
          objectType: "service_d4c",
          objectId: uuid("svc_deep"),
          relation: "responder",
          subjectType: "group_d4c",
          subjectId: uuid("g_page"),
          subjectRelation: "member",
        },
      ],
      true,
    );
  });

  test("38: a contextual conditioned on-call row", async () => {
    const shift: AddTupleRequest[] = [
      {
        objectType: "team_d4c",
        objectId: uuid("t15"),
        relation: "on_call",
        subjectType: "user_d4c",
        subjectId: uuid("zed"),
        conditionName: "on_shift_d4c",
        conditionContext: SHIFT,
      },
    ];
    await canWith(
      "incident_d4c",
      "inc1",
      "on_call",
      "zed",
      shift,
      true,
      MID_SHIFT,
    );
    await canWith(
      "incident_d4c",
      "inc1",
      "on_call",
      "zed",
      shift,
      false,
      BEFORE_SHIFT,
    );
  });

  test("39: a contextual typed wildcard suppression", async () => {
    await canWith(
      "incident_d4c",
      "inc1",
      "can_ack",
      "lena",
      [
        {
          objectType: "incident_d4c",
          objectId: uuid("inc1"),
          relation: "suppressed",
          subjectType: "user_d4c",
          subjectId: "*",
        },
      ],
      false,
    );
  });

  test("40: a contextual row shadowing a stored conditioned one", async () => {
    await canWith(
      "incident_d4c",
      "inc1",
      "responder",
      "kim",
      [
        {
          objectType: "incident_d4c",
          objectId: uuid("inc1"),
          relation: "responder",
          subjectType: "user_d4c",
          subjectId: uuid("kim"),
        },
      ],
      true,
    );
  });

  test("41: a contextual row the model does not admit", async () => {
    await canWith(
      "incident_d4c",
      "inc1",
      "escalation_target",
      "zed",
      [
        {
          objectType: "incident_d4c",
          objectId: uuid("inc1"),
          relation: "escalation_target",
          subjectType: "user_d4c",
          subjectId: uuid("zed"),
        },
      ],
      "refused",
    );
  });

  // --- listObjects ---

  test("42: the groups alice belongs to", async () => {
    await expectListObjectsConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "group_d4c",
        relation: "member",
        subjectType: "user_d4c",
        subjectId: uuid("alice"),
      },
      [uuid("g_sre"), uuid("g_ops")],
    );
  });

  test("43: the teams dave is on call for, in the window", async () => {
    await expectListObjectsConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "team_d4c",
        relation: "on_call",
        subjectType: "user_d4c",
        subjectId: uuid("dave"),
        context: MID_SHIFT,
      },
      [uuid("t15")],
    );
  });

  test("44: and none of them before the shift", async () => {
    await expectListObjectsConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "team_d4c",
        relation: "on_call",
        subjectType: "user_d4c",
        subjectId: uuid("dave"),
        context: BEFORE_SHIFT,
      },
      [],
    );
  });

  test("45: the status pages open to a stranger", async () => {
    await expectListObjectsConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "service_d4c",
        relation: "public_status",
        subjectType: "user_d4c",
        subjectId: uuid("zed"),
      },
      [uuid("svc_api"), uuid("svc_edge")],
    );
  });

  test("46: the incidents erin is an escalation target for", async () => {
    await expectListObjectsConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "incident_d4c",
        relation: "escalation_target",
        subjectType: "user_d4c",
        subjectId: uuid("erin"),
      },
      [uuid("inc1"), uuid("inc2")],
    );
  });

  test("47: a contextual escalation widens the list", async () => {
    await expectListObjectsConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "incident_d4c",
        relation: "escalation_target",
        subjectType: "user_d4c",
        subjectId: uuid("zed"),
        contextualTuples: [
          {
            objectType: "team_d4c",
            objectId: uuid("t30"),
            relation: "escalation",
            subjectType: "user_d4c",
            subjectId: uuid("zed"),
          },
        ],
      },
      [uuid("inc_deep")],
    );
  });

  // --- checkMany over one scope ---

  test("48: a batch mixing subjects, contexts and refusals", async () => {
    const items = [
      {
        objectType: "incident_d4c",
        objectId: uuid("inc1"),
        relation: "can_ack",
        subjectType: "user_d4c",
        subjectId: uuid("alice"),
      },
      {
        objectType: "incident_d4c",
        objectId: uuid("inc1"),
        relation: "can_ack",
        subjectType: "user_d4c",
        subjectId: uuid("jill"),
      },
      {
        objectType: "incident_d4c",
        objectId: uuid("inc1"),
        relation: "can_ack",
        subjectType: "user_d4c",
        subjectId: uuid("kim"),
        context: SEV2,
      },
      {
        objectType: "incident_d4c",
        objectId: uuid("inc1"),
        relation: "responder",
        subjectType: "user_d4c",
        subjectId: uuid("kim"),
      },
      {
        objectType: "incident_d4c",
        objectId: uuid("inc1"),
        relation: "on_call",
        subjectType: "user_d4c",
        subjectId: uuid("dave"),
        context: MID_SHIFT,
      },
      {
        objectType: "incident_d4c",
        objectId: uuid("inc1"),
        relation: "on_call",
        subjectType: "user_d4c",
        subjectId: uuid("dave"),
        context: BEFORE_SHIFT,
      },
      {
        objectType: "service_d4c",
        objectId: uuid("svc_api"),
        relation: "can_view_status",
        subjectType: "user_d4c",
        subjectId: uuid("zed"),
      },
      {
        objectType: "incident_d4c",
        objectId: uuid("inc2"),
        relation: "can_ack",
        subjectType: "user_d4c",
        subjectId: uuid("erin"),
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
      false,
      true,
      false,
    ]);
  });

  // --- The write gate ---

  test("49: an on-call row must carry its window", async () => {
    await expectWriteConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "team_d4c",
        objectId: uuid("t15"),
        relation: "on_call",
        subjectType: "user_d4c",
        subjectId: uuid("zed"),
      },
      "refused",
    );
  });

  test("50: and not somebody else's condition", async () => {
    await expectWriteConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "team_d4c",
        objectId: uuid("t15"),
        relation: "on_call",
        subjectType: "user_d4c",
        subjectId: uuid("zed"),
        conditionName: "sev_scope_d4c",
      },
      "refused",
    );
  });

  test("51: a status page is a wildcard, never a person", async () => {
    await expectWriteConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "service_d4c",
        objectId: uuid("svc_api"),
        relation: "public_status",
        subjectType: "user_d4c",
        subjectId: uuid("zed"),
      },
      "refused",
    );
  });

  test("52: a service escalation is a person, never a userset", async () => {
    await expectWriteConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "service_d4c",
        objectId: uuid("svc_api"),
        relation: "escalation",
        subjectType: "group_d4c",
        subjectId: uuid("g_page"),
        subjectRelation: "member",
      },
      "refused",
    );
  });

  test("53: nothing may be written on a computed relation", async () => {
    await expectWriteConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "incident_d4c",
        objectId: uuid("inc1"),
        relation: "can_ack",
        subjectType: "user_d4c",
        subjectId: uuid("zed"),
      },
      "refused",
    );
  });

  test("54: the twice-admitted type takes both spellings", async () => {
    await expectWriteConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "incident_d4c",
        objectId: uuid("inc2"),
        relation: "responder",
        subjectType: "user_d4c",
        subjectId: uuid("zed"),
      },
      "accepted",
    );
    await expectWriteConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "incident_d4c",
        objectId: uuid("inc2"),
        relation: "responder",
        subjectType: "user_d4c",
        subjectId: uuid("yara"),
        conditionName: "sev_scope_d4c",
      },
      "accepted",
    );
  });

  // --- Revocation ---

  test("55: revoking the group userset drops lena's escalation", async () => {
    await revoke({
      objectType: "incident_d4c",
      objectId: uuid("inc1"),
      relation: "escalation_target",
      subjectType: "group_d4c",
      subjectId: uuid("g_page"),
      subjectRelation: "member",
    });
    await can("incident_d4c", "inc1", "escalation_target", "lena", false);
    await can("incident_d4c", "inc1", "can_ack", "lena", false);
  });

  test("56: revoking the team row cuts the escalation arm", async () => {
    await revoke({
      objectType: "team_d4c",
      objectId: uuid("t15"),
      relation: "escalation",
      subjectType: "user_d4c",
      subjectId: uuid("erin"),
    });
    await can("service_d4c", "svc_api", "escalation", "erin", false);
    await can("incident_d4c", "inc1", "can_ack", "erin", false);
  });

  test("57: revoking the suppression gives jill the incident", async () => {
    await revoke({
      objectType: "incident_d4c",
      objectId: uuid("inc1"),
      relation: "suppressed",
      subjectType: "user_d4c",
      subjectId: uuid("jill"),
    });
    await can("incident_d4c", "inc1", "can_ack", "jill", true);
  });

  test("the relation configs say what the model says", () => {
    expectConfigsMatchModel("./oncall/model.dsl", fixture, {
      coverage: "complete",
    });
  });
});
