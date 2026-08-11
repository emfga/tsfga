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
import {
  fgaCreateStore,
  fgaWriteModel,
  fgaWriteTuples,
} from "./helpers/openfga.ts";

/**
 * A relation's type restrictions name the userset *relation*, so
 * `team#member` and `team#owner` are different restrictions.
 * OpenFGA enforces that twice: it refuses the write, and — the
 * half that is easy to miss — it also filters the row at check
 * time, so narrowing a relation with tuples already stored changes
 * the answer.
 *
 * Both halves are covered here, and they need each other. The
 * read-gate tests are only meaningful because the rows they turn
 * on are pushed **through the store**, not through
 * `TsfgaClient.addTuple`: once the write gate works, `addTuple`
 * refuses exactly those rows, so a suite built on it could never
 * observe a read-gate divergence. On OpenFGA's side the same
 * effect comes from writing the tuples under a wide model and then
 * checking under a narrow one.
 */

const uuidMap = new Map<string, string>([
  ["alice", "00000000-0000-4000-c900-000000000001"],
  ["bob", "00000000-0000-4000-c900-000000000002"],
  ["carol", "00000000-0000-4000-c900-000000000003"],
  ["eng", "00000000-0000-4000-c900-000000000010"],
  ["budget", "00000000-0000-4000-c900-000000000020"],
  ["roadmap", "00000000-0000-4000-c900-000000000021"],
  ["plan", "00000000-0000-4000-c900-000000000022"],
  ["charter", "00000000-0000-4000-c900-000000000023"],
  ["notice", "00000000-0000-4000-c900-000000000024"],
  ["scratch", "00000000-0000-4000-c900-000000000030"],
]);

function uuid(name: string): string {
  const id = uuidMap.get(name);
  if (!id) throw new Error(`No UUID for ${name}`);
  return id;
}

