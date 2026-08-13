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
  fgaWriteModel,
  fgaWriteTuples,
} from "./helpers/openfga.ts";
import {
  assertUuidMapCovers,
  assertUuidMapInjective,
} from "./helpers/uuid-map.ts";

/**
 * Data residency: a tenant's records may be read only *from* an
 * approved region, *by* a principal whose clearance covers the
 * record's classification, and only *while* the retention window
 * is open.
 *
 * The seam is that the region gate is not a leaf. It sits on the
 * parent links themselves — `record.dataset` and `dataset.tenant`
 * are both `[... with region_ok_d4r]` — so the tupleset row of
 * every tuple-to-userset carries a condition that has to be
 * evaluated before the dispatch that reads it is even attempted.
 * A record and the dataset above it may name different allow
 * lists, so the same request context resolves one hop and not the
 * next. That is how sovereignty rules actually read, and a model
 * that evaluates the tupleset row *after* dispatching leaks: the
 * hop out of the approved region is the one thing the regulation
 * forbids.
 *
 * Beside it: an exclusion whose subtrahend is conditioned, so a
 * denial expires rather than being revoked; an intersection of a
 * conditioned direct arm with a tuple-to-userset arm; a relation
 * admitting `user_d4r` twice, once bare and once behind a
 * clearance check; nested `group#member` carrying the tenant
 * grant; and one condition — `region_ok_d4r` — evaluated once per
 * candidate across a `listObjects` pool of seven records.
 */

const CONDITIONS: ConditionDefinition[] = [
  {
    name: "region_ok_d4r",
    expression: "region in allowed_regions",
    parameters: { region: "string", allowed_regions: "list<string>" },
  },
  {
    name: "class_ok_d4r",
    expression: "clearance >= required",
    parameters: { clearance: "int", required: "int" },
  },
  {
    name: "retained_d4r",
    expression: "now < expires_at",
    parameters: { now: "timestamp", expires_at: "timestamp" },
  },
  {
    name: "eu_principal_d4r",
    expression:
      'principal.startsWith("mira.k@") && principal.endsWith("@eu.example")',
    parameters: { principal: "string" },
  },
  {
    name: "residency_d4r",
    expression: "residency[tenant_key] == region",
    parameters: {
      residency: "map<string>",
      tenant_key: "string",
      region: "string",
    },
  },
];

const EARLY = "2026-03-01T00:00:00Z";
const LATE = "2026-09-01T00:00:00Z";
const EXPIRED = "2027-06-01T00:00:00Z";
const GOOD_PRINCIPAL = "mira.k@eu.example";

/** The full request context, with whatever this call overrides. */
function ctx(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    region: "eu-west",
    now: EARLY,
    principal: GOOD_PRINCIPAL,
    clearance: 4,
    ...over,
  };
}

/** The same, minus one parameter, to provoke a refusal. */
function without(key: string): Record<string, unknown> {
  const full = ctx();
  delete full[key];
  return full;
}

const uuidMap = new Map<string, string>([
  ["mira", "00000000-0000-4000-d586-000000000001"],
  ["g_eu", "00000000-0000-4000-d586-000000000002"],
  ["g_all", "00000000-0000-4000-d586-000000000003"],
  ["noah", "00000000-0000-4000-d586-000000000004"],
  ["tenant_eu", "00000000-0000-4000-d586-000000000005"],
  ["ines", "00000000-0000-4000-d586-000000000006"],
  ["pia", "00000000-0000-4000-d586-000000000007"],
  ["quinn", "00000000-0000-4000-d586-000000000008"],
  ["sam", "00000000-0000-4000-d586-000000000009"],
  ["tenant_us", "00000000-0000-4000-d586-000000000010"],
  ["ds_eu", "00000000-0000-4000-d586-000000000011"],
  ["ds_eu2", "00000000-0000-4000-d586-000000000012"],
  ["ds_us", "00000000-0000-4000-d586-000000000013"],
  ["tess", "00000000-0000-4000-d586-000000000014"],
  ["ds_orphan", "00000000-0000-4000-d586-000000000015"],
  ["ollie", "00000000-0000-4000-d586-000000000016"],
  ["rec1", "00000000-0000-4000-d586-000000000017"],
  ["rec2", "00000000-0000-4000-d586-000000000018"],
  ["rec3", "00000000-0000-4000-d586-000000000019"],
  ["rec4", "00000000-0000-4000-d586-000000000020"],
  ["rec6", "00000000-0000-4000-d586-000000000021"],
  ["rec7", "00000000-0000-4000-d586-000000000022"],
  ["rec5", "00000000-0000-4000-d586-000000000023"],
  ["rob", "00000000-0000-4000-d586-000000000024"],
  ["zed", "00000000-0000-4000-d586-000000000025"],
]);

