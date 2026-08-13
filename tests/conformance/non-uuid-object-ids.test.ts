import { afterAll, beforeAll, describe, test } from "bun:test";
import { createTsfga, type TsfgaClient } from "@tsfga/core";
import type { DB } from "@tsfga/kysely";
import { KyselyTupleStore } from "@tsfga/kysely";
import type { Kysely } from "kysely";
import {
  expectConfigsMatchModel,
  expectPinnedDivergence,
  expectPinnedListObjectsDivergence,
  expectPinnedWriteDivergence,
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
 * Object ids that are not UUIDs, through every rewrite kind — and
 * what `@tsfga/kysely` gave up when it took them back.
 *
 * Migration `007` made `tsfga.tuples.object_id` `text` (issue
 * 281): before it, two ids differing outside the hex digits of a
 * UUID collapsed onto one row, and the whole conformance corpus
 * used UUIDs, so nothing exercised the column as a string. What
 * this file asserted is that an id upstream treats as an opaque
 * string is one tsfga treats the same way at every point a
 * *different* id could be substituted for it: a direct row, a
 * userset row, a wildcard row, a tuple-to-userset hop onto a
 * second object, an exclusion, and the `listObjects` candidate
 * pool.
 *
 * The pairs that differ only in case are the sharp end. `doc.one`
 * and `DOC.one` are two objects to OpenFGA, and were one object to
 * the `uuid` column, which normalised what it stored.
 *
 * **`007` is deleted and the column is `uuid` again.** The store
 * declares a canonical-UUID id domain, so every id in this file is
 * one it refuses — and every assertion below is now a pinned
 * capability divergence recording what upstream answers and what
 * tsfga declines to answer.
 *
 * The file stays, with its model and its fixtures, because a pin
 * **refuses to pass on agreement**. It is the largest single piece
 * of evidence about the behaviour that was given up, and if the id
 * domain is ever widened — one migration and one declaration away
 * — this file goes red and tells the next person exactly what was
 * handed back. A deleted file tells them nothing and a file moved
 * to `docs/` rots. Rewriting it to UUIDs would delete it: it
 * exists to assert that a non-UUID id survives every rewrite kind.
 *
 * `beforeAll` writes only to OpenFGA. Every one of those writes is
 * refused by tsfga, and the first block below proves it per write
 * shape rather than leaving it to a swallowed exception. Relation
 * configs are unaffected — `writeRelationConfig` carries no ids —
 * so `expectConfigsMatchModel` keeps working.
 */

const ALICE = "alice.smith";
const BOB = "BOB.smith";

/** Object ids no `uuid` column would have taken. */
const DOC_LOWER = "doc.one";
const DOC_UPPER = "DOC.one";
const DOC_TTU = "doc|ttu";
const DOC_TEAM = "doc-team";
const DOC_WILD = "doc_wild";
const DOC_BLOCKED = "doc.blocked";
const DOC_UNICODE = "dökümän-1";
const DOC_NUMERIC = "0";
const FOLDER = "Folder.A";
const FOLDER_OTHER = "folder.a";
const TEAM = "team~1";

/**
 * Every row the fixture needs, each labelled with the write shape
 * it exercises.
 *
 * Module level because the pins below iterate the same list: each
 * of these is a write OpenFGA takes and tsfga refuses, and the
 * label is what the pin is called.
 */
const TUPLES = [
  // A direct row on the lower-case id; nothing on the
  // upper-case one.
  {
    label: "a direct row on a dotted id",
    objectType: "doc_c2i",
    objectId: DOC_LOWER,
    relation: "viewer",
    subjectType: "user_c2i",
    subjectId: ALICE,
  },
  // A tuple-to-userset hop onto a folder whose id differs from
  // a second folder only in case.
  {
    label: "a tuple-to-userset link onto a mixed-case folder",
    objectType: "doc_c2i",
    objectId: DOC_TTU,
    relation: "parent",
    subjectType: "folder_c2i",
    subjectId: FOLDER,
  },
  {
    label: "a viewer row on the mixed-case folder",
    objectType: "folder_c2i",
    objectId: FOLDER,
    relation: "viewer",
    subjectType: "user_c2i",
    subjectId: ALICE,
  },
  {
    label: "a viewer row on its lower-case neighbour",
    objectType: "folder_c2i",
    objectId: FOLDER_OTHER,
    relation: "viewer",
    subjectType: "user_c2i",
    subjectId: BOB,
  },
  // A userset row.
  {
    label: "a userset row on a tilde id",
    objectType: "doc_c2i",
    objectId: DOC_TEAM,
    relation: "viewer",
    subjectType: "team_c2i",
    subjectId: TEAM,
    subjectRelation: "member",
  },
  {
    label: "a membership row on a tilde id",
    objectType: "team_c2i",
    objectId: TEAM,
    relation: "member",
    subjectType: "user_c2i",
    subjectId: ALICE,
  },
  // A wildcard row.
  {
    label: "a wildcard row on an underscore id",
    objectType: "doc_c2i",
    objectId: DOC_WILD,
    relation: "viewer",
    subjectType: "user_c2i",
    subjectId: "*",
  },
  // An exclusion.
  {
    label: "an exclusion's granting row",
    objectType: "doc_c2i",
    objectId: DOC_BLOCKED,
    relation: "viewer",
    subjectType: "user_c2i",
    subjectId: ALICE,
  },
  {
    label: "an exclusion's blocking row",
    objectType: "doc_c2i",
    objectId: DOC_BLOCKED,
    relation: "blocked",
    subjectType: "user_c2i",
    subjectId: ALICE,
  },
  // Ids at the edges of what a string id can be.
  {
    label: "an owner row on a non-ASCII id",
    objectType: "doc_c2i",
    objectId: DOC_UNICODE,
    relation: "owner",
    subjectType: "user_c2i",
    subjectId: ALICE,
  },
  {
    label: "a viewer row on a single-digit id",
    objectType: "doc_c2i",
    objectId: DOC_NUMERIC,
    relation: "viewer",
    subjectType: "user_c2i",
    subjectId: ALICE,
  },
] as const;

describe("Non-UUID Identifier Conformance", () => {
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
      objectType: "team_c2i",
      relation: "member",
      directlyAssignable: [{ type: "user_c2i" }],
      ...plain,
    });
    await tsfgaClient.writeRelationConfig({
      objectType: "folder_c2i",
      relation: "viewer",
      directlyAssignable: [{ type: "user_c2i" }],
      ...plain,
    });
    await tsfgaClient.writeRelationConfig({
      objectType: "doc_c2i",
      relation: "parent",
      directlyAssignable: [{ type: "folder_c2i" }],
      ...plain,
    });
    await tsfgaClient.writeRelationConfig({
      objectType: "doc_c2i",
      relation: "owner",
      directlyAssignable: [{ type: "user_c2i" }],
      ...plain,
    });
    await tsfgaClient.writeRelationConfig({
      objectType: "doc_c2i",
      relation: "blocked",
      directlyAssignable: [{ type: "user_c2i" }],
      ...plain,
    });
    await tsfgaClient.writeRelationConfig({
      objectType: "doc_c2i",
      relation: "viewer",
      directlyAssignable: [
        { type: "user_c2i" },
        { type: "user_c2i", wildcard: true },
        { type: "team_c2i", relation: "member" },
      ],
      impliedBy: ["owner"],
      computedUserset: null,
      tupleToUserset: [{ tupleset: "parent", computedUserset: "viewer" }],
      excludedBy: null,
      intersection: null,
    });
    await tsfgaClient.writeRelationConfig({
      objectType: "doc_c2i",
      relation: "allowed",
      directlyAssignable: [],
      impliedBy: null,
      computedUserset: "viewer",
      tupleToUserset: null,
      excludedBy: "blocked",
      intersection: null,
    });

    storeId = await fgaCreateStore("non-uuid-object-ids-conformance");
    authorizationModelId = await fgaWriteModel(
      storeId,
      "./non-uuid-object-ids/model.dsl",
    );
    await fgaWriteTuplesRaw(
      storeId,
      authorizationModelId,
      TUPLES.map((tuple) => ({
        user:
          "subjectRelation" in tuple
            ? `${tuple.subjectType}:${tuple.subjectId}#${tuple.subjectRelation}`
            : `${tuple.subjectType}:${tuple.subjectId}`,
        relation: tuple.relation,
        object: `${tuple.objectType}:${tuple.objectId}`,
      })),
    );
  });

  afterAll(async () => {
    await rollbackTransaction(db);
    await destroyDb();
  });

  /**
   * What upstream answers, and that tsfga declines to answer.
   *
   * `expected` is the answer this file used to assert on both
   * sides. It is kept verbatim, because the value is the record:
   * it says what a store with a wider id domain would have to
   * reproduce.
   */
  async function expectCheck(
    objectId: string,
    relation: string,
    subjectId: string,
    expected: boolean,
  ): Promise<void> {
    await expectPinnedDivergence(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "doc_c2i",
        objectId,
        relation,
        subjectType: "user_c2i",
        subjectId,
      },
      { openfga: expected, tsfga: "refused" },
    );
  }

  test("a dotted object id grants directly", async () => {
    await expectCheck(DOC_LOWER, "viewer", ALICE, true);
  });

  test("an id differing only in case is a different object", async () => {
    await expectCheck(DOC_UPPER, "viewer", ALICE, false);
  });

  test("a dotted subject id differing only in case is a different subject", async () => {
    await expectCheck(DOC_LOWER, "viewer", BOB, false);
  });

  test("a tuple-to-userset hop keeps the linked id verbatim", async () => {
    await expectCheck(DOC_TTU, "viewer", ALICE, true);
  });

  test("the tuple-to-userset hop does not reach the other case", async () => {
    // `folder.a#viewer` holds BOB, `Folder.A#viewer` holds ALICE,
    // and `doc|ttu#parent` names the second.
    await expectCheck(DOC_TTU, "viewer", BOB, false);
  });

  test("a userset row on a tilde id expands", async () => {
    await expectCheck(DOC_TEAM, "viewer", ALICE, true);
  });

  test("a wildcard row on an underscore id grants", async () => {
    await expectCheck(DOC_WILD, "viewer", BOB, true);
  });

  test("an exclusion on a dotted id denies", async () => {
    await expectCheck(DOC_BLOCKED, "allowed", ALICE, false);
  });

  test("a non-ASCII id grants through relation inheritance", async () => {
    await expectCheck(DOC_UNICODE, "viewer", ALICE, true);
  });

  test("an id of a single digit grants", async () => {
    await expectCheck(DOC_NUMERIC, "viewer", ALICE, true);
  });

  test("listObjects returns every string id and no other", async () => {
    await expectPinnedListObjectsDivergence(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "doc_c2i",
        relation: "viewer",
        subjectType: "user_c2i",
        subjectId: ALICE,
      },
      {
        openfga: [
          DOC_LOWER,
          DOC_TTU,
          DOC_TEAM,
          DOC_WILD,
          DOC_BLOCKED,
          DOC_UNICODE,
          DOC_NUMERIC,
        ],
        tsfga: "refused",
      },
    );
  });

  test("listObjects for the wildcard-only subject", async () => {
    await expectPinnedListObjectsDivergence(
      storeId,
      authorizationModelId,
      tsfgaClient,
      {
        objectType: "doc_c2i",
        relation: "allowed",
        subjectType: "user_c2i",
        subjectId: BOB,
      },
      { openfga: [DOC_WILD], tsfga: "refused" },
    );
  });

  /**
   * One per distinct write shape, so no refusal is inferred from a
   * swallowed exception in `beforeAll`.
   *
   * On a fresh object id per row: upstream already holds every row
   * in `TUPLES`, and its `on_duplicate` default is `error`, so
   * re-writing one would have upstream refuse for a reason that is
   * not the one under test. The suffix keeps the id non-UUID,
   * which is the only property the pin is about.
   *
   * Declared last for the same reason: the rows it writes are
   * reachable, so upstream's `listObjects` would report them and
   * the two set assertions above are the record of what upstream
   * answers for the fixture as written.
   */
  describe("every write shape is refused", () => {
    for (const tuple of TUPLES) {
      test(tuple.label, async () => {
        await expectPinnedWriteDivergence(
          storeId,
          authorizationModelId,
          tsfgaClient,
          {
            objectType: tuple.objectType,
            objectId: `${tuple.objectId}.pin`,
            relation: tuple.relation,
            subjectType: tuple.subjectType,
            subjectId: tuple.subjectId,
            subjectRelation:
              "subjectRelation" in tuple ? tuple.subjectRelation : null,
          },
          { openfga: "accepted", tsfga: "refused" },
        );
      });
    }
  });

  test("the fixture's configs match its model", () => {
    expectConfigsMatchModel("./non-uuid-object-ids/model.dsl", fixture, {
      coverage: "complete",
    });
  });
});
