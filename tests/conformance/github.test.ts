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

// Ref: https://openfga.dev/docs/modeling/advanced/github

const uuidMap = new Map<string, string>([
  ["alice", "00000000-0000-4000-bb00-000000000001"],
  ["bob", "00000000-0000-4000-bb00-000000000002"],
  ["charlie", "00000000-0000-4000-bb00-000000000003"],
  ["diana", "00000000-0000-4000-bb00-000000000004"],
  ["eve", "00000000-0000-4000-bb00-000000000005"],
  ["acme", "00000000-0000-4000-bb00-000000000006"],
  ["backend", "00000000-0000-4000-bb00-000000000007"],
  ["frontend", "00000000-0000-4000-bb00-000000000008"],
  ["platform", "00000000-0000-4000-bb00-000000000009"],
  ["api", "00000000-0000-4000-bb00-00000000000a"],
]);

function uuid(name: string): string {
  const id = uuidMap.get(name);
  if (!id) throw new Error(`No UUID for ${name}`);
  return id;
}

describe("GitHub Model Conformance", () => {
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

    // organization.repo_admin
    await tsfgaClient.writeRelationConfig({
      objectType: "organization",
      relation: "repo_admin",
      directlyAssignableTypes: ["user"],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
      allowsUsersetSubjects: false,
    });

    // organization.repo_reader
    await tsfgaClient.writeRelationConfig({
      objectType: "organization",
      relation: "repo_reader",
      directlyAssignableTypes: ["user"],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
      allowsUsersetSubjects: false,
    });

    // team.member: [user, team#member]
    await tsfgaClient.writeRelationConfig({
      objectType: "team",
      relation: "member",
      directlyAssignableTypes: ["user", "team"],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
      allowsUsersetSubjects: true,
    });

    // repo.organization
    await tsfgaClient.writeRelationConfig({
      objectType: "repo",
      relation: "organization",
      directlyAssignableTypes: ["organization"],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
      allowsUsersetSubjects: false,
    });

    // repo.admin: [user, team#member] or repo_admin from organization
    // Use helper for TTU path + direct/userset via impliedBy
    await tsfgaClient.writeRelationConfig({
      objectType: "repo",
      relation: "_admin_from_org",
      directlyAssignableTypes: null,
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: {
        tupleset: "organization",
        computedUserset: "repo_admin",
      },
      excludedBy: null,
      intersection: null,
      allowsUsersetSubjects: false,
    });

    await tsfgaClient.writeRelationConfig({
      objectType: "repo",
      relation: "admin",
      directlyAssignableTypes: ["user", "team"],
      impliedBy: ["_admin_from_org"],
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
      allowsUsersetSubjects: true,
    });

    // repo.maintainer: [user, team#member] or admin
    await tsfgaClient.writeRelationConfig({
      objectType: "repo",
      relation: "maintainer",
      directlyAssignableTypes: ["user", "team"],
      impliedBy: ["admin"],
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
      allowsUsersetSubjects: true,
    });

    // repo.writer: [user, team#member] or maintainer
    await tsfgaClient.writeRelationConfig({
      objectType: "repo",
      relation: "writer",
      directlyAssignableTypes: ["user", "team"],
      impliedBy: ["maintainer"],
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
      allowsUsersetSubjects: true,
    });

    // repo.triager: [user, team#member] or writer
    await tsfgaClient.writeRelationConfig({
      objectType: "repo",
      relation: "triager",
      directlyAssignableTypes: ["user", "team"],
      impliedBy: ["writer"],
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
      allowsUsersetSubjects: true,
    });

    // repo.reader: [user, team#member] or triager or repo_reader from organization
    await tsfgaClient.writeRelationConfig({
      objectType: "repo",
      relation: "_reader_from_org",
      directlyAssignableTypes: null,
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: {
        tupleset: "organization",
        computedUserset: "repo_reader",
      },
      excludedBy: null,
      intersection: null,
      allowsUsersetSubjects: false,
    });

    await tsfgaClient.writeRelationConfig({
      objectType: "repo",
      relation: "reader",
      directlyAssignableTypes: ["user", "team"],
      impliedBy: ["triager", "_reader_from_org"],
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
      allowsUsersetSubjects: true,
    });

    // === Tuples ===

    // Org members
    await tsfgaClient.addTuple({
      objectType: "organization",
      objectId: uuid("acme"),
      relation: "member",
      subjectType: "user",
      subjectId: uuid("alice"),
    });
    await tsfgaClient.addTuple({
      objectType: "organization",
      objectId: uuid("acme"),
      relation: "member",
      subjectType: "user",
      subjectId: uuid("bob"),
    });
    await tsfgaClient.addTuple({
      objectType: "organization",
      objectId: uuid("acme"),
      relation: "member",
      subjectType: "user",
      subjectId: uuid("charlie"),
    });

    // Org-level repo_reader
    await tsfgaClient.addTuple({
      objectType: "organization",
      objectId: uuid("acme"),
      relation: "repo_reader",
      subjectType: "user",
      subjectId: uuid("diana"),
    });

    // Teams
    await tsfgaClient.addTuple({
      objectType: "team",
      objectId: uuid("backend"),
      relation: "member",
      subjectType: "user",
      subjectId: uuid("alice"),
    });
    await tsfgaClient.addTuple({
      objectType: "team",
      objectId: uuid("frontend"),
      relation: "member",
      subjectType: "user",
      subjectId: uuid("bob"),
    });
    // platform team nests backend team
    await tsfgaClient.addTuple({
      objectType: "team",
      objectId: uuid("platform"),
      relation: "member",
      subjectType: "team",
      subjectId: uuid("backend"),
      subjectRelation: "member",
    });

    // Repo: acme/api
    await tsfgaClient.addTuple({
      objectType: "repo",
      objectId: uuid("api"),
      relation: "organization",
      subjectType: "organization",
      subjectId: uuid("acme"),
    });
    // charlie is direct admin
    await tsfgaClient.addTuple({
      objectType: "repo",
      objectId: uuid("api"),
      relation: "admin",
      subjectType: "user",
      subjectId: uuid("charlie"),
    });
    // backend team members are writers
    await tsfgaClient.addTuple({
      objectType: "repo",
      objectId: uuid("api"),
      relation: "writer",
      subjectType: "team",
      subjectId: uuid("backend"),
      subjectRelation: "member",
    });
    // frontend team members are readers
    await tsfgaClient.addTuple({
      objectType: "repo",
      objectId: uuid("api"),
      relation: "reader",
      subjectType: "team",
      subjectId: uuid("frontend"),
      subjectRelation: "member",
    });

    // Setup OpenFGA
    storeId = await fgaCreateStore("github-conformance");
    authorizationModelId = await fgaWriteModel(
      storeId,
      "tests/conformance/github/model.dsl",
    );
    await fgaWriteTuples(
      storeId,
      "tests/conformance/github/tuples.yaml",
      authorizationModelId,
      uuidMap,
    );
  });

  afterAll(async () => {
    await rollbackTransaction(db);
    await destroyDb();
  });

  // --- Direct access ---
  test("1: charlie is admin of repo:api (direct)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "repo",
        objectId: uuid("api"),
        relation: "admin",
        subjectType: "user",
        subjectId: uuid("charlie"),
      },
      true,
    );
  });

  // --- Team-based access ---
  test("2: alice is writer of repo:api (via team:backend#member)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "repo",
        objectId: uuid("api"),
        relation: "writer",
        subjectType: "user",
        subjectId: uuid("alice"),
      },
      true,
    );
  });

  test("3: bob is reader of repo:api (via team:frontend#member)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "repo",
        objectId: uuid("api"),
        relation: "reader",
        subjectType: "user",
        subjectId: uuid("bob"),
      },
      true,
    );
  });

  // --- Concentric inheritance ---
  test("4: charlie is reader of repo:api (admin implies reader)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "repo",
        objectId: uuid("api"),
        relation: "reader",
        subjectType: "user",
        subjectId: uuid("charlie"),
      },
      true,
    );
  });

  test("5: alice is reader of repo:api (writer implies reader)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "repo",
        objectId: uuid("api"),
        relation: "reader",
        subjectType: "user",
        subjectId: uuid("alice"),
      },
      true,
    );
  });

  // --- Nested team resolution ---
  test("6: alice is member of team:platform (via nested team:backend#member)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "team",
        objectId: uuid("platform"),
        relation: "member",
        subjectType: "user",
        subjectId: uuid("alice"),
      },
      true,
    );
  });

  test("7: bob is NOT member of team:platform", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "team",
        objectId: uuid("platform"),
        relation: "member",
        subjectType: "user",
        subjectId: uuid("bob"),
      },
      false,
    );
  });

  // --- Org-level reader via TTU ---
  test("8: diana is reader of repo:api (via org repo_reader TTU)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "repo",
        objectId: uuid("api"),
        relation: "reader",
        subjectType: "user",
        subjectId: uuid("diana"),
      },
      true,
    );
  });

  // --- Negative cases ---
  test("9: bob is NOT writer of repo:api (only reader)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "repo",
        objectId: uuid("api"),
        relation: "writer",
        subjectType: "user",
        subjectId: uuid("bob"),
      },
      false,
    );
  });

  test("10: diana is NOT writer of repo:api (org reader only)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "repo",
        objectId: uuid("api"),
        relation: "writer",
        subjectType: "user",
        subjectId: uuid("diana"),
      },
      false,
    );
  });

  test("11: eve has no access to repo:api", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "repo",
        objectId: uuid("api"),
        relation: "reader",
        subjectType: "user",
        subjectId: uuid("eve"),
      },
      false,
    );
  });

  test("12: alice is NOT admin of repo:api (writer, not admin)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "repo",
        objectId: uuid("api"),
        relation: "admin",
        subjectType: "user",
        subjectId: uuid("alice"),
      },
      false,
    );
  });
});
