import { afterAll, beforeAll, describe, test } from "bun:test";
import { createTsfga, type TsfgaClient } from "@tsfga/core";
import type { DB } from "@tsfga/kysely";
import { KyselyTupleStore } from "@tsfga/kysely";
import type { Kysely } from "kysely";
import {
  expectConfigsMatchModel,
  expectConformance,
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
import { fgaCreateStore, fgaWriteModel } from "./helpers/openfga.ts";

/**
 * A grant to the nil-UUID subject.
 *
 * OpenFGA reserves no subject id:
 * `user:00000000-0000-0000-0000-000000000000` is an ordinary
 * subject upstream, distinct from `user:*`. The Kysely adapter
 * used to disagree — `subject_id` was `uuid`-typed, so the public
 * wildcard `"*"` was stored as the nil UUID. A write both engines
 * accepted then meant two different things: the row read back as
 * the wildcard, granted every subject of its type, and stopped
 * matching the one it was written for. That is the granting
 * direction, and the widest failure there is.
 *
 * Migration `006` moves the wildcard out of the id namespace
 * entirely — `tsfga.tuples.subject_wildcard` is a boolean and
 * `subject_id` is NULL on those rows — so there is no reserved
 * value left for the bug to live in. These tests hold that shut.
 */

const NIL_UUID = "00000000-0000-0000-0000-000000000000";

const uuidMap = new Map<string, string>([
  ["alice", "00000000-0000-4000-d420-400000000001"],
  ["mixed_doc", "00000000-0000-4000-d420-400000000002"],
  ["narrow_doc", "00000000-0000-4000-d420-400000000003"],
]);

function uuid(name: string): string {
  const id = uuidMap.get(name);
  if (!id) throw new Error(`No UUID for ${name}`);
  return id;
}

describe("Nil-UUID Subject Conformance", () => {
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

    const plain = {
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    } as const;

    await tsfgaClient.writeRelationConfig({
      objectType: "doc_a3n",
      relation: "mixed",
      directlyAssignable: [
        { type: "user_a3n" },
        { type: "user_a3n", wildcard: true },
      ],
      ...plain,
    });
    await tsfgaClient.writeRelationConfig({
      objectType: "doc_a3n",
      relation: "narrow",
      directlyAssignable: [{ type: "user_a3n" }],
      ...plain,
    });

    storeId = await fgaCreateStore("nil-subject-conformance");
    authorizationModelId = await fgaWriteModel(
      storeId,
      "./nil-subject/model.dsl",
    );
  });

  afterAll(async () => {
    await rollbackTransaction(db);
    await destroyDb();
  });

  test("the nil-UUID subject is an ordinary write for both", async () => {
    await expectWriteConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "doc_a3n",
        objectId: uuid("mixed_doc"),
        relation: "mixed",
        subjectType: "user_a3n",
        subjectId: NIL_UUID,
      },
      "accepted",
    );
  });

  test("the nil-UUID subject keeps its own grant", async () => {
    // One half of the old collision: the row read back as the
    // wildcard, so the subject it was written for no longer
    // matched it.
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "doc_a3n",
        objectId: uuid("mixed_doc"),
        relation: "mixed",
        subjectType: "user_a3n",
        subjectId: NIL_UUID,
      },
      true,
    );
  });

  test("a nil-UUID grant does not grant everybody", async () => {
    // `mixed` admits `user_a3n:*`, so the check asks the store for
    // the wildcard row. The adapter used to answer with the row
    // written for the nil-UUID subject; that row grants exactly
    // one subject, here and upstream.
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "doc_a3n",
        objectId: uuid("mixed_doc"),
        relation: "mixed",
        subjectType: "user_a3n",
        subjectId: uuid("alice"),
      },
      false,
    );
  });

  test("a relation admitting no wildcard is unaffected", async () => {
    await expectWriteConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "doc_a3n",
        objectId: uuid("narrow_doc"),
        relation: "narrow",
        subjectType: "user_a3n",
        subjectId: NIL_UUID,
      },
      "accepted",
    );
    await expectConformance(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "doc_a3n",
        objectId: uuid("narrow_doc"),
        relation: "narrow",
        subjectType: "user_a3n",
        subjectId: uuid("alice"),
      },
      false,
    );
  });

  test("the relation configs say what the model says", () => {
    expectConfigsMatchModel("./nil-subject/model.dsl", fixture, {
      coverage: "complete",
    });
  });
});