describe("Userset Type Restriction Conformance", () => {
  let db: Kysely<DB>;
  let storeId: string;
  let narrowModelId: string;
  let tsfgaClient: TsfgaClient;
  let fixture: FixtureRecord;

  beforeAll(async () => {
    db = getDb();
    await beginTransaction(db);

    const store = new KyselyTupleStore(db);
    tsfgaClient = createTsfga(store);
    fixture = recordFixture(tsfgaClient);

    // tsfga has no model versioning, so it is configured with the
    // narrow model directly and the inadmissible rows are pushed
    // past validation below — the same end state OpenFGA reaches
    // by writing wide and then narrowing.
    for (const relation of ["member", "owner"]) {
      await tsfgaClient.writeRelationConfig({
        objectType: "team",
        relation,
        directlyAssignable: [{ type: "user" }],
        impliedBy: null,
        computedUserset: null,
        tupleToUserset: null,
        excludedBy: null,
        intersection: null,
      });
    }
    await tsfgaClient.writeRelationConfig({
      objectType: "document",
      relation: "viewer",
      directlyAssignable: [
        { type: "user" },
        { type: "team", relation: "member" },
      ],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });
    await tsfgaClient.writeRelationConfig({
      objectType: "document",
      relation: "editor",
      directlyAssignable: [
        { type: "team", relation: "member" },
        { type: "team", relation: "owner" },
      ],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });
    await tsfgaClient.writeRelationConfig({
      objectType: "document",
      relation: "owner",
      directlyAssignable: [{ type: "user" }],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });
    await tsfgaClient.writeRelationConfig({
      objectType: "document",
      relation: "public",
      directlyAssignable: [{ type: "user", wildcard: true }],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });
    await tsfgaClient.writeRelationConfig({
      objectType: "document",
      relation: "derived",
      // Purely computed: admits no direct assignment at all.
      directlyAssignable: [],
      impliedBy: null,
      computedUserset: "viewer",
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });

    // Straight onto the store, deliberately bypassing the
    // validation `addTuple` applies — see the file comment.
    for (const tuple of [
      {
        objectType: "team",
        objectId: uuid("eng"),
        relation: "owner",
        subjectType: "user",
        subjectId: uuid("alice"),
      },
      {
        objectType: "team",
        objectId: uuid("eng"),
        relation: "member",
        subjectType: "user",
        subjectId: uuid("bob"),
      },
      {
        objectType: "document",
        objectId: uuid("budget"),
        relation: "viewer",
        subjectType: "team",
        subjectId: uuid("eng"),
        subjectRelation: "owner",
      },
      {
        objectType: "document",
        objectId: uuid("roadmap"),
        relation: "viewer",
        subjectType: "team",
        subjectId: uuid("eng"),
        subjectRelation: "member",
      },
      {
        objectType: "document",
        objectId: uuid("plan"),
        relation: "editor",
        subjectType: "team",
        subjectId: uuid("eng"),
        subjectRelation: "owner",
      },
      {
        objectType: "document",
        objectId: uuid("charter"),
        relation: "owner",
        subjectType: "team",
        subjectId: uuid("eng"),
        subjectRelation: "member",
      },
      {
        objectType: "document",
        objectId: uuid("charter"),
        relation: "owner",
        subjectType: "user",
        subjectId: "*",
      },
      {
        objectType: "document",
        objectId: uuid("notice"),
        relation: "public",
        subjectType: "user",
        subjectId: "*",
      },
    ]) {
      await store.insertTuple(tuple);
    }

    storeId = await fgaCreateStore("userset-restrictions-conformance");
    const wideModelId = await fgaWriteModel(
      storeId,
      "./userset-restrictions/model-wide.dsl",
    );
    await fgaWriteTuples(
      storeId,
      "./userset-restrictions/tuples.yaml",
      wideModelId,
      uuidMap,
    );
    // Narrowing after the fact. Every check below runs under this.
    narrowModelId = await fgaWriteModel(
      storeId,
      "./userset-restrictions/model-narrow.dsl",
    );
  });

  afterAll(async () => {
    await rollbackTransaction(db);
    await destroyDb();
  });

  describe("the read gate filters rows the model does not admit", () => {
    test("1: a userset row naming an unadmitted relation is ignored", async () => {
      // alice is an owner of team:eng and the stored row is
      // `document:budget#viewer@team:eng#owner`, but `viewer`
      // admits only `team#member`.
      await expectConformance(
        storeId,
        narrowModelId,
        tsfgaClient,
        {
          objectType: "document",
          objectId: uuid("budget"),
          relation: "viewer",
          subjectType: "user",
          subjectId: uuid("alice"),
        },
        false,
      );
    });

    test("2: the admitted userset still expands", async () => {
      await expectConformance(
        storeId,
        narrowModelId,
        tsfgaClient,
        {
          objectType: "document",
          objectId: uuid("roadmap"),
          relation: "viewer",
          subjectType: "user",
          subjectId: uuid("bob"),
        },
        true,
      );
    });

    test("3: an admitted userset the subject is not in denies", async () => {
      // alice is an owner, not a member, so the admitted
      // `team#member` row does not reach her.
      await expectConformance(
        storeId,
        narrowModelId,
        tsfgaClient,
        {
          objectType: "document",
          objectId: uuid("roadmap"),
          relation: "viewer",
          subjectType: "user",
          subjectId: uuid("alice"),
        },
        false,
      );
    });

    test("4: a relation admitting two usersets expands the matching one", async () => {
      await expectConformance(
        storeId,
        narrowModelId,
        tsfgaClient,
        {
          objectType: "document",
          objectId: uuid("plan"),
          relation: "editor",
          subjectType: "user",
          subjectId: uuid("alice"),
        },
        true,
      );
    });

    test("5: a relation admitting no userset ignores a userset row", async () => {
      await expectConformance(
        storeId,
        narrowModelId,
        tsfgaClient,
        {
          objectType: "document",
          objectId: uuid("charter"),
          relation: "owner",
          subjectType: "user",
          subjectId: uuid("bob"),
        },
        false,
      );
    });

    test("6: a relation without `user:*` ignores a wildcard row", async () => {
      await expectConformance(
        storeId,
        narrowModelId,
        tsfgaClient,
        {
          objectType: "document",
          objectId: uuid("charter"),
          relation: "owner",
          subjectType: "user",
          subjectId: uuid("carol"),
        },
        false,
      );
    });

    test("7: a relation with `user:*` honours the wildcard row", async () => {
      await expectConformance(
        storeId,
        narrowModelId,
        tsfgaClient,
        {
          objectType: "document",
          objectId: uuid("notice"),
          relation: "public",
          subjectType: "user",
          subjectId: uuid("carol"),
        },
        true,
      );
    });

    test("8: a purely computed relation still resolves through its rewrite", async () => {
      await expectConformance(
        storeId,
        narrowModelId,
        tsfgaClient,
        {
          objectType: "document",
          objectId: uuid("roadmap"),
          relation: "derived",
          subjectType: "user",
          subjectId: uuid("bob"),
        },
        true,
      );
    });
  });

  describe("the write gate refuses what the model does not admit", () => {
    test("9: a userset naming an unadmitted relation is refused", async () => {
      await expectWriteConformance(
        storeId,
        narrowModelId,
        tsfgaClient,
        {
          objectType: "document",
          objectId: uuid("scratch"),
          relation: "viewer",
          subjectType: "team",
          subjectId: uuid("eng"),
          subjectRelation: "owner",
        },
        "refused",
      );
    });

    test("10: the admitted userset is accepted", async () => {
      await expectWriteConformance(
        storeId,
        narrowModelId,
        tsfgaClient,
        {
          objectType: "document",
          objectId: uuid("scratch"),
          relation: "viewer",
          subjectType: "team",
          subjectId: uuid("eng"),
          subjectRelation: "member",
        },
        "accepted",
      );
    });

    test("11: a userset on a relation admitting none is refused", async () => {
      await expectWriteConformance(
        storeId,
        narrowModelId,
        tsfgaClient,
        {
          objectType: "document",
          objectId: uuid("scratch"),
          relation: "owner",
          subjectType: "team",
          subjectId: uuid("eng"),
          subjectRelation: "member",
        },
        "refused",
      );
    });

    test("12: a wildcard on a relation admitting only the bare type is refused", async () => {
      await expectWriteConformance(
        storeId,
        narrowModelId,
        tsfgaClient,
        {
          objectType: "document",
          objectId: uuid("scratch"),
          relation: "owner",
          subjectType: "user",
          subjectId: "*",
        },
        "refused",
      );
    });

    test("13: the bare type is still accepted where the wildcard is not", async () => {
      await expectWriteConformance(
        storeId,
        narrowModelId,
        tsfgaClient,
        {
          objectType: "document",
          objectId: uuid("scratch"),
          relation: "owner",
          subjectType: "user",
          subjectId: uuid("carol"),
        },
        "accepted",
      );
    });

    test("14: a direct tuple on a purely computed relation is refused", async () => {
      await expectWriteConformance(
        storeId,
        narrowModelId,
        tsfgaClient,
        {
          objectType: "document",
          objectId: uuid("scratch"),
          relation: "derived",
          subjectType: "user",
          subjectId: uuid("carol"),
        },
        "refused",
      );
    });
  });

  test("the relation configs say what the model says", () => {
    expectConfigsMatchModel(
      "./userset-restrictions/model-narrow.dsl",
      fixture,
      {
        coverage: "complete",
      },
    );
  });
});
