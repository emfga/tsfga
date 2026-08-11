import { afterAll, beforeAll, describe, test } from "bun:test";
import type { TsfgaClient } from "@tsfga/core";
import type { DB } from "@tsfga/kysely";
import type { Kysely } from "kysely";
import { setupGdrive, teardownGdrive, uuid } from "./gdrive/setup.ts";
import {
  expectConfigsMatchModel,
  expectConformance,
  type FixtureRecord,
} from "./helpers/conformance.ts";

describe("Google Drive Model Conformance", () => {
  let db: Kysely<DB>;
  let storeId: string;
  let authorizationModelId: string;
  let tsfgaClient: TsfgaClient;
  let fixture: FixtureRecord;

  beforeAll(async () => {
    ({ db, storeId, authorizationModelId, tsfgaClient, fixture } =
      await setupGdrive());
  });

  afterAll(async () => {
    await teardownGdrive(db);
  });

  // --- Direct owner permissions ---
  test("1: bob can_write doc:design (direct owner)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "doc",
        objectId: uuid("design"),
        relation: "can_write",
        subjectType: "user",
        subjectId: uuid("bob"),
      },
      true,
    );
  });

  test("2: bob can_change_owner doc:design (owner)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "doc",
        objectId: uuid("design"),
        relation: "can_change_owner",
        subjectType: "user",
        subjectId: uuid("bob"),
      },
      true,
    );
  });

  // --- Folder owner inherits to doc via TTU ---
  test("3: alice can_read doc:design (folder:root owner via TTU)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "doc",
        objectId: uuid("design"),
        relation: "can_read",
        subjectType: "user",
        subjectId: uuid("alice"),
      },
      true,
    );
  });

  test("4: alice can_share doc:design (owner from parent TTU)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "doc",
        objectId: uuid("design"),
        relation: "can_share",
        subjectType: "user",
        subjectId: uuid("alice"),
      },
      true,
    );
  });

  // --- Public access via wildcard ---
  test("5: charlie can_read doc:public (wildcard via folder:shared)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "doc",
        objectId: uuid("public"),
        relation: "can_read",
        subjectType: "user",
        subjectId: uuid("charlie"),
      },
      true,
    );
  });

  test("6: alice can_read doc:public (wildcard, any user)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "doc",
        objectId: uuid("public"),
        relation: "can_read",
        subjectType: "user",
        subjectId: uuid("alice"),
      },
      true,
    );
  });

  // --- Group-based access ---
  test("7: alice can_read doc:private (group:engineering member)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "doc",
        objectId: uuid("private"),
        relation: "can_read",
        subjectType: "user",
        subjectId: uuid("alice"),
      },
      true,
    );
  });

  test("8: bob can_read doc:private (group:engineering member)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "doc",
        objectId: uuid("private"),
        relation: "can_read",
        subjectType: "user",
        subjectId: uuid("bob"),
      },
      true,
    );
  });

  // --- Negative: non-member cannot access private doc ---
  test("9: charlie cannot can_read doc:private (not in engineering)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "doc",
        objectId: uuid("private"),
        relation: "can_read",
        subjectType: "user",
        subjectId: uuid("charlie"),
      },
      false,
    );
  });

  // --- Negative: viewer cannot write ---
  test("10: charlie cannot can_write doc:public (viewer only)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "doc",
        objectId: uuid("public"),
        relation: "can_write",
        subjectType: "user",
        subjectId: uuid("charlie"),
      },
      false,
    );
  });

  // --- Folder owner can create files ---
  test("11: alice can_create_file folder:root (owner)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "folder",
        objectId: uuid("root"),
        relation: "can_create_file",
        subjectType: "user",
        subjectId: uuid("alice"),
      },
      true,
    );
  });

  test("12: bob cannot can_create_file folder:root (not owner)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "folder",
        objectId: uuid("root"),
        relation: "can_create_file",
        subjectType: "user",
        subjectId: uuid("bob"),
      },
      false,
    );
  });

  test("the relation configs say what the model says", () => {
    expectConfigsMatchModel("./gdrive/model.dsl", fixture, {
      coverage: "complete",
    });
  });
});