function uuid(name: string): string {
  const id = uuidMap.get(name);
  if (!id) throw new Error(`No UUID for ${name}`);
  return id;
}

describe("Data Residency Model Conformance", () => {
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
        subjectType: "user_d4r",
        subjectId: uuid(subject),
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
    assertUuidMapCovers("./residency/tuples.yaml", uuidMap);

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
    const person = { type: "user_d4r" } as const;
    const groupMember = { type: "group_d4r", relation: "member" } as const;
    const retainedPerson = {
      type: "user_d4r",
      condition: "retained_d4r",
    } as const;
    const classedPerson = {
      type: "user_d4r",
      condition: "class_ok_d4r",
    } as const;
    const anyone = { type: "user_d4r", wildcard: true } as const;

    await tsfga.writeRelationConfig({
      objectType: "group_d4r",
      relation: "member",
      directlyAssignable: [person, groupMember],
      ...plain,
    });

    // --- tenant ---
    await tsfga.writeRelationConfig({
      objectType: "tenant_d4r",
      relation: "steward",
      directlyAssignable: [person, groupMember],
      ...plain,
    });
    // The same type twice: bare, and behind a clearance check.
    await tsfga.writeRelationConfig({
      objectType: "tenant_d4r",
      relation: "auditor",
      directlyAssignable: [person, classedPerson],
      ...plain,
    });
    await tsfga.writeRelationConfig({
      objectType: "tenant_d4r",
      relation: "embargoed",
      directlyAssignable: [retainedPerson, anyone],
      ...plain,
    });
    await tsfga.writeRelationConfig({
      objectType: "tenant_d4r",
      relation: "reader",
      directlyAssignable: [],
      ...plain,
      impliedBy: ["steward", "auditor"],
      excludedBy: "embargoed",
    });

    // --- dataset ---
    await tsfga.writeRelationConfig({
      objectType: "dataset_d4r",
      relation: "tenant",
      directlyAssignable: [{ type: "tenant_d4r", condition: "region_ok_d4r" }],
      ...plain,
    });
    await tsfga.writeRelationConfig({
      objectType: "dataset_d4r",
      relation: "curator",
      directlyAssignable: [
        { type: "user_d4r", condition: "eu_principal_d4r" },
        groupMember,
      ],
      ...plain,
    });
    await tsfga.writeRelationConfig({
      objectType: "dataset_d4r",
      relation: "classified",
      directlyAssignable: [classedPerson],
      ...plain,
    });
    await tsfga.writeRelationConfig({
      objectType: "dataset_d4r",
      relation: "can_read",
      directlyAssignable: [],
      ...plain,
      impliedBy: ["curator", "classified"],
      tupleToUserset: [{ tupleset: "tenant", computedUserset: "reader" }],
    });
    await tsfga.writeRelationConfig({
      objectType: "dataset_d4r",
      relation: "can_manage",
      directlyAssignable: [{ type: "user_d4r", condition: "residency_d4r" }],
      ...plain,
      intersection: [
        { type: "direct" },
        {
          type: "tupleToUserset",
          tupleset: "tenant",
          computedUserset: "reader",
        },
      ],
    });

    // --- record ---
    await tsfga.writeRelationConfig({
      objectType: "record_d4r",
      relation: "dataset",
      directlyAssignable: [{ type: "dataset_d4r", condition: "region_ok_d4r" }],
      ...plain,
    });
    await tsfga.writeRelationConfig({
      objectType: "record_d4r",
      relation: "owner",
      directlyAssignable: [person],
      ...plain,
    });
    await tsfga.writeRelationConfig({
      objectType: "record_d4r",
      relation: "reviewer",
      directlyAssignable: [retainedPerson, groupMember],
      ...plain,
    });
    await tsfga.writeRelationConfig({
      objectType: "record_d4r",
      relation: "embargoed",
      directlyAssignable: [retainedPerson, anyone],
      ...plain,
    });
    await tsfga.writeRelationConfig({
      objectType: "record_d4r",
      relation: "inherited_read",
      directlyAssignable: [],
      ...plain,
      tupleToUserset: [{ tupleset: "dataset", computedUserset: "can_read" }],
    });
    await tsfga.writeRelationConfig({
      objectType: "record_d4r",
      relation: "can_view",
      directlyAssignable: [],
      ...plain,
      impliedBy: ["owner", "reviewer", "inherited_read"],
      excludedBy: "embargoed",
    });

    // === Tuples (mirroring ./residency/tuples.yaml) ===
    const tuples: AddTupleRequest[] = [
      {
        objectType: "group_d4r",
        objectId: uuid("g_eu"),
        relation: "member",
        subjectType: "user_d4r",
        subjectId: uuid("mira"),
      },
      {
        objectType: "group_d4r",
        objectId: uuid("g_all"),
        relation: "member",
        subjectType: "group_d4r",
        subjectId: uuid("g_eu"),
        subjectRelation: "member",
      },
      {
        objectType: "group_d4r",
        objectId: uuid("g_all"),
        relation: "member",
        subjectType: "user_d4r",
        subjectId: uuid("noah"),
      },
      {
        objectType: "tenant_d4r",
        objectId: uuid("tenant_eu"),
        relation: "steward",
        subjectType: "group_d4r",
        subjectId: uuid("g_all"),
        subjectRelation: "member",
      },
      {
        objectType: "tenant_d4r",
        objectId: uuid("tenant_eu"),
        relation: "steward",
        subjectType: "user_d4r",
        subjectId: uuid("ines"),
      },
      {
        objectType: "tenant_d4r",
        objectId: uuid("tenant_eu"),
        relation: "auditor",
        subjectType: "user_d4r",
        subjectId: uuid("pia"),
      },
      {
        objectType: "tenant_d4r",
        objectId: uuid("tenant_eu"),
        relation: "auditor",
        subjectType: "user_d4r",
        subjectId: uuid("quinn"),
        conditionName: "class_ok_d4r",
        conditionContext: { required: 3 },
      },
      {
        objectType: "tenant_d4r",
        objectId: uuid("tenant_eu"),
        relation: "embargoed",
        subjectType: "user_d4r",
        subjectId: uuid("noah"),
        conditionName: "retained_d4r",
        conditionContext: { expires_at: "2026-06-01T00:00:00Z" },
      },
      {
        objectType: "tenant_d4r",
        objectId: uuid("tenant_us"),
        relation: "steward",
        subjectType: "user_d4r",
        subjectId: uuid("sam"),
      },
      {
        objectType: "dataset_d4r",
        objectId: uuid("ds_eu"),
        relation: "tenant",
        subjectType: "tenant_d4r",
        subjectId: uuid("tenant_eu"),
        conditionName: "region_ok_d4r",
        conditionContext: { allowed_regions: ["eu-west", "eu-north"] },
      },
      {
        objectType: "dataset_d4r",
        objectId: uuid("ds_eu2"),
        relation: "tenant",
        subjectType: "tenant_d4r",
        subjectId: uuid("tenant_eu"),
        conditionName: "region_ok_d4r",
        conditionContext: { allowed_regions: ["eu-north"] },
      },
      {
        objectType: "dataset_d4r",
        objectId: uuid("ds_us"),
        relation: "tenant",
        subjectType: "tenant_d4r",
        subjectId: uuid("tenant_us"),
        conditionName: "region_ok_d4r",
        conditionContext: { allowed_regions: ["us-east"] },
      },
      {
        objectType: "dataset_d4r",
        objectId: uuid("ds_eu"),
        relation: "curator",
        subjectType: "group_d4r",
        subjectId: uuid("g_eu"),
        subjectRelation: "member",
      },
      {
        objectType: "dataset_d4r",
        objectId: uuid("ds_eu"),
        relation: "curator",
        subjectType: "user_d4r",
        subjectId: uuid("mira"),
        conditionName: "eu_principal_d4r",
      },
      {
        objectType: "dataset_d4r",
        objectId: uuid("ds_orphan"),
        relation: "curator",
        subjectType: "user_d4r",
        subjectId: uuid("tess"),
        conditionName: "eu_principal_d4r",
      },
      {
        objectType: "dataset_d4r",
        objectId: uuid("ds_eu"),
        relation: "classified",
        subjectType: "user_d4r",
        subjectId: uuid("ollie"),
        conditionName: "class_ok_d4r",
        conditionContext: { required: 5 },
      },
      {
        objectType: "dataset_d4r",
        objectId: uuid("ds_eu"),
        relation: "can_manage",
        subjectType: "user_d4r",
        subjectId: uuid("ines"),
        conditionName: "residency_d4r",
        conditionContext: { tenant_key: "acme" },
      },
      {
        objectType: "record_d4r",
        objectId: uuid("rec1"),
        relation: "dataset",
        subjectType: "dataset_d4r",
        subjectId: uuid("ds_eu"),
        conditionName: "region_ok_d4r",
        conditionContext: { allowed_regions: ["eu-west"] },
      },
      {
        objectType: "record_d4r",
        objectId: uuid("rec2"),
        relation: "dataset",
        subjectType: "dataset_d4r",
        subjectId: uuid("ds_eu"),
        conditionName: "region_ok_d4r",
        conditionContext: { allowed_regions: ["eu-west", "eu-north"] },
      },
      {
        objectType: "record_d4r",
        objectId: uuid("rec3"),
        relation: "dataset",
        subjectType: "dataset_d4r",
        subjectId: uuid("ds_eu2"),
        conditionName: "region_ok_d4r",
        conditionContext: { allowed_regions: ["eu-west", "eu-north"] },
      },
      {
        objectType: "record_d4r",
        objectId: uuid("rec4"),
        relation: "dataset",
        subjectType: "dataset_d4r",
        subjectId: uuid("ds_us"),
        conditionName: "region_ok_d4r",
        conditionContext: { allowed_regions: ["us-east"] },
      },
      {
        objectType: "record_d4r",
        objectId: uuid("rec6"),
        relation: "dataset",
        subjectType: "dataset_d4r",
        subjectId: uuid("ds_eu"),
        conditionName: "region_ok_d4r",
        conditionContext: {
          allowed_regions: ["eu-west"],
          region: "eu-west",
        },
      },
      {
        objectType: "record_d4r",
        objectId: uuid("rec7"),
        relation: "dataset",
        subjectType: "dataset_d4r",
        subjectId: uuid("ds_eu"),
        conditionName: "region_ok_d4r",
        conditionContext: { allowed_regions: [] },
      },
      {
        objectType: "record_d4r",
        objectId: uuid("rec5"),
        relation: "owner",
        subjectType: "user_d4r",
        subjectId: uuid("pia"),
      },
      {
        objectType: "record_d4r",
        objectId: uuid("rec1"),
        relation: "reviewer",
        subjectType: "user_d4r",
        subjectId: uuid("rob"),
        conditionName: "retained_d4r",
        conditionContext: { expires_at: "2027-01-01T00:00:00Z" },
      },
      {
        objectType: "record_d4r",
        objectId: uuid("rec2"),
        relation: "embargoed",
        subjectType: "user_d4r",
        subjectId: "*",
      },
      {
        objectType: "record_d4r",
        objectId: uuid("rec3"),
        relation: "embargoed",
        subjectType: "user_d4r",
        subjectId: uuid("pia"),
        conditionName: "retained_d4r",
        conditionContext: { expires_at: "2026-06-01T00:00:00Z" },
      },
    ];
    for (const tuple of tuples) await tsfga.addTuple(tuple);

    storeId = await fgaCreateStore("residency");
    fgaClient = new OpenFgaClient({ apiUrl: process.env.FGA_API_URL, storeId });
    authorizationModelId = await fgaWriteModel(
      storeId,
      "./residency/model.dsl",
    );
    await fgaWriteTuples(
      storeId,
      "./residency/tuples.yaml",
      authorizationModelId,
      uuidMap,
    );
  });

  afterAll(async () => {
    await rollbackTransaction(db);
    await destroyDb();
  });

  // --- The region gate on every parent link ---

  test("1: the tenant steward reads from an approved region", async () => {
    await can("record_d4r", "rec1", "can_view", "mira", true, ctx());
  });

  test("2: and not from an unapproved one", async () => {
    await can(
      "record_d4r",
      "rec1",
      "can_view",
      "mira",
      false,
      ctx({ region: "us-east" }),
    );
  });

  test("3: record allow list and dataset allow list are separate", async () => {
    // rec3 admits both EU regions; ds_eu2's tenant row admits only
    // eu-north, so eu-west clears the first hop and not the second.
    await can("record_d4r", "rec3", "can_view", "mira", false, ctx());
    await can(
      "record_d4r",
      "rec3",
      "can_view",
      "mira",
      true,
      ctx({ region: "eu-north" }),
    );
  });

  test("4: the US steward reaches only the US record", async () => {
    await can(
      "record_d4r",
      "rec4",
      "can_view",
      "sam",
      true,
      ctx({ region: "us-east" }),
    );
    await can("record_d4r", "rec1", "can_view", "sam", false, ctx());
  });

  test("5: a stranger reaches nothing", async () => {
    await can("record_d4r", "rec1", "can_view", "zed", false, ctx());
  });

  test("6: an empty allow list admits no region at all", async () => {
    await can("record_d4r", "rec7", "can_view", "mira", false, ctx());
    await can(
      "record_d4r",
      "rec7",
      "can_view",
      "mira",
      false,
      ctx({ region: "eu-north" }),
    );
  });

  test("7: a missing region refuses on the tupleset row", async () => {
    await can("record_d4r", "rec1", "can_view", "mira", "refused", {
      ...without("region"),
    });
  });

  test("8: the tupleset row's own context beats the request's", async () => {
    // rec6 pins region=eu-west in the tuple, so the request's
    // us-east never reaches the condition.
    await can(
      "record_d4r",
      "rec6",
      "can_view",
      "mira",
      true,
      ctx({ region: "us-east" }),
    );
    await can(
      "record_d4r",
      "rec1",
      "can_view",
      "mira",
      false,
      ctx({ region: "us-east" }),
    );
  });

  // --- Clearance: the same type admitted twice ---

  test("9: the conditioned auditor arm is a >= boundary", async () => {
    await can(
      "tenant_d4r",
      "tenant_eu",
      "reader",
      "quinn",
      true,
      ctx({ clearance: 3 }),
    );
    await can(
      "tenant_d4r",
      "tenant_eu",
      "reader",
      "quinn",
      false,
      ctx({ clearance: 2 }),
    );
  });

  test("10: the bare auditor arm needs no clearance at all", async () => {
    await can("tenant_d4r", "tenant_eu", "reader", "pia", true, {
      ...without("clearance"),
    });
  });

  test("11: a missing clearance refuses on the conditioned arm", async () => {
    await can("tenant_d4r", "tenant_eu", "reader", "quinn", "refused", {
      ...without("clearance"),
    });
  });

  test("12: the classification gate holds at its own boundary", async () => {
    await can("dataset_d4r", "ds_eu", "can_read", "ollie", false, ctx());
    await can(
      "dataset_d4r",
      "ds_eu",
      "can_read",
      "ollie",
      true,
      ctx({ clearance: 5 }),
    );
  });

  // --- Retention: a denial that expires ---

  test("13: the tenant embargo denies while it lasts", async () => {
    await can("tenant_d4r", "tenant_eu", "steward", "noah", true, ctx());
    await can("tenant_d4r", "tenant_eu", "reader", "noah", false, ctx());
    await can(
      "tenant_d4r",
      "tenant_eu",
      "reader",
      "noah",
      true,
      ctx({ now: LATE }),
    );
  });

  test("14: the record embargo expires under the reader", async () => {
    await can(
      "record_d4r",
      "rec3",
      "can_view",
      "pia",
      false,
      ctx({ region: "eu-north" }),
    );
    await can(
      "record_d4r",
      "rec3",
      "can_view",
      "pia",
      true,
      ctx({ region: "eu-north", now: LATE }),
    );
  });

  test("15: the unconditioned wildcard embargo denies everyone", async () => {
    await can("record_d4r", "rec2", "inherited_read", "mira", true, ctx());
    await can("record_d4r", "rec2", "can_view", "mira", false, ctx());
    await can("record_d4r", "rec2", "can_view", "pia", false, ctx());
  });

  test("16: the reviewer's own window outlives the request", async () => {
    await can("record_d4r", "rec1", "can_view", "rob", true, ctx());
    await can(
      "record_d4r",
      "rec1",
      "can_view",
      "rob",
      false,
      ctx({ now: EXPIRED }),
    );
  });

  test("17: a missing clock refuses on the reviewer row", async () => {
    await can("record_d4r", "rec1", "can_view", "rob", "refused", {
      ...without("now"),
    });
  });

  // --- can_manage: a conditioned direct arm meeting a TTU arm ---

  test("18: the map condition grants when residency matches", async () => {
    await can(
      "dataset_d4r",
      "ds_eu",
      "can_manage",
      "ines",
      true,
      ctx({ residency: { acme: "eu-west" } }),
    );
  });

  test("19: and denies when the map names another region", async () => {
    await can(
      "dataset_d4r",
      "ds_eu",
      "can_manage",
      "ines",
      false,
      ctx({ region: "eu-north", residency: { acme: "eu-west" } }),
    );
  });

  test("20: a map without the tenant key refuses", async () => {
    await can(
      "dataset_d4r",
      "ds_eu",
      "can_manage",
      "ines",
      "refused",
      ctx({ residency: { other: "eu-west" } }),
    );
  });

  test("21: a missing residency map refuses", async () => {
    await can("dataset_d4r", "ds_eu", "can_manage", "ines", "refused", ctx());
  });

  test("22: the TTU arm alone does not manage", async () => {
    await can(
      "dataset_d4r",
      "ds_eu",
      "can_manage",
      "mira",
      false,
      ctx({ residency: { acme: "eu-west" } }),
    );
  });

  // --- The RE2 pattern, and its escaped dot ---

  test("23: the EU principal pattern grants the curator", async () => {
    await can("dataset_d4r", "ds_orphan", "can_read", "tess", true, ctx());
  });

  test("24: the escaped dot is a dot, and the anchors hold", async () => {
    await can(
      "dataset_d4r",
      "ds_orphan",
      "can_read",
      "tess",
      false,
      ctx({ principal: "mira.k@euxexample" }),
    );
    await can(
      "dataset_d4r",
      "ds_orphan",
      "can_read",
      "tess",
      false,
      ctx({ principal: "Mira.K@eu.example" }),
    );
    await can(
      "dataset_d4r",
      "ds_orphan",
      "can_read",
      "tess",
      false,
      ctx({ principal: "x.mira.k@eu.example" }),
    );
    // Added negative: the suffix alone is not enough. The old
    // pattern was anchored at the front, so a principal on the
    // right domain with the wrong local part was rejected, and a
    // rewrite that kept only `endsWith` would have admitted it.
    await can(
      "dataset_d4r",
      "ds_orphan",
      "can_read",
      "tess",
      false,
      ctx({ principal: "someone.else@eu.example" }),
    );
  });

  test("25: a missing principal refuses when nothing else grants", async () => {
    await can("dataset_d4r", "ds_orphan", "can_read", "tess", "refused", {
      ...without("principal"),
    });
  });

  // --- A condition error beside a succeeding row ---

  test("26: a granting sibling row outranks a condition error", async () => {
    // ds_eu.curator holds two rows reaching mira: her own direct
    // row, whose condition cannot be evaluated without a
    // principal, and the g_eu#member userset row, which grants
    // unconditionally.
    await can("dataset_d4r", "ds_eu", "can_read", "mira", true, {
      ...without("principal"),
    });
  });

  // --- Contextual tuples, in every shape ---

  test("27: a bare contextual grant", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "record_d4r",
        objectId: uuid("rec5"),
        relation: "can_view",
        subjectType: "user_d4r",
        subjectId: uuid("zed"),
        context: ctx(),
        contextualTuples: [
          {
            objectType: "record_d4r",
            objectId: uuid("rec5"),
            relation: "owner",
            subjectType: "user_d4r",
            subjectId: uuid("zed"),
          },
        ],
      },
      true,
    );
  });

  test("28: a contextual userset grant", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "record_d4r",
        objectId: uuid("rec5"),
        relation: "can_view",
        subjectType: "user_d4r",
        subjectId: uuid("mira"),
        context: ctx(),
        contextualTuples: [
          {
            objectType: "record_d4r",
            objectId: uuid("rec5"),
            relation: "reviewer",
            subjectType: "group_d4r",
            subjectId: uuid("g_eu"),
            subjectRelation: "member",
          },
        ],
      },
      true,
    );
  });

  test("29: a conditioned contextual grant honours its window", async () => {
    const contextualTuples: AddTupleRequest[] = [
      {
        objectType: "record_d4r",
        objectId: uuid("rec5"),
        relation: "reviewer",
        subjectType: "user_d4r",
        subjectId: uuid("zed"),
        conditionName: "retained_d4r",
        conditionContext: { expires_at: "2027-01-01T00:00:00Z" },
      },
    ];
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "record_d4r",
        objectId: uuid("rec5"),
        relation: "can_view",
        subjectType: "user_d4r",
        subjectId: uuid("zed"),
        context: ctx(),
        contextualTuples,
      },
      true,
    );
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "record_d4r",
        objectId: uuid("rec5"),
        relation: "can_view",
        subjectType: "user_d4r",
        subjectId: uuid("zed"),
        context: ctx({ now: EXPIRED }),
        contextualTuples,
      },
      false,
    );
  });

  test("30: a contextual typed wildcard embargoes the owner", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "record_d4r",
        objectId: uuid("rec5"),
        relation: "can_view",
        subjectType: "user_d4r",
        subjectId: uuid("pia"),
        context: ctx(),
        contextualTuples: [
          {
            objectType: "record_d4r",
            objectId: uuid("rec5"),
            relation: "embargoed",
            subjectType: "user_d4r",
            subjectId: "*",
          },
        ],
      },
      false,
    );
  });

  test("31: a contextual row shadows the stored one", async () => {
    // Stored: pia's rec3 embargo expires 2026-06. At LATE it has
    // lapsed, so she reads. The contextual row carries a later
    // expiry for the same object+relation+subject.
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "record_d4r",
        objectId: uuid("rec3"),
        relation: "can_view",
        subjectType: "user_d4r",
        subjectId: uuid("pia"),
        context: ctx({ region: "eu-north", now: LATE }),
        contextualTuples: [
          {
            objectType: "record_d4r",
            objectId: uuid("rec3"),
            relation: "embargoed",
            subjectType: "user_d4r",
            subjectId: uuid("pia"),
            conditionName: "retained_d4r",
            conditionContext: { expires_at: "2027-06-01T00:00:00Z" },
          },
        ],
      },
      false,
    );
  });

  test("32: a contextual row the model does not admit refuses", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "record_d4r",
        objectId: uuid("rec5"),
        relation: "can_view",
        subjectType: "user_d4r",
        subjectId: uuid("mira"),
        context: ctx(),
        contextualTuples: [
          {
            objectType: "record_d4r",
            objectId: uuid("rec5"),
            relation: "owner",
            subjectType: "group_d4r",
            subjectId: uuid("g_eu"),
            subjectRelation: "member",
          },
        ],
      },
      "refused",
    );
  });

  // --- listObjects over the candidate pool ---

  test("33: the records mira reads from eu-west", async () => {
    await expectListObjectsConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "record_d4r",
        relation: "can_view",
        subjectType: "user_d4r",
        subjectId: uuid("mira"),
        context: ctx(),
      },
      [uuid("rec1"), uuid("rec6")],
    );
  });

  test("34: and from eu-north, a different set", async () => {
    await expectListObjectsConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "record_d4r",
        relation: "can_view",
        subjectType: "user_d4r",
        subjectId: uuid("mira"),
        context: ctx({ region: "eu-north" }),
      },
      [uuid("rec3"), uuid("rec6")],
    );
  });

  test("35: pia's set while her embargo holds", async () => {
    await expectListObjectsConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "record_d4r",
        relation: "can_view",
        subjectType: "user_d4r",
        subjectId: uuid("pia"),
        context: ctx({ region: "eu-north" }),
      },
      [uuid("rec5"), uuid("rec6")],
    );
  });

  test("36: and after it lapses", async () => {
    await expectListObjectsConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "record_d4r",
        relation: "can_view",
        subjectType: "user_d4r",
        subjectId: uuid("pia"),
        context: ctx({ region: "eu-north", now: LATE }),
      },
      [uuid("rec3"), uuid("rec5"), uuid("rec6")],
    );
  });

  test("37: the datasets mira reads from eu-north", async () => {
    await expectListObjectsConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "dataset_d4r",
        relation: "can_read",
        subjectType: "user_d4r",
        subjectId: uuid("mira"),
        context: ctx({ region: "eu-north" }),
      },
      [uuid("ds_eu"), uuid("ds_eu2")],
    );
  });

  test("38: a contextual grant widens the set", async () => {
    await expectListObjectsConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "record_d4r",
        relation: "can_view",
        subjectType: "user_d4r",
        subjectId: uuid("zed"),
        context: ctx(),
        contextualTuples: [
          {
            objectType: "record_d4r",
            objectId: uuid("rec5"),
            relation: "owner",
            subjectType: "user_d4r",
            subjectId: uuid("zed"),
          },
        ],
      },
      [uuid("rec5")],
    );
  });

  /**
   * Pinned, and this is the third spelling of one divergence
   * rather than a new one.
   *
   * Every `record.dataset` row but rec6's needs the request's
   * `region`. rec6 pins it in the tuple, so its condition is
   * evaluable and it grants.
   *
   * OpenFGA reverse-expands from mira, reaches a conditioned
   * tupleset row it cannot evaluate, and refuses the whole call.
   * tsfga meets the same row on a tupleset scan -- not a read
   * naming the request subject -- so `listObjects` drops the
   * candidate and answers `["rec6"]`.
   *
   * The rule is `isDroppable` / `onSubjectRow` in
   * `packages/core/src/list-objects.ts`, already pinned for a bare
   * tuple-to-userset answering `[]`, and for a non-empty partial
   * list in `vault.test.ts`. What is new here is only how
   * ordinary the shape is: a conditioned tupleset row is how a
   * data-residency model is written.
   *
   * Not closed, and the reason is a proof rather than a
   * preference. Separating the row that must be dropped from the
   * row that must refuse needs reverse reachability over stored
   * rows, which is the one thing a forward walk does not have --
   * two candidates reach the identical branch with identical local
   * information. Both alternatives re-open four cells in the
   * refusing direction, including the one the issue called
   * strictly weaker, which it is not.
   *
   * The honest caveat for a caller is written in the README: a
   * `listObjects` answer here may be **partial and non-empty**,
   * and nothing in it says so. That sentence is the condition on
   * this pin.
   */
  test("ISSUE-460: a partial set where upstream refuses", async () => {
    await expectPinnedListObjectsDivergence(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "record_d4r",
        relation: "can_view",
        subjectType: "user_d4r",
        subjectId: uuid("mira"),
        context: without("region"),
      },
      { openfga: "refused", tsfga: [uuid("rec6")] },
    );
  });

  test("ISSUE-460: supplying the region makes both engines agree", async () => {
    // The boundary beside the pin: the divergence is the missing
    // context, not the model's shape.
    await expectListObjectsConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "record_d4r",
        relation: "can_view",
        subjectType: "user_d4r",
        subjectId: uuid("mira"),
        context: ctx(),
      },
      [uuid("rec1"), uuid("rec6")],
    );
  });

  // --- checkMany over one scope ---

  test("40: a batch mixing regions, clocks and a refusal", async () => {
    const items = [
      {
        objectType: "record_d4r",
        objectId: uuid("rec1"),
        relation: "can_view",
        subjectType: "user_d4r",
        subjectId: uuid("mira"),
        context: ctx(),
      },
      {
        objectType: "record_d4r",
        objectId: uuid("rec2"),
        relation: "can_view",
        subjectType: "user_d4r",
        subjectId: uuid("mira"),
        context: ctx(),
      },
      {
        objectType: "record_d4r",
        objectId: uuid("rec3"),
        relation: "can_view",
        subjectType: "user_d4r",
        subjectId: uuid("mira"),
        context: ctx({ region: "eu-north" }),
      },
      {
        objectType: "record_d4r",
        objectId: uuid("rec1"),
        relation: "can_view",
        subjectType: "user_d4r",
        subjectId: uuid("mira"),
        context: without("region"),
      },
      {
        objectType: "record_d4r",
        objectId: uuid("rec5"),
        relation: "can_view",
        subjectType: "user_d4r",
        subjectId: uuid("pia"),
        context: ctx(),
      },
      {
        objectType: "dataset_d4r",
        objectId: uuid("ds_eu"),
        relation: "can_read",
        subjectType: "user_d4r",
        subjectId: uuid("ollie"),
        context: ctx({ clearance: 5 }),
      },
      {
        objectType: "tenant_d4r",
        objectId: uuid("tenant_eu"),
        relation: "reader",
        subjectType: "user_d4r",
        subjectId: uuid("noah"),
        context: ctx(),
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
    expect(mine).toEqual([true, false, true, "refused", true, true, false]);
  });

  // --- The write gate ---

  test("41: a dataset's tenant row must carry the region gate", async () => {
    await expectWriteConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "dataset_d4r",
        objectId: uuid("ds_eu2"),
        relation: "tenant",
        subjectType: "tenant_d4r",
        subjectId: uuid("tenant_us"),
      },
      "refused",
    );
  });

  test("42: a reviewer row may not borrow another condition", async () => {
    await expectWriteConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "record_d4r",
        objectId: uuid("rec1"),
        relation: "reviewer",
        subjectType: "user_d4r",
        subjectId: uuid("zed"),
        conditionName: "class_ok_d4r",
      },
      "refused",
    );
  });

  test("43: an owner is a person, never a wildcard", async () => {
    await expectWriteConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "record_d4r",
        objectId: uuid("rec5"),
        relation: "owner",
        subjectType: "user_d4r",
        subjectId: "*",
      },
      "refused",
    );
  });

  test("44: nor a userset", async () => {
    await expectWriteConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "record_d4r",
        objectId: uuid("rec5"),
        relation: "owner",
        subjectType: "group_d4r",
        subjectId: uuid("g_eu"),
        subjectRelation: "member",
      },
      "refused",
    );
  });

  test("45: nothing may be written on a computed relation", async () => {
    await expectWriteConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "record_d4r",
        objectId: uuid("rec1"),
        relation: "inherited_read",
        subjectType: "user_d4r",
        subjectId: uuid("zed"),
      },
      "refused",
    );
  });

  test("46: the legal writes both arms admit", async () => {
    await expectWriteConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "record_d4r",
        objectId: uuid("rec4"),
        relation: "reviewer",
        subjectType: "user_d4r",
        subjectId: uuid("zed"),
        conditionName: "retained_d4r",
        conditionContext: { expires_at: "2027-01-01T00:00:00Z" },
      },
      "accepted",
    );
    await expectWriteConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "tenant_d4r",
        objectId: uuid("tenant_eu"),
        relation: "auditor",
        subjectType: "user_d4r",
        subjectId: uuid("zed"),
      },
      "accepted",
    );
  });

  // --- Revocation ---

  test("47: revoking the conditioned tupleset row cuts it off", async () => {
    await revoke({
      objectType: "record_d4r",
      objectId: uuid("rec1"),
      relation: "dataset",
      subjectType: "dataset_d4r",
      subjectId: uuid("ds_eu"),
    });
    await can("record_d4r", "rec1", "can_view", "mira", false, ctx());
    // rob's reviewer row is local to the record, so it survives.
    await can("record_d4r", "rec1", "can_view", "rob", true, ctx());
  });

  test("48: revoking the nested group edge cuts the tenant grant", async () => {
    await revoke({
      objectType: "group_d4r",
      objectId: uuid("g_all"),
      relation: "member",
      subjectType: "group_d4r",
      subjectId: uuid("g_eu"),
      subjectRelation: "member",
    });
    await can("tenant_d4r", "tenant_eu", "reader", "mira", false, ctx());
    await can(
      "record_d4r",
      "rec3",
      "can_view",
      "mira",
      false,
      ctx({ region: "eu-north" }),
    );
    // The curator row on ds_eu is written on g_eu#member itself,
    // so it survives the edge cut above it.
    await can("record_d4r", "rec6", "can_view", "mira", true, ctx());
  });

  test("49: revoking the conditioned embargo restores the reader", async () => {
    await revoke({
      objectType: "record_d4r",
      objectId: uuid("rec3"),
      relation: "embargoed",
      subjectType: "user_d4r",
      subjectId: uuid("pia"),
    });
    await can(
      "record_d4r",
      "rec3",
      "can_view",
      "pia",
      true,
      ctx({ region: "eu-north" }),
    );
  });

  test("the relation configs say what the model says", () => {
    expectConfigsMatchModel("./residency/model.dsl", fixture, {
      coverage: "complete",
    });
  });
});
