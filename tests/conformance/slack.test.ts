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

// Deterministic UUIDs for name -> UUID mapping
// Using v4-like format but deterministic for reproducibility
const uuidMap = new Map<string, string>([
  ["sandcastle", "00000000-0000-4000-a000-000000000001"],
  ["amy", "00000000-0000-4000-a000-000000000002"],
  ["bob", "00000000-0000-4000-a000-000000000003"],
  ["catherine", "00000000-0000-4000-a000-000000000004"],
  ["david", "00000000-0000-4000-a000-000000000005"],
  ["emily", "00000000-0000-4000-a000-000000000006"],
  ["general", "00000000-0000-4000-a000-000000000007"],
  ["marketing_internal", "00000000-0000-4000-a000-000000000008"],
  ["proj_marketing_campaign", "00000000-0000-4000-a000-000000000009"],
]);

function uuid(name: string): string {
  const id = uuidMap.get(name);
  if (!id) throw new Error(`No UUID for ${name}`);
  return id;
}

describe("Slack Model Conformance", () => {
  let db: Kysely<DB>;
  let storeId: string;
  let authorizationModelId: string;
  let tsfgaClient: TsfgaClient;

  beforeAll(async () => {
    db = getDb();
    await beginTransaction(db);

    const store = new KyselyTupleStore(db);
    tsfgaClient = createTsfga(store);

    // Write relation configs matching the Slack model
    await tsfgaClient.writeRelationConfig({
      objectType: "workspace",
      relation: "legacy_admin",
      directlyAssignable: ["user"],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });
    await tsfgaClient.writeRelationConfig({
      objectType: "workspace",
      relation: "channels_admin",
      directlyAssignable: ["user"],
      impliedBy: ["legacy_admin"],
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });
    await tsfgaClient.writeRelationConfig({
      objectType: "workspace",
      relation: "member",
      directlyAssignable: ["user"],
      impliedBy: ["channels_admin"],
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });
    await tsfgaClient.writeRelationConfig({
      objectType: "workspace",
      relation: "guest",
      directlyAssignable: ["user"],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });
    await tsfgaClient.writeRelationConfig({
      objectType: "channel",
      relation: "writer",
      directlyAssignable: ["user", "workspace#member"],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });
    await tsfgaClient.writeRelationConfig({
      objectType: "channel",
      relation: "commenter",
      directlyAssignable: ["user", "workspace#member"],
      impliedBy: ["writer"],
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });

    // Write tuples using UUIDs
    // Workspace roles
    await tsfgaClient.addTuple({
      objectType: "workspace",
      objectId: uuid("sandcastle"),
      relation: "legacy_admin",
      subjectType: "user",
      subjectId: uuid("amy"),
    });
    await tsfgaClient.addTuple({
      objectType: "workspace",
      objectId: uuid("sandcastle"),
      relation: "channels_admin",
      subjectType: "user",
      subjectId: uuid("bob"),
    });
    await tsfgaClient.addTuple({
      objectType: "workspace",
      objectId: uuid("sandcastle"),
      relation: "member",
      subjectType: "user",
      subjectId: uuid("catherine"),
    });
    await tsfgaClient.addTuple({
      objectType: "workspace",
      objectId: uuid("sandcastle"),
      relation: "guest",
      subjectType: "user",
      subjectId: uuid("david"),
    });
    await tsfgaClient.addTuple({
      objectType: "workspace",
      objectId: uuid("sandcastle"),
      relation: "member",
      subjectType: "user",
      subjectId: uuid("emily"),
    });

    // Channel: general
    await tsfgaClient.addTuple({
      objectType: "channel",
      objectId: uuid("general"),
      relation: "writer",
      subjectType: "user",
      subjectId: uuid("emily"),
    });

    // Channel: marketing_internal
    await tsfgaClient.addTuple({
      objectType: "channel",
      objectId: uuid("marketing_internal"),
      relation: "writer",
      subjectType: "user",
      subjectId: uuid("bob"),
    });
    await tsfgaClient.addTuple({
      objectType: "channel",
      objectId: uuid("marketing_internal"),
      relation: "writer",
      subjectType: "user",
      subjectId: uuid("emily"),
    });

    // Channel: proj_marketing_campaign
    await tsfgaClient.addTuple({
      objectType: "channel",
      objectId: uuid("proj_marketing_campaign"),
      relation: "writer",
      subjectType: "user",
      subjectId: uuid("david"),
    });
    await tsfgaClient.addTuple({
      objectType: "channel",
      objectId: uuid("proj_marketing_campaign"),
      relation: "writer",
      subjectType: "user",
      subjectId: uuid("emily"),
    });
    // Userset: workspace:sandcastle#member
    await tsfgaClient.addTuple({
      objectType: "channel",
      objectId: uuid("proj_marketing_campaign"),
      relation: "writer",
      subjectType: "workspace",
      subjectId: uuid("sandcastle"),
      subjectRelation: "member",
    });

    // Setup OpenFGA
    storeId = await fgaCreateStore("slack-conformance");
    authorizationModelId = await fgaWriteModel(storeId, "./slack/model.dsl");
    await fgaWriteTuples(
      storeId,
      "./slack/tuples.yaml",
      authorizationModelId,
      uuidMap,
    );
  });

  afterAll(async () => {
    await rollbackTransaction(db);
    await destroyDb();
  });

  // Workspace role checks

  test("1: amy is legacy_admin of workspace:sandcastle", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "workspace",
        objectId: uuid("sandcastle"),
        relation: "legacy_admin",
        subjectType: "user",
        subjectId: uuid("amy"),
      },
      true,
    );
  });

  test("2: amy is member via inheritance chain", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "workspace",
        objectId: uuid("sandcastle"),
        relation: "member",
        subjectType: "user",
        subjectId: uuid("amy"),
      },
      true,
    );
  });

  test("3: bob is channels_admin", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "workspace",
        objectId: uuid("sandcastle"),
        relation: "channels_admin",
        subjectType: "user",
        subjectId: uuid("bob"),
      },
      true,
    );
  });

  test("4: bob is member via channels_admin", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "workspace",
        objectId: uuid("sandcastle"),
        relation: "member",
        subjectType: "user",
        subjectId: uuid("bob"),
      },
      true,
    );
  });

  test("5: catherine is direct member", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "workspace",
        objectId: uuid("sandcastle"),
        relation: "member",
        subjectType: "user",
        subjectId: uuid("catherine"),
      },
      true,
    );
  });

  test("6: david is NOT member", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "workspace",
        objectId: uuid("sandcastle"),
        relation: "member",
        subjectType: "user",
        subjectId: uuid("david"),
      },
      false,
    );
  });

  test("7: emily is direct member", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "workspace",
        objectId: uuid("sandcastle"),
        relation: "member",
        subjectType: "user",
        subjectId: uuid("emily"),
      },
      true,
    );
  });

  // Channel: general

  test("8: emily is writer on #general", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "channel",
        objectId: uuid("general"),
        relation: "writer",
        subjectType: "user",
        subjectId: uuid("emily"),
      },
      true,
    );
  });

  test("9: david is NOT writer on #general", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "channel",
        objectId: uuid("general"),
        relation: "writer",
        subjectType: "user",
        subjectId: uuid("david"),
      },
      false,
    );
  });

  test("10: emily is commenter on #general (writer implies commenter)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "channel",
        objectId: uuid("general"),
        relation: "commenter",
        subjectType: "user",
        subjectId: uuid("emily"),
      },
      true,
    );
  });

  test("11: david is NOT commenter on #general", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "channel",
        objectId: uuid("general"),
        relation: "commenter",
        subjectType: "user",
        subjectId: uuid("david"),
      },
      false,
    );
  });

  // Channel: marketing_internal

  test("12: bob is writer on #marketing_internal", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "channel",
        objectId: uuid("marketing_internal"),
        relation: "writer",
        subjectType: "user",
        subjectId: uuid("bob"),
      },
      true,
    );
  });

  test("13: emily is writer on #marketing_internal", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "channel",
        objectId: uuid("marketing_internal"),
        relation: "writer",
        subjectType: "user",
        subjectId: uuid("emily"),
      },
      true,
    );
  });

  test("14: catherine is NOT writer on #marketing_internal", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "channel",
        objectId: uuid("marketing_internal"),
        relation: "writer",
        subjectType: "user",
        subjectId: uuid("catherine"),
      },
      false,
    );
  });

  // Channel: proj_marketing_campaign (userset expansion)

  test("15: david is writer on proj_marketing_campaign (direct)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "channel",
        objectId: uuid("proj_marketing_campaign"),
        relation: "writer",
        subjectType: "user",
        subjectId: uuid("david"),
      },
      true,
    );
  });

  test("16: emily is writer on proj_marketing_campaign (direct)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "channel",
        objectId: uuid("proj_marketing_campaign"),
        relation: "writer",
        subjectType: "user",
        subjectId: uuid("emily"),
      },
      true,
    );
  });

  test("17: catherine is writer on proj_marketing_campaign (via workspace#member)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "channel",
        objectId: uuid("proj_marketing_campaign"),
        relation: "writer",
        subjectType: "user",
        subjectId: uuid("catherine"),
      },
      true,
    );
  });

  test("18: amy is writer on proj_marketing_campaign (via inheritance + userset)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "channel",
        objectId: uuid("proj_marketing_campaign"),
        relation: "writer",
        subjectType: "user",
        subjectId: uuid("amy"),
      },
      true,
    );
  });

  test("19: bob is writer on proj_marketing_campaign (via channels_admin -> member userset)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "channel",
        objectId: uuid("proj_marketing_campaign"),
        relation: "writer",
        subjectType: "user",
        subjectId: uuid("bob"),
      },
      true,
    );
  });

  // Commenter inheritance on proj_marketing_campaign

  test("20: david is commenter on proj_marketing_campaign (writer implies commenter)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "channel",
        objectId: uuid("proj_marketing_campaign"),
        relation: "commenter",
        subjectType: "user",
        subjectId: uuid("david"),
      },
      true,
    );
  });

  test("21: catherine is commenter on proj_marketing_campaign (via userset + writer implies commenter)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "channel",
        objectId: uuid("proj_marketing_campaign"),
        relation: "commenter",
        subjectType: "user",
        subjectId: uuid("catherine"),
      },
      true,
    );
  });

  // Negative checks: guest isolation

  test("22: amy is NOT guest", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "workspace",
        objectId: uuid("sandcastle"),
        relation: "guest",
        subjectType: "user",
        subjectId: uuid("amy"),
      },
      false,
    );
  });

  test("23: david IS guest", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "workspace",
        objectId: uuid("sandcastle"),
        relation: "guest",
        subjectType: "user",
        subjectId: uuid("david"),
      },
      true,
    );
  });
});
