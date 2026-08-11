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
  fgaWriteTuplesRaw,
} from "./helpers/openfga.ts";

/**
 * A relation the model does not define, on both engines.
 *
 * Upstream answers HTTP 400 `validation_error`, `invalid relation:
 * relation 'document#reviewer' not found`, and it answers that
 * before it reads anything. tsfga read a missing relation config as
 * *unrestricted*: the write path refuses such a tuple, but a row
 * already in the store on that relation was narrowed against
 * nothing, admitted, and granted.
 *
 * **The row goes in through the store.** `addTuple` refuses exactly
 * this shape, so a fixture built on the write path could not
 * contain one. A row that outlives its config is how a real
 * deployment gets here — a deleted config, an out-of-band writer, a
 * partially applied fixture.
 *
 * The second half is the boundary the first half must not cross. A
 * tuple-to-userset may name a computed relation that only *some* of
 * the tupleset's admitted types define: upstream validates the
 * model when at least one of them does
 * (`isUsersetRewriteValid`) and then **skips** the rows whose type
 * does not (`produceTTUDispatches`). So an undefined relation
 * reached through a tupleset is a `false`, not a refusal, and a fix
 * that raised on every missing config would trade a fail-open for a
 * fail-closed. Probed on v1.18.2: `document:d1#viewer` answers
 * `false` there, with the model accepted.
 */

const uuidMap = new Map<string, string>([
  ["alice", "00000000-0000-4000-d100-000000000001"],
  ["f1", "00000000-0000-4000-d100-000000000002"],
  ["o1", "00000000-0000-4000-d100-000000000003"],
  ["viaOrg", "00000000-0000-4000-d100-000000000010"],
  ["viaFolder", "00000000-0000-4000-d100-000000000011"],
]);

function uuid(name: string): string {
  const id = uuidMap.get(name);
  if (!id) throw new Error(`No UUID for ${name}`);
  return id;
}

describe("Missing Relation Config Conformance", () => {
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

    await tsfgaClient.writeRelationConfig({
      objectType: "folder",
      relation: "viewer",
      directlyAssignable: [{ type: "user" }],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });
    await tsfgaClient.writeRelationConfig({
      objectType: "org",
      relation: "member",
      directlyAssignable: [{ type: "user" }],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });
    await tsfgaClient.writeRelationConfig({
      objectType: "document",
      relation: "parent",
      directlyAssignable: [{ type: "folder" }, { type: "org" }],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });
    await tsfgaClient.writeRelationConfig({
      objectType: "document",
      relation: "viewer",
      directlyAssignable: [],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: [{ tupleset: "parent", computedUserset: "viewer" }],
      excludedBy: null,
      intersection: null,
    });

    await tsfgaClient.addTuple({
      objectType: "folder",
      objectId: uuid("f1"),
      relation: "viewer",
      subjectType: "user",
      subjectId: uuid("alice"),
    });
    await tsfgaClient.addTuple({
      objectType: "org",
      objectId: uuid("o1"),
      relation: "member",
      subjectType: "user",
      subjectId: uuid("alice"),
    });
    await tsfgaClient.addTuple({
      objectType: "document",
      objectId: uuid("viaFolder"),
      relation: "parent",
      subjectType: "folder",
      subjectId: uuid("f1"),
    });
    await tsfgaClient.addTuple({
      objectType: "document",
      objectId: uuid("viaOrg"),
      relation: "parent",
      subjectType: "org",
      subjectId: uuid("o1"),
    });

    // The row under test, and the one no public method would
    // write: `document.reviewer` has no config here and no
    // definition in the model.
    await store.insertTuple({
      objectType: "document",
      objectId: uuid("viaFolder"),
      relation: "reviewer",
      subjectType: "user",
      subjectId: uuid("alice"),
    });

    storeId = await fgaCreateStore("missing-config-conformance");
    authorizationModelId = await fgaWriteModel(
      storeId,
      "./missing-config/model.dsl",
    );
    await fgaWriteTuplesRaw(storeId, authorizationModelId, [
      {
        user: `user:${uuid("alice")}`,
        relation: "viewer",
        object: `folder:${uuid("f1")}`,
      },
      {
        user: `user:${uuid("alice")}`,
        relation: "member",
        object: `org:${uuid("o1")}`,
      },
      {
        user: `folder:${uuid("f1")}`,
        relation: "parent",
        object: `document:${uuid("viaFolder")}`,
      },
      {
        user: `org:${uuid("o1")}`,
        relation: "parent",
        object: `document:${uuid("viaOrg")}`,
      },
    ]);
  });

  afterAll(async () => {
    await rollbackTransaction(db);
    await destroyDb();
  });

  test("a relation the model does not define is refused", async () => {
    // The stored row names `alice` on exactly this object and
    // relation, so the only thing standing between it and a grant
    // is the missing config. tsfga answered `true`.
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "document",
        objectId: uuid("viaFolder"),
        relation: "reviewer",
        subjectType: "user",
        subjectId: uuid("alice"),
      },
      "refused",
    );
  });

  test("a relation the model does define is answered", async () => {
    // The control. Without it, "refused" could become the answer
    // to every check on this store.
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "document",
        objectId: uuid("viaFolder"),
        relation: "viewer",
        subjectType: "user",
        subjectId: uuid("alice"),
      },
      true,
    );
  });

  test("a tupleset type without the computed relation denies", async () => {
    // `org` has no `viewer`, and `document.viewer` expands
    // `viewer from parent`. Upstream skips the row rather than
    // refusing the check, so this is `false` on both sides — the
    // one place a missing relation must not raise.
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "document",
        objectId: uuid("viaOrg"),
        relation: "viewer",
        subjectType: "user",
        subjectId: uuid("alice"),
      },
      false,
    );
  });

  test("the relation configs say what the model says", () => {
    expectConfigsMatchModel("./missing-config/model.dsl", fixture, {
      coverage: "complete",
    });
  });
});
