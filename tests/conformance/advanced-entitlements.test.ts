import { afterAll, beforeAll, describe, test } from "bun:test";
import type { Kysely } from "kysely";
import { createTsfga, type TsfgaClient } from "src/index.ts";
import { KyselyTupleStore } from "src/store/kysely/adapter.ts";
import type { DB } from "src/store/kysely/schema.ts";
import { expectConformance } from "tests/helpers/conformance.ts";
import {
  beginTransaction,
  destroyDb,
  getDb,
  rollbackTransaction,
} from "tests/helpers/db.ts";
import {
  fgaCreateStore,
  fgaWriteModel,
  fgaWriteTuples,
} from "tests/helpers/openfga.ts";

// Ref: OpenFGA sample store "advanced-entitlements"
// Tests CEL conditions with int comparisons, multiple condition definitions,
// and TTU entitlement chain combined with condition gates

const uuidMap = new Map<string, string>([
  ["anne", "00000000-0000-4000-c000-000000000001"],
  ["beth", "00000000-0000-4000-c000-000000000002"],
  ["acme", "00000000-0000-4000-c000-000000000003"],
  ["okta", "00000000-0000-4000-c000-000000000004"],
  ["free", "00000000-0000-4000-c000-000000000005"],
  ["pro", "00000000-0000-4000-c000-000000000006"],
  ["can-view-page-history", "00000000-0000-4000-c000-000000000007"],
  ["can-invite-collaborator", "00000000-0000-4000-c000-000000000008"],
  ["can-sync-rows", "00000000-0000-4000-c000-000000000009"],
  ["basic-page-analytics", "00000000-0000-4000-c000-00000000000a"],
  ["advanced-page-analytics", "00000000-0000-4000-c000-00000000000b"],
  ["enterprise-support", "00000000-0000-4000-c000-00000000000c"],
]);

function uuid(name: string): string {
  const id = uuidMap.get(name);
  if (!id) throw new Error(`No UUID for ${name}`);
  return id;
}

