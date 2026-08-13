import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { createTsfga, type TypeRestriction } from "@tsfga/core";
import type { Kysely } from "kysely";
import { KyselyTupleStore } from "../src/adapter.ts";
import type { DB } from "../src/schema.ts";
import {
  beginTransaction,
  destroyDb,
  getDb,
  rollbackTransaction,
} from "./helpers/db.ts";
import { ungatedConfig, ungatedTuple } from "./helpers/ungated.ts";

/**
 * The adapter's *narrowing*, which core cannot check for it.
 *
 * `clampToQuery` catches an adapter that returns too much: the row
 * is dropped and the model still holds. Nothing catches an adapter
 * that returns too little — a lost row is a lost grant, and it
 * looks exactly like a denial. The condition dimension is where
 * that is easiest to get wrong, because a restriction's condition
 * becomes a column predicate rather than a post-filter.
 *
 * So every cell of (what the refs admit) x (what the row carries)
 * is asserted here, in both directions.
 */

const uuidDoc = "00000000-0000-0000-0000-0000000005d0";
const uuidAlice = "00000000-0000-0000-0000-0000000005d1";
const uuidTeam = "00000000-0000-0000-0000-0000000005d2";

describe("findCheckTuples narrowing", () => {
  let db: Kysely<DB>;
  let store: KyselyTupleStore;

  beforeAll(() => {
    db = getDb();
    store = new KyselyTupleStore(db);
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

  async function seedDirect(conditionName: string | null): Promise<void> {
    await store.insertTuple(
      ungatedTuple({
        objectType: "doc_c4k",
        objectId: uuidDoc,
        relation: "viewer",
        subjectType: "user_c4k",
        subjectId: uuidAlice,
        conditionName,
      }),
    );
  }

  function read(refs: readonly TypeRestriction[] | null) {
    return store.findCheckTuples({
      objectType: "doc_c4k",
      objectId: uuidDoc,
      relation: "viewer",
      subjectType: "user_c4k",
      subjectId: uuidAlice,
      directRefs: refs,
      wildcardRefs: [],
      usersetRefs: [],
    });
  }

  const bare: TypeRestriction = { type: "user_c4k" };
  const conditioned: TypeRestriction = {
    type: "user_c4k",
    condition: "weekday",
  };
  const other: TypeRestriction = { type: "user_c4k", condition: "other" };

  describe("a bare stored row", () => {
    beforeEach(() => seedDirect(null));

    test("is returned for a bare ref", async () => {
      expect((await read([bare])).direct).not.toBeNull();
    });

    test("is not returned for a conditioned ref alone", async () => {
      expect((await read([conditioned])).direct).toBeNull();
    });

    test("is returned when the ref list admits both", async () => {
      expect((await read([bare, conditioned])).direct).not.toBeNull();
    });

    test("is returned for an unnarrowed read", async () => {
      expect((await read(null)).direct).not.toBeNull();
    });

    test("is not returned for an excluded read", async () => {
      expect((await read([])).direct).toBeNull();
    });
  });

  describe("a conditioned stored row", () => {
    beforeEach(() => seedDirect("weekday"));

    test("is returned for the ref naming its condition", async () => {
      expect((await read([conditioned])).direct).not.toBeNull();
      expect((await read([conditioned])).direct?.conditionName).toBe("weekday");
    });

    test("is not returned for a bare ref", async () => {
      expect((await read([bare])).direct).toBeNull();
    });

    test("is not returned for a ref naming another condition", async () => {
      expect((await read([other])).direct).toBeNull();
    });

    test("is returned when the ref list admits both", async () => {
      expect((await read([bare, conditioned])).direct).not.toBeNull();
    });

    test("is returned for an unnarrowed read", async () => {
      // `null` is *unrestricted*, so the condition is no longer a
      // predicate. The row must still come back; core clamps it.
      expect((await read(null)).direct).not.toBeNull();
    });
  });

  describe("userset refs", () => {
    beforeEach(async () => {
      await store.insertTuple(
        ungatedTuple({
          objectType: "doc_c4k",
          objectId: uuidDoc,
          relation: "viewer",
          subjectType: "team_c4k",
          subjectId: uuidTeam,
          subjectRelation: "member",
        }),
      );
      await store.insertTuple(
        ungatedTuple({
          objectType: "doc_c4k",
          objectId: uuidDoc,
          relation: "viewer",
          subjectType: "team_c4k",
          subjectId: uuidTeam,
          subjectRelation: "owner",
          conditionName: "weekday",
        }),
      );
    });

    function readUsersets(refs: readonly TypeRestriction[] | null) {
      return store.findCheckTuples({
        objectType: "doc_c4k",
        objectId: uuidDoc,
        relation: "viewer",
        subjectType: "user_c4k",
        subjectId: uuidAlice,
        directRefs: [],
        wildcardRefs: [],
        usersetRefs: refs,
      });
    }

    test("one userset ref returns only that userset", async () => {
      const { usersets } = await readUsersets([
        { type: "team_c4k", relation: "member" },
      ]);
      expect(usersets.map((t) => t.subjectRelation)).toEqual(["member"]);
    });

    test("a conditioned userset ref matches on the condition too", async () => {
      const admitted = await readUsersets([
        { type: "team_c4k", relation: "owner", condition: "weekday" },
      ]);
      expect(admitted.usersets.map((t) => t.subjectRelation)).toEqual([
        "owner",
      ]);

      const refused = await readUsersets([
        { type: "team_c4k", relation: "owner" },
      ]);
      expect(refused.usersets).toEqual([]);
    });

    test("null returns every userset row", async () => {
      const { usersets } = await readUsersets(null);
      expect(usersets).toHaveLength(2);
    });

    test("an empty list returns none", async () => {
      expect((await readUsersets([])).usersets).toEqual([]);
    });

    test("a ref of the wrong type contributes nothing", async () => {
      expect(
        (await readUsersets([{ type: "other_c4k", relation: "member" }]))
          .usersets,
      ).toEqual([]);
    });
  });
});

describe("hasTypeDefinition containment", () => {
  let db: Kysely<DB>;
  let store: KyselyTupleStore;

  beforeAll(() => {
    db = getDb();
    store = new KyselyTupleStore(db);
  });

  beforeEach(async () => {
    await rollbackTransaction(db);
    await beginTransaction(db);
    await store.upsertRelationConfig(
      ungatedConfig({
        objectType: "doc_c4k",
        relation: "viewer",
        directlyAssignable: [
          { type: "user_c4k" },
          { type: "group_c4k", relation: "member_c4k" },
          { type: "robot_c4k", condition: "weekday_c4k" },
        ],
        impliedBy: null,
        computedUserset: null,
        tupleToUserset: null,
        excludedBy: null,
        intersection: null,
      }),
    );
  });

  afterEach(async () => {
    await rollbackTransaction(db);
  });

  afterAll(async () => {
    await destroyDb();
  });

  test("a relation name is not mistaken for a type", async () => {
    // `member_c4k` appears in the JSON, but as the value of
    // `relation`. Containment is key-aware, so it must not count.
    expect(await store.hasTypeDefinition("member_c4k")).toBe(false);
  });

  test("a condition name is not mistaken for a type", async () => {
    expect(await store.hasTypeDefinition("weekday_c4k")).toBe(false);
  });

  test("a prefix of a defined type is not itself defined", async () => {
    expect(await store.hasTypeDefinition("user")).toBe(false);
    expect(await store.hasTypeDefinition("user_c4")).toBe(false);
  });

  test("a name holding JSON punctuation is asked for literally", async () => {
    // The probe is built with `JSON.stringify`, so a quote or a
    // backslash in the name must escape rather than change the
    // shape of the document being matched.
    expect(await store.hasTypeDefinition('user_c4k", "x": "')).toBe(false);
    expect(await store.hasTypeDefinition("user_c4k\\")).toBe(false);
  });

  test("the empty string is not a defined type", async () => {
    expect(await store.hasTypeDefinition("")).toBe(false);
  });
});

describe("a client over a transaction", () => {
  let db: Kysely<DB>;

  beforeAll(() => {
    db = getDb();
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

  test("a write earlier in the transaction is visible to a later check", async () => {
    // The reason `checkMany` is a scope rather than a cache: a
    // client built over a transaction must see that transaction's
    // own uncommitted rows.
    const client = createTsfga(new KyselyTupleStore(db));
    await client.writeRelationConfig({
      objectType: "doc_c4k",
      relation: "viewer",
      directlyAssignable: [{ type: "user_c4k" }],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });
    await client.addTuple({
      objectType: "doc_c4k",
      objectId: uuidDoc,
      relation: "viewer",
      subjectType: "user_c4k",
      subjectId: uuidAlice,
    });

    const request = {
      objectType: "doc_c4k",
      objectId: uuidDoc,
      relation: "viewer",
      subjectType: "user_c4k",
      subjectId: uuidAlice,
    };
    expect(await client.check(request)).toBe(true);
    expect((await client.checkMany([request]))[0]?.allowed).toBe(true);
    expect(
      await client.listObjects({
        objectType: "doc_c4k",
        relation: "viewer",
        subjectType: "user_c4k",
        subjectId: uuidAlice,
      }),
    ).toEqual([uuidDoc]);
    expect(
      await client.listSubjects("doc_c4k", uuidDoc, "viewer"),
    ).toHaveLength(1);
  });

  test("a removal earlier in the transaction is visible too", async () => {
    const client = createTsfga(new KyselyTupleStore(db));
    await client.writeRelationConfig({
      objectType: "doc_c4k",
      relation: "viewer",
      directlyAssignable: [{ type: "user_c4k" }],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });
    const tuple = {
      objectType: "doc_c4k",
      objectId: uuidDoc,
      relation: "viewer",
      subjectType: "user_c4k",
      subjectId: uuidAlice,
    };
    await client.addTuple(tuple);
    await client.removeTuple(tuple);
    expect(await client.check(tuple)).toBe(false);
    // And the write gate is open again: the row is gone, so this is
    // not a duplicate.
    await client.addTuple(tuple);
  });
});

/**
 * The one shape whose consequence is visible only through a real
 * adapter. A tuple-to-userset dispatch onto a wildcard tupleset row
 * would ask for object id `"*"`; the mock store answers that read
 * with no rows, but a `uuid` column answers it with a driver error,
 * and a raw `pg` `DatabaseError` is not a `TsfgaError`.
 */
describe("a wildcard tupleset row through the adapter", () => {
  let db: Kysely<DB>;

  beforeAll(() => {
    db = getDb();
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

  test("check resolves false rather than reaching the driver", async () => {
    const client = createTsfga(new KyselyTupleStore(db));
    await client.writeRelationConfig({
      objectType: "folder_c4k",
      relation: "viewer",
      directlyAssignable: [{ type: "user_c4k" }],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });
    await client.writeRelationConfig({
      objectType: "doc_c4k",
      relation: "viewer",
      directlyAssignable: [{ type: "user_c4k" }],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: [{ tupleset: "parent", computedUserset: "viewer" }],
      excludedBy: null,
      intersection: null,
    });
    await client.writeRelationConfig({
      objectType: "doc_c4k",
      relation: "parent",
      directlyAssignable: [{ type: "folder_c4k" }],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });
    // Widened after the TTU was written, so the "tupleset relation
    // admits a wildcard" rule never sees it — the documented
    // write-order gap.
    await client.writeRelationConfig({
      objectType: "doc_c4k",
      relation: "parent",
      directlyAssignable: [
        { type: "folder_c4k" },
        { type: "folder_c4k", wildcard: true },
      ],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });
    await client.addTuple({
      objectType: "doc_c4k",
      objectId: uuidDoc,
      relation: "parent",
      subjectType: "folder_c4k",
      subjectId: "*",
    });

    expect(
      await client.check({
        objectType: "doc_c4k",
        objectId: uuidDoc,
        relation: "viewer",
        subjectType: "user_c4k",
        subjectId: uuidAlice,
      }),
    ).toBe(false);
  });
});
