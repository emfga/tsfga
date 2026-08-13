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
 * Google Cloud IAM: an allow policy that *inherits down* the
 * resource hierarchy, and a deny policy that inherits down beside
 * it.
 *
 * The seam is that both directions of the fold recurse. `denied`
 * is not a local subtrahend — on `folder_d4g` it is itself a
 * two-armed self-recursive tuple-to-userset (`denied from
 * parent_org or denied from parent_folder`), so an exclusion at
 * the top of a five-level tree has to be resolved through four
 * dispatches before the minuend at the bottom can be decided. GCP
 * really works this way, and a model that gets it wrong leaks in
 * the granting direction: a deny written at the org is the one
 * control an administrator expects to be inescapable.
 *
 * Around it: a bucket whose `can_write` is an intersection of a
 * union (`writer or can_setiam from project`) with an exclusion
 * (`inherited_read but not quarantined`), so an operand of the
 * intersection is itself a set operator; a wildcard quarantine
 * that takes a bucket away from the org admin; a nested group
 * (`g_sre#member` inside `g_eng#member`) carrying the org grant;
 * and three conditions doing real work — a resource-tag list
 * membership split across tuple and request, a service-account
 * pattern with an escaped dot, and a validity window.
 */

const CONDITIONS: ConditionDefinition[] = [
  {
    name: "tag_scope_d4g",
    expression: "required_tag in resource_tags",
    parameters: { resource_tags: "list<string>", required_tag: "string" },
  },
  {
    name: "in_window_d4g",
    expression: "now >= not_before && now < not_after",
    parameters: {
      now: "timestamp",
      not_before: "timestamp",
      not_after: "timestamp",
    },
  },
  {
    name: "svc_account_d4g",
    expression: 'principal.startsWith("svc-") && principal.endsWith("@ex.io")',
    parameters: { principal: "string" },
  },
];

const WINDOW = {
  not_before: "2026-01-01T00:00:00Z",
  not_after: "2026-12-31T00:00:00Z",
};
const IN_WINDOW = { now: "2026-06-01T00:00:00Z" };
const AFTER_WINDOW = { now: "2027-01-02T00:00:00Z" };
const PROD_TAGS = { resource_tags: ["env:prod", "team:web"] };
const DEV_TAGS = { resource_tags: ["env:dev"] };
const SVC = { principal: "svc-etl@ex.io" };

const uuidMap = new Map<string, string>([
  ["alice", "00000000-0000-4000-d581-000000000001"],
  ["g_sre", "00000000-0000-4000-d581-000000000002"],
  ["g_eng", "00000000-0000-4000-d581-000000000003"],
  ["bob", "00000000-0000-4000-d581-000000000004"],
  ["acme", "00000000-0000-4000-d581-000000000005"],
  ["carol", "00000000-0000-4000-d581-000000000006"],
  ["f_prod", "00000000-0000-4000-d581-000000000007"],
  ["f_team", "00000000-0000-4000-d581-000000000008"],
  ["dan", "00000000-0000-4000-d581-000000000009"],
  ["p_web", "00000000-0000-4000-d581-000000000010"],
  ["p_data", "00000000-0000-4000-d581-000000000011"],
  ["erin", "00000000-0000-4000-d581-000000000012"],
  ["b_logs", "00000000-0000-4000-d581-000000000013"],
  ["b_raw", "00000000-0000-4000-d581-000000000014"],
  ["svc", "00000000-0000-4000-d581-000000000015"],
  ["frank", "00000000-0000-4000-d581-000000000016"],
  ["zed", "00000000-0000-4000-d581-000000000017"],
]);

function uuid(name: string): string {
  const id = uuidMap.get(name);
  if (!id) throw new Error(`No UUID for ${name}`);
  return id;
}

