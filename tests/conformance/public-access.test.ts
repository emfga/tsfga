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

// Ref: https://openfga.dev/docs/modeling/public-access

const uuidMap = new Map<string, string>([
  ["alice", "00000000-0000-4000-b500-000000000001"],
  ["bob", "00000000-0000-4000-b500-000000000002"],
  ["company_psa", "00000000-0000-4000-b500-000000000003"],
  ["private_doc", "00000000-0000-4000-b500-000000000004"],
]);

function uuid(name: string): string {
  const id = uuidMap.get(name);
  if (!id) throw new Error(`No UUID for ${name}`);
  return id;
}

describe("Public Access Conformance", () => {
  let db: Kysely<DB>;
  let storeId: string;
  let authorizationModelId: string;
  let tsfgaClient: TsfgaClient;

  beforeAll(async () => {
    db = getDb();
    await beginTransaction(db);

    const store = new KyselyTupleStore(db);
    tsfgaClient = createTsfga(store);

    // Write relation configs
    await tsfgaClient.writeRelationConfig({
      objectType: "document",
      relation: "viewer",
      directlyAssignableTypes: ["user", "user:*"],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      allowsUsersetSubjects: false,
    });

    // Write tuples: user:* is viewer of document:company_psa
    await tsfgaClient.addTuple({
      objectType: "document",
      objectId: uuid("company_psa"),
      relation: "viewer",
      subjectType: "user",
      subjectId: "*",
    });

    // Setup OpenFGA
    storeId = await fgaCreateStore("public-access-conformance");
    authorizationModelId = await fgaWriteModel(
      storeId,
      "tests/conformance/public-access/model.dsl",
    );
    await fgaWriteTuples(
      storeId,
      "tests/conformance/public-access/tuples.yaml",
      authorizationModelId,
      uuidMap,
    );
  });

  afterAll(async () => {
    await rollbackTransaction(db);
    await destroyDb();
  });

  test("1: alice is viewer of document:company_psa (wildcard)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "document",
        objectId: uuid("company_psa"),
        relation: "viewer",
        subjectType: "user",
        subjectId: uuid("alice"),
      },
      true,
    );
  });

  test("2: bob is viewer of document:company_psa (wildcard)", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "document",
        objectId: uuid("company_psa"),
        relation: "viewer",
        subjectType: "user",
        subjectId: uuid("bob"),
      },
      true,
    );
  });

  test("3: alice is NOT viewer of document:private_doc", async () => {
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "document",
        objectId: uuid("private_doc"),
        relation: "viewer",
        subjectType: "user",
        subjectId: uuid("alice"),
      },
      false,
    );
  });
});