describe("Advanced Entitlements Conformance", () => {
  let db: Kysely<DB>;
  let storeId: string;
  let authorizationModelId: string;
  let tsfgaClient: TsfgaClient;

  beforeAll(async () => {
    db = getDb();
    await beginTransaction(db);

    const store = new KyselyTupleStore(db);
    tsfgaClient = createTsfga(store);

    // === Condition definitions ===
    await tsfgaClient.writeConditionDefinition({
      name: "is_below_collaborator_limit",
      expression: "collaborator_count <= collaborator_limit",
      parameters: {
        collaborator_count: "int",
        collaborator_limit: "int",
      },
    });
    await tsfgaClient.writeConditionDefinition({
      name: "is_below_row_sync_limit",
      expression: "row_sync_count <= row_sync_limit",
      parameters: {
        row_sync_count: "int",
        row_sync_limit: "int",
      },
    });
    await tsfgaClient.writeConditionDefinition({
      name: "is_below_page_history_days_limit",
      expression: "page_history_days_count <= page_history_days_limit",
      parameters: {
        page_history_days_count: "int",
        page_history_days_limit: "int",
      },
    });

    // === Relation configs ===

    // organization.member
    await tsfgaClient.writeRelationConfig({
      objectType: "organization",
      relation: "member",
      directlyAssignableTypes: ["user"],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
      allowsUsersetSubjects: false,
    });

    // plan.subscriber: [organization#member]
    await tsfgaClient.writeRelationConfig({
      objectType: "plan",
      relation: "subscriber",
      directlyAssignableTypes: ["organization"],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
      allowsUsersetSubjects: true,
    });

    // feature.has_feature: [plan#subscriber, plan#subscriber with conditions]
    await tsfgaClient.writeRelationConfig({
      objectType: "feature",
      relation: "has_feature",
      directlyAssignableTypes: ["plan"],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
      allowsUsersetSubjects: true,
    });

    // === Tuples ===

    // Organization membership
    await tsfgaClient.addTuple({
      objectType: "organization",
      objectId: uuid("acme"),
      relation: "member",
      subjectType: "user",
      subjectId: uuid("anne"),
    });
    await tsfgaClient.addTuple({
      objectType: "organization",
      objectId: uuid("okta"),
      relation: "member",
      subjectType: "user",
      subjectId: uuid("beth"),
    });

    // Plan subscriptions
    await tsfgaClient.addTuple({
      objectType: "plan",
      objectId: uuid("free"),
      relation: "subscriber",
      subjectType: "organization",
      subjectId: uuid("acme"),
      subjectRelation: "member",
    });
    await tsfgaClient.addTuple({
      objectType: "plan",
      objectId: uuid("pro"),
      relation: "subscriber",
      subjectType: "organization",
      subjectId: uuid("okta"),
      subjectRelation: "member",
    });

    // Free plan features
    await tsfgaClient.addTuple({
      objectType: "feature",
      objectId: uuid("can-view-page-history"),
      relation: "has_feature",
      subjectType: "plan",
      subjectId: uuid("free"),
      subjectRelation: "subscriber",
      conditionName: "is_below_page_history_days_limit",
      conditionContext: { page_history_days_limit: 7 },
    });
    await tsfgaClient.addTuple({
      objectType: "feature",
      objectId: uuid("can-invite-collaborator"),
      relation: "has_feature",
      subjectType: "plan",
      subjectId: uuid("free"),
      subjectRelation: "subscriber",
      conditionName: "is_below_collaborator_limit",
      conditionContext: { collaborator_limit: 10 },
    });
    await tsfgaClient.addTuple({
      objectType: "feature",
      objectId: uuid("can-sync-rows"),
      relation: "has_feature",
      subjectType: "plan",
      subjectId: uuid("free"),
      subjectRelation: "subscriber",
      conditionName: "is_below_row_sync_limit",
      conditionContext: { row_sync_limit: 100 },
    });
    await tsfgaClient.addTuple({
      objectType: "feature",
      objectId: uuid("basic-page-analytics"),
      relation: "has_feature",
      subjectType: "plan",
      subjectId: uuid("free"),
      subjectRelation: "subscriber",
    });

    // Pro plan features
    await tsfgaClient.addTuple({
      objectType: "feature",
      objectId: uuid("can-view-page-history"),
      relation: "has_feature",
      subjectType: "plan",
      subjectId: uuid("pro"),
      subjectRelation: "subscriber",
      conditionName: "is_below_page_history_days_limit",
      conditionContext: { page_history_days_limit: 30 },
    });
    await tsfgaClient.addTuple({
      objectType: "feature",
      objectId: uuid("can-invite-collaborator"),
      relation: "has_feature",
      subjectType: "plan",
      subjectId: uuid("pro"),
      subjectRelation: "subscriber",
      conditionName: "is_below_collaborator_limit",
      conditionContext: { collaborator_limit: 100 },
    });
    await tsfgaClient.addTuple({
      objectType: "feature",
      objectId: uuid("can-sync-rows"),
      relation: "has_feature",
      subjectType: "plan",
      subjectId: uuid("pro"),
      subjectRelation: "subscriber",
      conditionName: "is_below_row_sync_limit",
      conditionContext: { row_sync_limit: 20000 },
    });
    await tsfgaClient.addTuple({
      objectType: "feature",
      objectId: uuid("advanced-page-analytics"),
      relation: "has_feature",
      subjectType: "plan",
      subjectId: uuid("pro"),
      subjectRelation: "subscriber",
    });
    await tsfgaClient.addTuple({
      objectType: "feature",
      objectId: uuid("enterprise-support"),
      relation: "has_feature",
      subjectType: "plan",
      subjectId: uuid("pro"),
      subjectRelation: "subscriber",
    });

    // Setup OpenFGA
    storeId = await fgaCreateStore("advanced-entitlements-conformance");
    authorizationModelId = await fgaWriteModel(
      storeId,
      "tests/conformance/advanced-entitlements/model.dsl",
    );
    await fgaWriteTuples(
      storeId,
      "tests/conformance/advanced-entitlements/tuples.yaml",
      authorizationModelId,
      uuidMap,
    );
  });

  afterAll(async () => {
    await rollbackTransaction(db);
    await destroyDb();
  });

  // --- Pro subscriber (beth): within limits ---
  test("1: beth has can-view-page-history (pro, 10 days <= 30)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "feature",
        objectId: uuid("can-view-page-history"),
        relation: "has_feature",
        subjectType: "user",
        subjectId: uuid("beth"),
        context: { page_history_days_count: 10 },
      },
      true,
    );
  });

  test("2: beth has can-invite-collaborator (pro, 20 <= 100)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "feature",
        objectId: uuid("can-invite-collaborator"),
        relation: "has_feature",
        subjectType: "user",
        subjectId: uuid("beth"),
        context: { collaborator_count: 20 },
      },
      true,
    );
  });

  test("3: beth has can-sync-rows (pro, 200 <= 20000)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "feature",
        objectId: uuid("can-sync-rows"),
        relation: "has_feature",
        subjectType: "user",
        subjectId: uuid("beth"),
        context: { row_sync_count: 200 },
      },
      true,
    );
  });

  test("4: beth has advanced-page-analytics (pro, unconditional)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "feature",
        objectId: uuid("advanced-page-analytics"),
        relation: "has_feature",
        subjectType: "user",
        subjectId: uuid("beth"),
      },
      true,
    );
  });

  test("5: beth has enterprise-support (pro, unconditional)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "feature",
        objectId: uuid("enterprise-support"),
        relation: "has_feature",
        subjectType: "user",
        subjectId: uuid("beth"),
      },
      true,
    );
  });

  // --- Free subscriber (anne): exceeding free limits ---
  test("6: anne cannot view page history (free, 10 > 7)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "feature",
        objectId: uuid("can-view-page-history"),
        relation: "has_feature",
        subjectType: "user",
        subjectId: uuid("anne"),
        context: { page_history_days_count: 10 },
      },
      false,
    );
  });

  test("7: anne cannot invite collaborator (free, 20 > 10)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "feature",
        objectId: uuid("can-invite-collaborator"),
        relation: "has_feature",
        subjectType: "user",
        subjectId: uuid("anne"),
        context: { collaborator_count: 20 },
      },
      false,
    );
  });

  // --- Free subscriber (anne): within free limits ---
  test("8: anne has can-view-page-history (free, 1 <= 7)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "feature",
        objectId: uuid("can-view-page-history"),
        relation: "has_feature",
        subjectType: "user",
        subjectId: uuid("anne"),
        context: { page_history_days_count: 1 },
      },
      true,
    );
  });

  test("9: anne has can-invite-collaborator (free, 1 <= 10)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "feature",
        objectId: uuid("can-invite-collaborator"),
        relation: "has_feature",
        subjectType: "user",
        subjectId: uuid("anne"),
        context: { collaborator_count: 1 },
      },
      true,
    );
  });

  test("10: anne has basic-page-analytics (free, unconditional)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "feature",
        objectId: uuid("basic-page-analytics"),
        relation: "has_feature",
        subjectType: "user",
        subjectId: uuid("anne"),
      },
      true,
    );
  });

  // --- Free subscriber: no pro features ---
  test("11: anne cannot access enterprise-support (free plan)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "feature",
        objectId: uuid("enterprise-support"),
        relation: "has_feature",
        subjectType: "user",
        subjectId: uuid("anne"),
      },
      false,
    );
  });
});