describe("Google Cloud IAM Model Conformance", () => {
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
        subjectType: "user_d4g",
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
    assertUuidMapCovers("./gcloud/tuples.yaml", uuidMap);

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
    const groupMember = { type: "group_d4g", relation: "member" } as const;
    const person = { type: "user_d4g" } as const;
    const taggedPerson = {
      type: "user_d4g",
      condition: "tag_scope_d4g",
    } as const;

    await tsfga.writeRelationConfig({
      objectType: "group_d4g",
      relation: "member",
      directlyAssignable: [person, groupMember],
      ...plain,
    });

    // --- org ---
    await tsfga.writeRelationConfig({
      objectType: "org_d4g",
      relation: "admin",
      directlyAssignable: [person, groupMember],
      ...plain,
    });
    await tsfga.writeRelationConfig({
      objectType: "org_d4g",
      relation: "viewer",
      directlyAssignable: [person, groupMember, taggedPerson],
      ...plain,
    });
    await tsfga.writeRelationConfig({
      objectType: "org_d4g",
      relation: "denied",
      directlyAssignable: [person, groupMember],
      ...plain,
    });
    await tsfga.writeRelationConfig({
      objectType: "org_d4g",
      relation: "can_view",
      directlyAssignable: [],
      ...plain,
      impliedBy: ["viewer", "admin"],
      excludedBy: "denied",
    });

    // --- folder ---
    await tsfga.writeRelationConfig({
      objectType: "folder_d4g",
      relation: "parent_org",
      directlyAssignable: [{ type: "org_d4g" }],
      ...plain,
    });
    await tsfga.writeRelationConfig({
      objectType: "folder_d4g",
      relation: "parent_folder",
      directlyAssignable: [{ type: "folder_d4g" }],
      ...plain,
    });
    for (const [relation, refs] of [
      ["admin", [person, groupMember]],
      ["viewer", [person, groupMember, taggedPerson]],
      ["denied", [person, groupMember]],
    ] as const) {
      await tsfga.writeRelationConfig({
        objectType: "folder_d4g",
        relation,
        directlyAssignable: [...refs],
        ...plain,
        tupleToUserset: [
          { tupleset: "parent_org", computedUserset: relation },
          { tupleset: "parent_folder", computedUserset: relation },
        ],
      });
    }
    await tsfga.writeRelationConfig({
      objectType: "folder_d4g",
      relation: "can_view",
      directlyAssignable: [],
      ...plain,
      impliedBy: ["viewer", "admin"],
      excludedBy: "denied",
    });

    // --- project ---
    await tsfga.writeRelationConfig({
      objectType: "project_d4g",
      relation: "parent",
      directlyAssignable: [{ type: "folder_d4g" }],
      ...plain,
    });
    await tsfga.writeRelationConfig({
      objectType: "project_d4g",
      relation: "owner",
      directlyAssignable: [person],
      ...plain,
    });
    await tsfga.writeRelationConfig({
      objectType: "project_d4g",
      relation: "admin",
      directlyAssignable: [person],
      ...plain,
      tupleToUserset: [{ tupleset: "parent", computedUserset: "admin" }],
    });
    await tsfga.writeRelationConfig({
      objectType: "project_d4g",
      relation: "viewer",
      directlyAssignable: [person, groupMember, taggedPerson],
      ...plain,
      tupleToUserset: [{ tupleset: "parent", computedUserset: "viewer" }],
    });
    await tsfga.writeRelationConfig({
      objectType: "project_d4g",
      relation: "denied",
      directlyAssignable: [person, groupMember],
      ...plain,
      tupleToUserset: [{ tupleset: "parent", computedUserset: "denied" }],
    });
    await tsfga.writeRelationConfig({
      objectType: "project_d4g",
      relation: "can_view",
      directlyAssignable: [],
      ...plain,
      impliedBy: ["viewer", "admin", "owner"],
      excludedBy: "denied",
    });
    await tsfga.writeRelationConfig({
      objectType: "project_d4g",
      relation: "can_setiam",
      directlyAssignable: [],
      ...plain,
      computedUserset: "admin",
      excludedBy: "denied",
    });

    // --- bucket ---
    await tsfga.writeRelationConfig({
      objectType: "bucket_d4g",
      relation: "project",
      directlyAssignable: [{ type: "project_d4g" }],
      ...plain,
    });
    await tsfga.writeRelationConfig({
      objectType: "bucket_d4g",
      relation: "reader",
      directlyAssignable: [
        person,
        groupMember,
        { type: "user_d4g", condition: "svc_account_d4g" },
      ],
      ...plain,
    });
    await tsfga.writeRelationConfig({
      objectType: "bucket_d4g",
      relation: "writer",
      directlyAssignable: [{ type: "user_d4g", condition: "in_window_d4g" }],
      ...plain,
    });
    await tsfga.writeRelationConfig({
      objectType: "bucket_d4g",
      relation: "quarantined",
      directlyAssignable: [{ type: "user_d4g", wildcard: true }],
      ...plain,
    });
    await tsfga.writeRelationConfig({
      objectType: "bucket_d4g",
      relation: "inherited_read",
      directlyAssignable: [],
      ...plain,
      impliedBy: ["reader"],
      tupleToUserset: [{ tupleset: "project", computedUserset: "can_view" }],
    });
    await tsfga.writeRelationConfig({
      objectType: "bucket_d4g",
      relation: "can_read",
      directlyAssignable: [],
      ...plain,
      computedUserset: "inherited_read",
      excludedBy: "quarantined",
    });
    await tsfga.writeRelationConfig({
      objectType: "bucket_d4g",
      relation: "write_grant",
      directlyAssignable: [],
      ...plain,
      impliedBy: ["writer"],
      tupleToUserset: [{ tupleset: "project", computedUserset: "can_setiam" }],
    });
    await tsfga.writeRelationConfig({
      objectType: "bucket_d4g",
      relation: "can_write",
      directlyAssignable: [],
      ...plain,
      intersection: [
        { type: "computedUserset", relation: "write_grant" },
        { type: "computedUserset", relation: "can_read" },
      ],
    });

    // === Tuples (mirroring ./gcloud/tuples.yaml) ===
    const tuples: AddTupleRequest[] = [
      {
        objectType: "group_d4g",
        objectId: uuid("g_sre"),
        relation: "member",
        subjectType: "user_d4g",
        subjectId: uuid("alice"),
      },
      {
        objectType: "group_d4g",
        objectId: uuid("g_eng"),
        relation: "member",
        subjectType: "group_d4g",
        subjectId: uuid("g_sre"),
        subjectRelation: "member",
      },
      {
        objectType: "group_d4g",
        objectId: uuid("g_eng"),
        relation: "member",
        subjectType: "user_d4g",
        subjectId: uuid("bob"),
      },
      {
        objectType: "org_d4g",
        objectId: uuid("acme"),
        relation: "viewer",
        subjectType: "group_d4g",
        subjectId: uuid("g_eng"),
        subjectRelation: "member",
      },
      {
        objectType: "org_d4g",
        objectId: uuid("acme"),
        relation: "admin",
        subjectType: "user_d4g",
        subjectId: uuid("carol"),
      },
      {
        objectType: "folder_d4g",
        objectId: uuid("f_prod"),
        relation: "parent_org",
        subjectType: "org_d4g",
        subjectId: uuid("acme"),
      },
      {
        objectType: "folder_d4g",
        objectId: uuid("f_team"),
        relation: "parent_folder",
        subjectType: "folder_d4g",
        subjectId: uuid("f_prod"),
      },
      {
        objectType: "folder_d4g",
        objectId: uuid("f_prod"),
        relation: "denied",
        subjectType: "user_d4g",
        subjectId: uuid("bob"),
      },
      {
        objectType: "folder_d4g",
        objectId: uuid("f_team"),
        relation: "viewer",
        subjectType: "user_d4g",
        subjectId: uuid("dan"),
        conditionName: "tag_scope_d4g",
        conditionContext: { required_tag: "env:prod" },
      },
      {
        objectType: "project_d4g",
        objectId: uuid("p_web"),
        relation: "parent",
        subjectType: "folder_d4g",
        subjectId: uuid("f_team"),
      },
      {
        objectType: "project_d4g",
        objectId: uuid("p_data"),
        relation: "parent",
        subjectType: "folder_d4g",
        subjectId: uuid("f_prod"),
      },
      {
        objectType: "project_d4g",
        objectId: uuid("p_web"),
        relation: "owner",
        subjectType: "user_d4g",
        subjectId: uuid("erin"),
      },
      {
        objectType: "bucket_d4g",
        objectId: uuid("b_logs"),
        relation: "project",
        subjectType: "project_d4g",
        subjectId: uuid("p_web"),
      },
      {
        objectType: "bucket_d4g",
        objectId: uuid("b_raw"),
        relation: "project",
        subjectType: "project_d4g",
        subjectId: uuid("p_data"),
      },
      {
        objectType: "bucket_d4g",
        objectId: uuid("b_logs"),
        relation: "reader",
        subjectType: "group_d4g",
        subjectId: uuid("g_sre"),
        subjectRelation: "member",
      },
      {
        objectType: "bucket_d4g",
        objectId: uuid("b_logs"),
        relation: "reader",
        subjectType: "user_d4g",
        subjectId: uuid("svc"),
        conditionName: "svc_account_d4g",
      },
      {
        objectType: "bucket_d4g",
        objectId: uuid("b_logs"),
        relation: "writer",
        subjectType: "user_d4g",
        subjectId: uuid("frank"),
        conditionName: "in_window_d4g",
        conditionContext: WINDOW,
      },
      {
        objectType: "bucket_d4g",
        objectId: uuid("b_logs"),
        relation: "writer",
        subjectType: "user_d4g",
        subjectId: uuid("erin"),
        conditionName: "in_window_d4g",
        conditionContext: WINDOW,
      },
      {
        objectType: "bucket_d4g",
        objectId: uuid("b_raw"),
        relation: "quarantined",
        subjectType: "user_d4g",
        subjectId: "*",
      },
    ];
    for (const tuple of tuples) await tsfga.addTuple(tuple);

    storeId = await fgaCreateStore("gcloud");
    fgaClient = new OpenFgaClient({ apiUrl: process.env.FGA_API_URL, storeId });
    authorizationModelId = await fgaWriteModel(storeId, "./gcloud/model.dsl");
    await fgaWriteTuples(
      storeId,
      "./gcloud/tuples.yaml",
      authorizationModelId,
      uuidMap,
    );
  });

  afterAll(async () => {
    await rollbackTransaction(db);
    await destroyDb();
  });

  // --- The nested group carrying the org grant ---

  test("1: the nested group makes alice an org viewer", async () => {
    await can("org_d4g", "acme", "viewer", "alice", true);
    await can("org_d4g", "acme", "can_view", "alice", true);
  });

  test("2: bob is a direct member of the outer group", async () => {
    await can("org_d4g", "acme", "can_view", "bob", true);
  });

  test("3: the org admin views by the other arm", async () => {
    await can("org_d4g", "acme", "can_view", "carol", true);
    await can("org_d4g", "acme", "viewer", "carol", false);
  });

  test("4: a stranger holds nothing", async () => {
    await can("org_d4g", "acme", "can_view", "zed", false);
  });

  // --- The allow policy inheriting down ---

  test("5: the org viewer reaches the folder", async () => {
    await can("folder_d4g", "f_prod", "can_view", "alice", true);
    await can("folder_d4g", "f_team", "can_view", "alice", true);
  });

  test("6: and the projects under it", async () => {
    await can("project_d4g", "p_web", "can_view", "alice", true);
    await can("project_d4g", "p_data", "can_view", "alice", true);
  });

  test("7: and the buckets under those", async () => {
    await can("bucket_d4g", "b_logs", "inherited_read", "alice", true);
  });

  test("8: the org admin inherits admin, not just view", async () => {
    await can("project_d4g", "p_web", "admin", "carol", true);
    await can("project_d4g", "p_web", "can_setiam", "carol", true);
    await can("project_d4g", "p_web", "can_setiam", "alice", false);
  });

  // --- The deny policy inheriting down beside it ---

  test("9: bob's org grant survives above the deny", async () => {
    await can("org_d4g", "acme", "can_view", "bob", true);
  });

  test("10: and is cut at the folder the deny names", async () => {
    await can("folder_d4g", "f_prod", "denied", "bob", true);
    await can("folder_d4g", "f_prod", "can_view", "bob", false);
  });

  test("11: the deny reaches the folder below it", async () => {
    await can("folder_d4g", "f_team", "denied", "bob", true);
    await can("folder_d4g", "f_team", "can_view", "bob", false);
  });

  test("12: and both projects, through different arms", async () => {
    await can("project_d4g", "p_web", "can_view", "bob", false);
    await can("project_d4g", "p_data", "can_view", "bob", false);
  });

  test("13: and the bucket at the bottom", async () => {
    await can("bucket_d4g", "b_logs", "can_read", "bob", false);
  });

  test("14: the deny does not touch anybody else", async () => {
    await can("folder_d4g", "f_team", "can_view", "alice", true);
  });

  // --- The tag condition, split across tuple and request ---

  test("15: dan views the folder when the tag is present", async () => {
    await can("folder_d4g", "f_team", "can_view", "dan", true, PROD_TAGS);
  });

  test("16: and not when it is absent", async () => {
    await can("folder_d4g", "f_team", "can_view", "dan", false, DEV_TAGS);
  });

  test("17: an empty tag list is a denial, not a refusal", async () => {
    await can("folder_d4g", "f_team", "can_view", "dan", false, {
      resource_tags: [],
    });
  });

  test("18: a missing tag list refuses", async () => {
    await can("folder_d4g", "f_team", "can_view", "dan", "refused");
  });

  test("19: dan's grant does not climb back up the tree", async () => {
    await can("folder_d4g", "f_prod", "can_view", "dan", false, PROD_TAGS);
    await can("org_d4g", "acme", "can_view", "dan", false, PROD_TAGS);
  });

  test("20: but it does descend to the project and the bucket", async () => {
    await can("project_d4g", "p_web", "can_view", "dan", true, PROD_TAGS);
    await can("bucket_d4g", "b_logs", "can_read", "dan", true, PROD_TAGS);
  });

  // --- The service-account pattern, and its escaped dot ---

  test("21: the service account reads its bucket", async () => {
    await can("bucket_d4g", "b_logs", "can_read", "svc", true, SVC);
  });

  test("22: the escaped dot is a dot, not any character", async () => {
    await can("bucket_d4g", "b_logs", "can_read", "svc", false, {
      principal: "svc-etl@exqio",
    });
  });

  test("23: the predicate is anchored and case-sensitive", async () => {
    // Added negative: the prefix and the suffix must both hold on
    // the *same* value. A principal carrying `svc-` only in the
    // middle satisfies neither end and was rejected before.
    await can("bucket_d4g", "b_logs", "can_read", "svc", false, {
      principal: "team-svc-etl@ex.io.example",
    });
    await can("bucket_d4g", "b_logs", "can_read", "svc", false, {
      principal: "SVC-ETL@ex.io",
    });
    await can("bucket_d4g", "b_logs", "can_read", "svc", false, {
      principal: "prefix-svc-etl@ex.io-suffix",
    });
  });

  test("24: a missing principal refuses", async () => {
    await can("bucket_d4g", "b_logs", "can_read", "svc", "refused");
  });

  test("25: the service account reaches nothing else", async () => {
    await can("project_d4g", "p_web", "can_view", "svc", false, SVC);
  });

  // --- The wildcard quarantine ---

  test("26: the quarantine takes the bucket from everybody", async () => {
    await can("bucket_d4g", "b_raw", "inherited_read", "alice", true);
    await can("bucket_d4g", "b_raw", "can_read", "alice", false);
  });

  test("27: including the org administrator", async () => {
    await can("bucket_d4g", "b_raw", "can_read", "carol", false);
  });

  test("28: and it is local to the bucket that carries it", async () => {
    await can("bucket_d4g", "b_logs", "can_read", "carol", true);
  });

  // --- can_write: an intersection of a union with an exclusion ---

  test("29: the project owner writes inside the window", async () => {
    await can("bucket_d4g", "b_logs", "can_write", "erin", true, IN_WINDOW);
  });

  test("30: and not outside it", async () => {
    await can("bucket_d4g", "b_logs", "can_write", "erin", false, AFTER_WINDOW);
  });

  test("31: a writer who cannot read cannot write", async () => {
    await can("bucket_d4g", "b_logs", "write_grant", "frank", true, IN_WINDOW);
    await can("bucket_d4g", "b_logs", "can_read", "frank", false, IN_WINDOW);
    await can("bucket_d4g", "b_logs", "can_write", "frank", false, IN_WINDOW);
  });

  test("32: the setIAM arm writes without any writer row", async () => {
    await can("bucket_d4g", "b_logs", "can_write", "carol", true);
  });

  test("33: a reader who is not a writer does not write", async () => {
    await can("bucket_d4g", "b_logs", "can_write", "alice", false);
  });

  test("34: a missing clock refuses on the writer arm", async () => {
    await can("bucket_d4g", "b_logs", "can_write", "erin", "refused");
  });

  // --- listObjects ---

  test("35: the buckets alice may read", async () => {
    await expectListObjectsConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "bucket_d4g",
        relation: "can_read",
        subjectType: "user_d4g",
        subjectId: uuid("alice"),
      },
      [uuid("b_logs")],
    );
  });

  test("36: the projects bob may view, after the deny", async () => {
    await expectListObjectsConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "project_d4g",
        relation: "can_view",
        subjectType: "user_d4g",
        subjectId: uuid("bob"),
      },
      [],
    );
  });

  test("37: the folders dan reaches with the right tag", async () => {
    await expectListObjectsConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "folder_d4g",
        relation: "can_view",
        subjectType: "user_d4g",
        subjectId: uuid("dan"),
        context: PROD_TAGS,
      },
      [uuid("f_team")],
    );
  });

  test("38: and none with the wrong one", async () => {
    await expectListObjectsConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "folder_d4g",
        relation: "can_view",
        subjectType: "user_d4g",
        subjectId: uuid("dan"),
        context: DEV_TAGS,
      },
      [],
    );
  });

  test("39: the buckets carol may write", async () => {
    await expectListObjectsConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "bucket_d4g",
        relation: "can_write",
        subjectType: "user_d4g",
        subjectId: uuid("carol"),
      },
      [uuid("b_logs")],
    );
  });

  test("40: a contextual project grant widens listObjects", async () => {
    await expectListObjectsConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "bucket_d4g",
        relation: "can_read",
        subjectType: "user_d4g",
        subjectId: uuid("zed"),
        contextualTuples: [
          {
            objectType: "project_d4g",
            objectId: uuid("p_web"),
            relation: "viewer",
            subjectType: "user_d4g",
            subjectId: uuid("zed"),
          },
        ],
      },
      [uuid("b_logs")],
    );
  });

  // --- checkMany over one scope ---

  test("41: a batch mixing subjects, contexts and arms", async () => {
    const items = [
      {
        objectType: "bucket_d4g",
        objectId: uuid("b_logs"),
        relation: "can_read",
        subjectType: "user_d4g",
        subjectId: uuid("alice"),
      },
      {
        objectType: "bucket_d4g",
        objectId: uuid("b_raw"),
        relation: "can_read",
        subjectType: "user_d4g",
        subjectId: uuid("alice"),
      },
      {
        objectType: "bucket_d4g",
        objectId: uuid("b_logs"),
        relation: "can_read",
        subjectType: "user_d4g",
        subjectId: uuid("svc"),
        context: SVC,
      },
      {
        objectType: "bucket_d4g",
        objectId: uuid("b_logs"),
        relation: "can_read",
        subjectType: "user_d4g",
        subjectId: uuid("svc"),
        context: { principal: "nope@ex.io" },
      },
      {
        objectType: "folder_d4g",
        objectId: uuid("f_team"),
        relation: "can_view",
        subjectType: "user_d4g",
        subjectId: uuid("dan"),
        context: PROD_TAGS,
      },
      {
        objectType: "folder_d4g",
        objectId: uuid("f_team"),
        relation: "can_view",
        subjectType: "user_d4g",
        subjectId: uuid("bob"),
      },
      {
        objectType: "bucket_d4g",
        objectId: uuid("b_logs"),
        relation: "can_write",
        subjectType: "user_d4g",
        subjectId: uuid("erin"),
        context: IN_WINDOW,
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
    expect(mine).toEqual([true, false, true, false, true, false, true]);
  });

  // --- The write gate ---

  test("42: a quarantine is a wildcard, never a person", async () => {
    await expectWriteConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "bucket_d4g",
        objectId: uuid("b_logs"),
        relation: "quarantined",
        subjectType: "user_d4g",
        subjectId: uuid("zed"),
      },
      "refused",
    );
  });

  test("43: a writer row must carry its window", async () => {
    await expectWriteConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "bucket_d4g",
        objectId: uuid("b_logs"),
        relation: "writer",
        subjectType: "user_d4g",
        subjectId: uuid("zed"),
      },
      "refused",
    );
  });

  test("44: a reader row may be unconditioned or conditioned", async () => {
    await expectWriteConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "bucket_d4g",
        objectId: uuid("b_logs"),
        relation: "reader",
        subjectType: "user_d4g",
        subjectId: uuid("zed"),
      },
      "accepted",
    );
    await expectWriteConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "bucket_d4g",
        objectId: uuid("b_raw"),
        relation: "reader",
        subjectType: "user_d4g",
        subjectId: uuid("zed"),
        conditionName: "svc_account_d4g",
      },
      "accepted",
    );
  });

  test("45: but not one borrowing the wrong condition", async () => {
    await expectWriteConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "bucket_d4g",
        objectId: uuid("b_logs"),
        relation: "reader",
        subjectType: "user_d4g",
        subjectId: uuid("zed"),
        conditionName: "in_window_d4g",
      },
      "refused",
    );
  });

  test("46: a project owner may not be a group", async () => {
    await expectWriteConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "project_d4g",
        objectId: uuid("p_web"),
        relation: "owner",
        subjectType: "group_d4g",
        subjectId: uuid("g_eng"),
        subjectRelation: "member",
      },
      "refused",
    );
  });

  test("47: a folder's org parent may not be a folder", async () => {
    await expectWriteConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "folder_d4g",
        objectId: uuid("f_team"),
        relation: "parent_org",
        subjectType: "folder_d4g",
        subjectId: uuid("f_prod"),
      },
      "refused",
    );
  });

  test("48: nothing may be written on a computed relation", async () => {
    await expectWriteConformance(
      storeId,
      authorizationModelId,
      tsfga,
      {
        objectType: "bucket_d4g",
        objectId: uuid("b_logs"),
        relation: "can_read",
        subjectType: "user_d4g",
        subjectId: uuid("zed"),
      },
      "refused",
    );
  });

  // --- Revocation ---

  test("49: revoking the deny gives bob the whole tree back", async () => {
    await revoke({
      objectType: "folder_d4g",
      objectId: uuid("f_prod"),
      relation: "denied",
      subjectType: "user_d4g",
      subjectId: uuid("bob"),
    });
    await can("folder_d4g", "f_prod", "can_view", "bob", true);
    await can("folder_d4g", "f_team", "can_view", "bob", true);
    await can("project_d4g", "p_web", "can_view", "bob", true);
    await can("bucket_d4g", "b_logs", "can_read", "bob", true);
  });

  test("50: revoking the nested group edge cuts alice off", async () => {
    await revoke({
      objectType: "group_d4g",
      objectId: uuid("g_eng"),
      relation: "member",
      subjectType: "group_d4g",
      subjectId: uuid("g_sre"),
      subjectRelation: "member",
    });
    await can("org_d4g", "acme", "can_view", "alice", false);
    await can("project_d4g", "p_web", "can_view", "alice", false);
    // The bucket reader row is written on g_sre#member directly,
    // so it survives the edge that was cut above it.
    await can("bucket_d4g", "b_logs", "can_read", "alice", true);
  });

  test("51: revoking the quarantine reopens the bucket", async () => {
    await revoke({
      objectType: "bucket_d4g",
      objectId: uuid("b_raw"),
      relation: "quarantined",
      subjectType: "user_d4g",
      subjectId: "*",
    });
    await can("bucket_d4g", "b_raw", "can_read", "carol", true);
  });

  test("the relation configs say what the model says", () => {
    expectConfigsMatchModel("./gcloud/model.dsl", fixture, {
      coverage: "complete",
    });
  });
});
