import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import {
  createTsfga,
  type RelationConfig,
  type TsfgaClient,
  type TypeRestriction,
} from "@tsfga/core";
import type { Kysely } from "kysely";
import { KyselyTupleStore } from "../src/adapter.ts";
import type { DB } from "../src/schema.ts";
import {
  beginTransaction,
  destroyDb,
  getDb,
  rollbackTransaction,
} from "./helpers/db.ts";

/**
 * The subject filter on `listSubjects`, exercised against real
 * stored rows rather than a mock.
 *
 * The gate runs in core, not in the adapter, and
 * `listDirectSubjects` has since left `TupleStore`, so this is the
 * only library path to those rows — and its whole coverage was one
 * mock-driven core suite. What the mock cannot show is that the
 * rows survive a round trip through PostgreSQL: the wildcard
 * sentinel, the nullable `subject_relation`, and the condition
 * name all have to come back in the shape the filter compares.
 *
 * **Rows are pushed straight to the store.** `addTuple` refuses
 * exactly the rows under test, so a fixture built on the write path
 * could only ever contain admissible ones. Narrowing a relation
 * does not revalidate what is already stored, which is how a real
 * deployment reaches this state.
 *
 * Deliberately one-sided. tsfga's `listSubjects` returns direct
 * subjects with no expansion at all, while OpenFGA's `ListUsers`
 * expands usersets and computed relations; comparing the two would
 * fail by design, so there is no upstream binding for it.
 */

const doc = "00000000-0000-0000-0000-0000000000d1";
const otherDoc = "00000000-0000-0000-0000-0000000000d2";
const alice = "00000000-0000-0000-0000-00000000a11c";
const bob = "00000000-0000-0000-0000-00000000b0b0";
const carol = "00000000-0000-0000-0000-00000000ca01";
const eng = "00000000-0000-0000-0000-0000000000e6";

function config(
  relation: string,
  directlyAssignable: TypeRestriction[],
): RelationConfig {
  return {
    objectType: "document",
    relation,
    directlyAssignable,
    impliedBy: null,
    computedUserset: null,
    tupleToUserset: null,
    excludedBy: null,
    intersection: null,
  };
}

/** `type:id`, `type:id#relation` or `type:id with condition`. */
function render(subject: {
  subjectType: string;
  subjectId: string;
  subjectRelation: string | null;
}): string {
  return subject.subjectRelation
    ? `${subject.subjectType}:${subject.subjectId}#${subject.subjectRelation}`
    : `${subject.subjectType}:${subject.subjectId}`;
}

/** Order is not part of the contract; compare as sorted sets. */
function subjects(
  reported: Array<{
    subjectType: string;
    subjectId: string;
    subjectRelation: string | null;
  }>,
): string[] {
  return reported.map(render).sort();
}

describe("listSubjects over the adapter", () => {
  let db: Kysely<DB>;
  let store: KyselyTupleStore;
  let client: TsfgaClient;

  beforeAll(() => {
    db = getDb();
    store = new KyselyTupleStore(db);
    client = createTsfga(store);
  });

  beforeEach(async () => {
    await rollbackTransaction(db);
    await beginTransaction(db);
  });

  afterEach(async () => {
    await rollbackTransaction(db);
  });

  afterAll(async () => {
    await destroyDb();
  });

  test("reports only the shapes the relation admits", async () => {
    await store.upsertRelationConfig(
      config("viewer", [
        { type: "user" },
        { type: "team", relation: "member" },
      ]),
    );

    for (const row of [
      // Admitted.
      { subjectType: "user", subjectId: alice },
      { subjectType: "team", subjectId: eng, subjectRelation: "member" },
      // A type the relation does not name.
      { subjectType: "group", subjectId: eng },
      // The right type, the wrong userset relation.
      { subjectType: "team", subjectId: eng, subjectRelation: "owner" },
      // The wildcard is its own shape, and is not admitted here.
      { subjectType: "user", subjectId: "*" },
    ]) {
      await store.insertTuple({
        objectType: "document",
        objectId: doc,
        relation: "viewer",
        ...row,
      });
    }

    expect(
      subjects(await client.listSubjects("document", doc, "viewer")),
    ).toEqual([`team:${eng}#member`, `user:${alice}`]);
  });

  test("matches the condition, not just the shape", async () => {
    await store.upsertRelationConfig(
      config("editor", [
        { type: "user", condition: "weekday_only" },
        { type: "user", wildcard: true },
      ]),
    );

    // The condition is not part of a tuple's natural key, so each
    // spelling needs its own subject: written on one, the last
    // write would simply replace the one before it.
    for (const row of [
      // Admitted: the conditioned ref, carrying its condition.
      {
        subjectType: "user",
        subjectId: alice,
        conditionName: "weekday_only",
      },
      // Admitted: the bare wildcard ref.
      { subjectType: "user", subjectId: "*" },
      // The same type with no condition, where only the
      // conditioned ref is named.
      { subjectType: "user", subjectId: bob },
      // An admitted type carrying a condition the ref does not name.
      {
        subjectType: "user",
        subjectId: carol,
        conditionName: "other_cond",
      },
    ]) {
      await store.insertTuple({
        objectType: "document",
        objectId: doc,
        relation: "editor",
        ...row,
      });
    }

    expect(
      subjects(await client.listSubjects("document", doc, "editor")),
    ).toEqual(["user:*", `user:${alice}`]);

    // The wildcard is admitted bare here, so a conditioned wildcard
    // is a different ref and is not. It needs its own object for
    // the same reason.
    await store.insertTuple({
      objectType: "document",
      objectId: otherDoc,
      relation: "editor",
      subjectType: "user",
      subjectId: "*",
      conditionName: "weekday_only",
    });

    expect(
      subjects(await client.listSubjects("document", otherDoc, "editor")),
    ).toEqual([]);
  });

  test("reports every row when no config restricts the relation", async () => {
    // A relation with no config reads as unrestricted rather than
    // as an error, so nothing is filtered. Pinned because it is the
    // one way this path reports a row `check` would not act on, and
    // because it is what a missing config costs.
    await store.insertTuple({
      objectType: "document",
      objectId: doc,
      relation: "unconfigured",
      subjectType: "group",
      subjectId: eng,
      subjectRelation: "owner",
    });

    expect(
      subjects(await client.listSubjects("document", doc, "unconfigured")),
    ).toEqual([`group:${eng}#owner`]);
  });
});
