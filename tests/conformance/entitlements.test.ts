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

// Ref: OpenFGA sample store "entitlements"
// Tests multi-hop TTU chain: feature -> plan -> organization -> user

const uuidMap = new Map<string, string>([
  ["alice", "00000000-0000-4000-bc00-000000000001"],
  ["bob", "00000000-0000-4000-bc00-000000000002"],
  ["charlie", "00000000-0000-4000-bc00-000000000003"],
  ["acme", "00000000-0000-4000-bc00-000000000004"],
  ["globex", "00000000-0000-4000-bc00-000000000005"],
  ["initech", "00000000-0000-4000-bc00-000000000006"],
  ["free", "00000000-0000-4000-bc00-000000000007"],
  ["team", "00000000-0000-4000-bc00-000000000008"],
  ["enterprise", "00000000-0000-4000-bc00-000000000009"],
  ["issues", "00000000-0000-4000-bc00-00000000000a"],
  ["draft_prs", "00000000-0000-4000-bc00-00000000000b"],
  ["codespaces", "00000000-0000-4000-bc00-00000000000c"],
]);

function uuid(name: string): string {
  const id = uuidMap.get(name);
  if (!id) throw new Error(`No UUID for ${name}`);
  return id;
}

describe("Entitlements Model Conformance", () => {
  let db: Kysely<DB>;
  let storeId: string;
  let authorizationModelId: string;
  let tsfgaClient: TsfgaClient;

  beforeAll(async () => {
    db = getDb();
    await beginTransaction(db);

    const store = new KyselyTupleStore(db);
    tsfgaClient = createTsfga(store);

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

    // plan.subscriber
    await tsfgaClient.writeRelationConfig({
      objectType: "plan",
      relation: "subscriber",
      directlyAssignableTypes: ["organization"],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
      allowsUsersetSubjects: false,
    });

    // plan.subscriber_member: member from subscriber (TTU hop 1)
    await tsfgaClient.writeRelationConfig({
      objectType: "plan",
      relation: "subscriber_member",
      directlyAssignableTypes: null,
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: {
        tupleset: "subscriber",
        computedUserset: "member",
      },
      excludedBy: null,
      intersection: null,
      allowsUsersetSubjects: false,
    });

    // feature.associated_plan
    await tsfgaClient.writeRelationConfig({
      objectType: "feature",
      relation: "associated_plan",
      directlyAssignableTypes: ["plan"],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
      allowsUsersetSubjects: false,
    });

    // feature.can_access: subscriber_member from associated_plan (TTU hop 2)
    await tsfgaClient.writeRelationConfig({
      objectType: "feature",
      relation: "can_access",
      directlyAssignableTypes: null,
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: {
        tupleset: "associated_plan",
        computedUserset: "subscriber_member",
      },
      excludedBy: null,
      intersection: null,
      allowsUsersetSubjects: false,
    });

    // === Tuples ===

    // Organization members
    await tsfgaClient.addTuple({
      objectType: "organization",
      objectId: uuid("acme"),
      relation: "member",
      subjectType: "user",
      subjectId: uuid("alice"),
    });
    await tsfgaClient.addTuple({
      objectType: "organization",
      objectId: uuid("globex"),
      relation: "member",
      subjectType: "user",
      subjectId: uuid("bob"),
    });
    await tsfgaClient.addTuple({
      objectType: "organization",
      objectId: uuid("initech"),
      relation: "member",
      subjectType: "user",
      subjectId: uuid("charlie"),
    });

    // Plan subscriptions
    await tsfgaClient.addTuple({
      objectType: "plan",
      objectId: uuid("free"),
      relation: "subscriber",
      subjectType: "organization",
      subjectId: uuid("acme"),
    });
    await tsfgaClient.addTuple({
      objectType: "plan",
      objectId: uuid("team"),
      relation: "subscriber",
      subjectType: "organization",
      subjectId: uuid("globex"),
    });
    await tsfgaClient.addTuple({
      objectType: "plan",
      objectId: uuid("enterprise"),
      relation: "subscriber",
      subjectType: "organization",
      subjectId: uuid("initech"),
    });

    // Feature -> plan associations
    await tsfgaClient.addTuple({
      objectType: "feature",
      objectId: uuid("issues"),
      relation: "associated_plan",
      subjectType: "plan",
      subjectId: uuid("free"),
    });
    await tsfgaClient.addTuple({
      objectType: "feature",
      objectId: uuid("issues"),
      relation: "associated_plan",
      subjectType: "plan",
      subjectId: uuid("team"),
    });
    await tsfgaClient.addTuple({
      objectType: "feature",
      objectId: uuid("draft_prs"),
      relation: "associated_plan",
      subjectType: "plan",
      subjectId: uuid("team"),
    });
    await tsfgaClient.addTuple({
      objectType: "feature",
      objectId: uuid("issues"),
      relation: "associated_plan",
      subjectType: "plan",
      subjectId: uuid("enterprise"),
    });
    await tsfgaClient.addTuple({
      objectType: "feature",
      objectId: uuid("draft_prs"),
      relation: "associated_plan",
      subjectType: "plan",
      subjectId: uuid("enterprise"),
    });
    await tsfgaClient.addTuple({
      objectType: "feature",
      objectId: uuid("codespaces"),
      relation: "associated_plan",
      subjectType: "plan",
      subjectId: uuid("enterprise"),
    });

    // Setup OpenFGA
    storeId = await fgaCreateStore("entitlements-conformance");
    authorizationModelId = await fgaWriteModel(
      storeId,
      "tests/conformance/entitlements/model.dsl",
    );
    await fgaWriteTuples(
      storeId,
      "tests/conformance/entitlements/tuples.yaml",
      authorizationModelId,
      uuidMap,
    );
  });

  afterAll(async () => {
    await rollbackTransaction(db);
    await destroyDb();
  });

  // --- Free tier: alice (acme) ---
  test("1: alice can access issues (free plan)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "feature",
        objectId: uuid("issues"),
        relation: "can_access",
        subjectType: "user",
        subjectId: uuid("alice"),
      },
      true,
    );
  });

  test("2: alice cannot access draft_prs (free plan)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "feature",
        objectId: uuid("draft_prs"),
        relation: "can_access",
        subjectType: "user",
        subjectId: uuid("alice"),
      },
      false,
    );
  });

  test("3: alice cannot access codespaces (free plan)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "feature",
        objectId: uuid("codespaces"),
        relation: "can_access",
        subjectType: "user",
        subjectId: uuid("alice"),
      },
      false,
    );
  });

  // --- Team tier: bob (globex) ---
  test("4: bob can access issues (team plan)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "feature",
        objectId: uuid("issues"),
        relation: "can_access",
        subjectType: "user",
        subjectId: uuid("bob"),
      },
      true,
    );
  });

  test("5: bob can access draft_prs (team plan)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "feature",
        objectId: uuid("draft_prs"),
        relation: "can_access",
        subjectType: "user",
        subjectId: uuid("bob"),
      },
      true,
    );
  });

  test("6: bob cannot access codespaces (team plan)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "feature",
        objectId: uuid("codespaces"),
        relation: "can_access",
        subjectType: "user",
        subjectId: uuid("bob"),
      },
      false,
    );
  });

  // --- Enterprise tier: charlie (initech) ---
  test("7: charlie can access issues (enterprise plan)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "feature",
        objectId: uuid("issues"),
        relation: "can_access",
        subjectType: "user",
        subjectId: uuid("charlie"),
      },
      true,
    );
  });

  test("8: charlie can access draft_prs (enterprise plan)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "feature",
        objectId: uuid("draft_prs"),
        relation: "can_access",
        subjectType: "user",
        subjectId: uuid("charlie"),
      },
      true,
    );
  });

  test("9: charlie can access codespaces (enterprise plan)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "feature",
        objectId: uuid("codespaces"),
        relation: "can_access",
        subjectType: "user",
        subjectId: uuid("charlie"),
      },
      true,
    );
  });
});
