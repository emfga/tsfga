import { afterAll, beforeAll, describe, test } from "bun:test";
import { createTsfga, type TsfgaClient } from "@tsfga/core";
import type { DB } from "@tsfga/kysely";
import { KyselyTupleStore } from "@tsfga/kysely";
import type { Kysely } from "kysely";
import { expectConformance } from "./helpers/conformance.ts";
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

// Ref: https://openfga.dev/docs/modeling/organization-context-authorization

const uuidMap = new Map<string, string>([
  ["anne", "00000000-0000-4000-ba00-000000000001"],
  ["beth", "00000000-0000-4000-ba00-000000000002"],
  ["carl", "00000000-0000-4000-ba00-000000000003"],
  ["A", "00000000-0000-4000-ba00-000000000004"],
  ["B", "00000000-0000-4000-ba00-000000000005"],
  ["C", "00000000-0000-4000-ba00-000000000006"],
  ["X", "00000000-0000-4000-ba00-000000000007"],
]);

function uuid(name: string): string {
  const id = uuidMap.get(name);
  if (!id) throw new Error(`No UUID for ${name}`);
  return id;
}

describe("Organization Context Conformance", () => {
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
      directlyAssignable: ["user"],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });

    // organization.user_in_context
    await tsfgaClient.writeRelationConfig({
      objectType: "organization",
      relation: "user_in_context",
      directlyAssignable: ["user"],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });

    // organization.project_manager: [user] and user_in_context
    await tsfgaClient.writeRelationConfig({
      objectType: "organization",
      relation: "project_manager",
      directlyAssignable: ["user"],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: [
        { type: "direct" },
        { type: "computedUserset", relation: "user_in_context" },
      ],
    });

    // organization.base_project_editor: [user] or project_manager
    await tsfgaClient.writeRelationConfig({
      objectType: "organization",
      relation: "base_project_editor",
      directlyAssignable: ["user"],
      impliedBy: ["project_manager"],
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });

    // organization.project_editor: base_project_editor and user_in_context
    await tsfgaClient.writeRelationConfig({
      objectType: "organization",
      relation: "project_editor",
      directlyAssignable: [],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: [
        { type: "computedUserset", relation: "base_project_editor" },
        { type: "computedUserset", relation: "user_in_context" },
      ],
    });

    // project.owner
    await tsfgaClient.writeRelationConfig({
      objectType: "project",
      relation: "owner",
      directlyAssignable: ["organization"],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });

    // project.partner
    await tsfgaClient.writeRelationConfig({
      objectType: "project",
      relation: "partner",
      directlyAssignable: ["organization"],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });

    // project.manager: project_manager from owner (TTU)
    await tsfgaClient.writeRelationConfig({
      objectType: "project",
      relation: "manager",
      directlyAssignable: [],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: [
        { tupleset: "owner", computedUserset: "project_manager" },
      ],
      excludedBy: null,
      intersection: null,
    });

    // project.editor: manager or project_editor from owner or project_editor from partner
    await tsfgaClient.writeRelationConfig({
      objectType: "project",
      relation: "editor",
      directlyAssignable: [],
      impliedBy: ["manager"],
      computedUserset: null,
      tupleToUserset: [
        { tupleset: "owner", computedUserset: "project_editor" },
        { tupleset: "partner", computedUserset: "project_editor" },
      ],
      excludedBy: null,
      intersection: null,
    });

    // project.can_delete: manager (computed userset)
    await tsfgaClient.writeRelationConfig({
      objectType: "project",
      relation: "can_delete",
      directlyAssignable: [],
      impliedBy: null,
      computedUserset: "manager",
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });

    // project.can_edit: editor (computed userset)
    await tsfgaClient.writeRelationConfig({
      objectType: "project",
      relation: "can_edit",
      directlyAssignable: [],
      impliedBy: null,
      computedUserset: "editor",
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });

    // project.can_view: editor (computed userset)
    await tsfgaClient.writeRelationConfig({
      objectType: "project",
      relation: "can_view",
      directlyAssignable: [],
      impliedBy: null,
      computedUserset: "editor",
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });

    // === Tuples ===
    // anne is project_manager at org A, B, C
    await tsfgaClient.addTuple({
      objectType: "organization",
      objectId: uuid("A"),
      relation: "project_manager",
      subjectType: "user",
      subjectId: uuid("anne"),
    });
    await tsfgaClient.addTuple({
      objectType: "organization",
      objectId: uuid("B"),
      relation: "project_manager",
      subjectType: "user",
      subjectId: uuid("anne"),
    });
    await tsfgaClient.addTuple({
      objectType: "organization",
      objectId: uuid("C"),
      relation: "project_manager",
      subjectType: "user",
      subjectId: uuid("anne"),
    });
    // beth is project_manager at org B
    await tsfgaClient.addTuple({
      objectType: "organization",
      objectId: uuid("B"),
      relation: "project_manager",
      subjectType: "user",
      subjectId: uuid("beth"),
    });
    // carl is project_manager at org C
    await tsfgaClient.addTuple({
      objectType: "organization",
      objectId: uuid("C"),
      relation: "project_manager",
      subjectType: "user",
      subjectId: uuid("carl"),
    });
    // org A owns project X
    await tsfgaClient.addTuple({
      objectType: "project",
      objectId: uuid("X"),
      relation: "owner",
      subjectType: "organization",
      subjectId: uuid("A"),
    });
    // org B is partner on project X
    await tsfgaClient.addTuple({
      objectType: "project",
      objectId: uuid("X"),
      relation: "partner",
      subjectType: "organization",
      subjectId: uuid("B"),
    });

    // Setup OpenFGA
    storeId = await fgaCreateStore("organization-context-conformance");
    authorizationModelId = await fgaWriteModel(
      storeId,
      "./organization-context/model.dsl",
    );
    await fgaWriteTuples(
      storeId,
      "./organization-context/tuples.yaml",
      authorizationModelId,
      uuidMap,
    );
  });

  afterAll(async () => {
    await rollbackTransaction(db);
    await destroyDb();
  });

  // Helper to create contextual tuples for org context
  function orgContext(userId: string, orgId: string) {
    return [
      {
        objectType: "organization",
        objectId: orgId,
        relation: "user_in_context",
        subjectType: "user",
        subjectId: userId,
      },
    ];
  }

  test("1: anne can_view project:X (context: org A, owner)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "project",
        objectId: uuid("X"),
        relation: "can_view",
        subjectType: "user",
        subjectId: uuid("anne"),
        contextualTuples: orgContext(uuid("anne"), uuid("A")),
      },
      true,
    );
  });

  test("2: anne can_view project:X (context: org B, partner)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "project",
        objectId: uuid("X"),
        relation: "can_view",
        subjectType: "user",
        subjectId: uuid("anne"),
        contextualTuples: orgContext(uuid("anne"), uuid("B")),
      },
      true,
    );
  });

  test("3: anne cannot can_view project:X (context: org C, not owner/partner)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "project",
        objectId: uuid("X"),
        relation: "can_view",
        subjectType: "user",
        subjectId: uuid("anne"),
        contextualTuples: orgContext(uuid("anne"), uuid("C")),
      },
      false,
    );
  });

  test("4: anne can_delete project:X (context: org A, manager via owner)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "project",
        objectId: uuid("X"),
        relation: "can_delete",
        subjectType: "user",
        subjectId: uuid("anne"),
        contextualTuples: orgContext(uuid("anne"), uuid("A")),
      },
      true,
    );
  });

  test("5: anne cannot can_delete project:X (context: org B, partner not owner)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "project",
        objectId: uuid("X"),
        relation: "can_delete",
        subjectType: "user",
        subjectId: uuid("anne"),
        contextualTuples: orgContext(uuid("anne"), uuid("B")),
      },
      false,
    );
  });

  test("6: anne cannot can_delete project:X (context: org C)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "project",
        objectId: uuid("X"),
        relation: "can_delete",
        subjectType: "user",
        subjectId: uuid("anne"),
        contextualTuples: orgContext(uuid("anne"), uuid("C")),
      },
      false,
    );
  });

  test("7: beth can_view project:X (context: org B, partner)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "project",
        objectId: uuid("X"),
        relation: "can_view",
        subjectType: "user",
        subjectId: uuid("beth"),
        contextualTuples: orgContext(uuid("beth"), uuid("B")),
      },
      true,
    );
  });

  test("8: beth cannot can_delete project:X (context: org B, partner not owner)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "project",
        objectId: uuid("X"),
        relation: "can_delete",
        subjectType: "user",
        subjectId: uuid("beth"),
        contextualTuples: orgContext(uuid("beth"), uuid("B")),
      },
      false,
    );
  });

  test("9: carl cannot can_view project:X (context: org C, not owner/partner)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "project",
        objectId: uuid("X"),
        relation: "can_view",
        subjectType: "user",
        subjectId: uuid("carl"),
        contextualTuples: orgContext(uuid("carl"), uuid("C")),
      },
      false,
    );
  });

  test("10: carl cannot can_delete project:X (context: org C)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "project",
        objectId: uuid("X"),
        relation: "can_delete",
        subjectType: "user",
        subjectId: uuid("carl"),
        contextualTuples: orgContext(uuid("carl"), uuid("C")),
      },
      false,
    );
  });
});
