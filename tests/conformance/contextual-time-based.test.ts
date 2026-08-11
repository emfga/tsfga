import { afterAll, beforeAll, describe, test } from "bun:test";
import { createTsfga, type TsfgaClient } from "@tsfga/core";
import type { DB } from "@tsfga/kysely";
import { KyselyTupleStore } from "@tsfga/kysely";
import type { Kysely } from "kysely";
import {
  expectConfigsMatchModel,
  expectConformance,
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

// Ref: https://openfga.dev/docs/modeling/contextual-time-based-authorization

const uuidMap = new Map<string, string>([
  ["anne", "00000000-0000-4000-b900-000000000001"],
  ["caroline", "00000000-0000-4000-b900-000000000002"],
  ["mary", "00000000-0000-4000-b900-000000000003"],
  ["west_side", "00000000-0000-4000-b900-000000000004"],
  ["east_side", "00000000-0000-4000-b900-000000000005"],
  ["checking_526", "00000000-0000-4000-b900-000000000006"],
  ["A", "00000000-0000-4000-b900-000000000007"],
  ["11_12", "00000000-0000-4000-b900-000000000008"],
  ["12_13", "00000000-0000-4000-b900-000000000009"],
  ["10_0_0_0_16", "00000000-0000-4000-b900-00000000000a"],
]);

function uuid(name: string): string {
  const id = uuidMap.get(name);
  if (!id) throw new Error(`No UUID for ${name}`);
  return id;
}

describe("Contextual Time-Based Conformance", () => {
  let db: Kysely<DB>;
  let storeId: string;
  let authorizationModelId: string;
  let tsfgaClient: TsfgaClient;
  let fixture: FixtureRecord;

  beforeAll(async () => {
    db = getDb();
    await beginTransaction(db);

    const store = new KyselyTupleStore(db);
    tsfgaClient = createTsfga(store);
    fixture = recordFixture(tsfgaClient);

    // === Relation configs ===

    // timeslot.user
    await tsfgaClient.writeRelationConfig({
      objectType: "timeslot",
      relation: "user",
      directlyAssignable: ["user"],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });

    // ip-address-range.user
    await tsfgaClient.writeRelationConfig({
      objectType: "ip-address-range",
      relation: "user",
      directlyAssignable: ["user"],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });

    // branch.account_manager
    await tsfgaClient.writeRelationConfig({
      objectType: "branch",
      relation: "account_manager",
      directlyAssignable: ["user"],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });

    // branch.approved_ip_address_range
    await tsfgaClient.writeRelationConfig({
      objectType: "branch",
      relation: "approved_ip_address_range",
      directlyAssignable: ["ip-address-range"],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });

    // branch.approved_timeslot
    await tsfgaClient.writeRelationConfig({
      objectType: "branch",
      relation: "approved_timeslot",
      directlyAssignable: ["timeslot"],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });

    // branch.approved_context: user from approved_timeslot and user from approved_ip_address_range
    await tsfgaClient.writeRelationConfig({
      objectType: "branch",
      relation: "approved_context",
      directlyAssignable: [],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: [
        {
          type: "tupleToUserset",
          tupleset: "approved_timeslot",
          computedUserset: "user",
        },
        {
          type: "tupleToUserset",
          tupleset: "approved_ip_address_range",
          computedUserset: "user",
        },
      ],
    });

    // account.branch
    await tsfgaClient.writeRelationConfig({
      objectType: "account",
      relation: "branch",
      directlyAssignable: ["branch"],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });

    // account.account_manager: account_manager from branch (TTU)
    await tsfgaClient.writeRelationConfig({
      objectType: "account",
      relation: "account_manager",
      directlyAssignable: [],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: [
        { tupleset: "branch", computedUserset: "account_manager" },
      ],
      excludedBy: null,
      intersection: null,
    });

    // account.customer
    await tsfgaClient.writeRelationConfig({
      objectType: "account",
      relation: "customer",
      directlyAssignable: ["user"],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });

    // account.account_manager_viewer: account_manager and approved_context from branch
    await tsfgaClient.writeRelationConfig({
      objectType: "account",
      relation: "account_manager_viewer",
      directlyAssignable: [],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: [
        { type: "computedUserset", relation: "account_manager" },
        {
          type: "tupleToUserset",
          tupleset: "branch",
          computedUserset: "approved_context",
        },
      ],
    });

    // account.viewer: customer or account_manager_viewer
    await tsfgaClient.writeRelationConfig({
      objectType: "account",
      relation: "viewer",
      directlyAssignable: [],
      impliedBy: ["customer", "account_manager_viewer"],
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });

    // account.can_view: viewer (computed userset)
    await tsfgaClient.writeRelationConfig({
      objectType: "account",
      relation: "can_view",
      directlyAssignable: [],
      impliedBy: null,
      computedUserset: "viewer",
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });

    // transaction.account
    await tsfgaClient.writeRelationConfig({
      objectType: "transaction",
      relation: "account",
      directlyAssignable: ["account"],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });

    // transaction.can_view: viewer from account (TTU)
    await tsfgaClient.writeRelationConfig({
      objectType: "transaction",
      relation: "can_view",
      directlyAssignable: [],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: [{ tupleset: "account", computedUserset: "viewer" }],
      excludedBy: null,
      intersection: null,
    });

    // === Tuples ===
    await tsfgaClient.addTuple({
      objectType: "branch",
      objectId: uuid("west_side"),
      relation: "account_manager",
      subjectType: "user",
      subjectId: uuid("anne"),
    });
    await tsfgaClient.addTuple({
      objectType: "branch",
      objectId: uuid("east_side"),
      relation: "account_manager",
      subjectType: "user",
      subjectId: uuid("mary"),
    });
    await tsfgaClient.addTuple({
      objectType: "account",
      objectId: uuid("checking_526"),
      relation: "customer",
      subjectType: "user",
      subjectId: uuid("caroline"),
    });
    await tsfgaClient.addTuple({
      objectType: "account",
      objectId: uuid("checking_526"),
      relation: "branch",
      subjectType: "branch",
      subjectId: uuid("west_side"),
    });
    await tsfgaClient.addTuple({
      objectType: "transaction",
      objectId: uuid("A"),
      relation: "account",
      subjectType: "account",
      subjectId: uuid("checking_526"),
    });
    await tsfgaClient.addTuple({
      objectType: "branch",
      objectId: uuid("west_side"),
      relation: "approved_timeslot",
      subjectType: "timeslot",
      subjectId: uuid("11_12"),
    });
    await tsfgaClient.addTuple({
      objectType: "branch",
      objectId: uuid("west_side"),
      relation: "approved_timeslot",
      subjectType: "timeslot",
      subjectId: uuid("12_13"),
    });
    await tsfgaClient.addTuple({
      objectType: "branch",
      objectId: uuid("west_side"),
      relation: "approved_ip_address_range",
      subjectType: "ip-address-range",
      subjectId: uuid("10_0_0_0_16"),
    });

    // Setup OpenFGA
    storeId = await fgaCreateStore("contextual-time-based-conformance");
    authorizationModelId = await fgaWriteModel(
      storeId,
      "./contextual-time-based/model.dsl",
    );
    await fgaWriteTuples(
      storeId,
      "./contextual-time-based/tuples.yaml",
      authorizationModelId,
      uuidMap,
    );
  });

  afterAll(async () => {
    await rollbackTransaction(db);
    await destroyDb();
  });

  test("1: anne cannot view transaction:A without context", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "transaction",
        objectId: uuid("A"),
        relation: "can_view",
        subjectType: "user",
        subjectId: uuid("anne"),
      },
      false,
    );
  });

  test("2: anne can view transaction:A with IP + timeslot context", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "transaction",
        objectId: uuid("A"),
        relation: "can_view",
        subjectType: "user",
        subjectId: uuid("anne"),
        contextualTuples: [
          {
            objectType: "ip-address-range",
            objectId: uuid("10_0_0_0_16"),
            relation: "user",
            subjectType: "user",
            subjectId: uuid("anne"),
          },
          {
            objectType: "timeslot",
            objectId: uuid("12_13"),
            relation: "user",
            subjectType: "user",
            subjectId: uuid("anne"),
          },
        ],
      },
      true,
    );
  });

  test("3: caroline can view transaction:A (customer, no context needed)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "transaction",
        objectId: uuid("A"),
        relation: "can_view",
        subjectType: "user",
        subjectId: uuid("caroline"),
      },
      true,
    );
  });

  test("4: mary cannot view transaction:A (wrong branch)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "transaction",
        objectId: uuid("A"),
        relation: "can_view",
        subjectType: "user",
        subjectId: uuid("mary"),
      },
      false,
    );
  });

  test("the relation configs say what the model says", () => {
    expectConfigsMatchModel("./contextual-time-based/model.dsl", fixture, {
      coverage: "complete",
    });
  });
});
