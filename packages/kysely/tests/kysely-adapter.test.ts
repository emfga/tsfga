import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import type { Tuple } from "@tsfga/core";
import { CamelCasePlugin, type Kysely } from "kysely";
import { KyselyTupleStore } from "../src/adapter.ts";
import type { DB } from "../src/schema.ts";
import {
  beginTransaction,
  destroyDb,
  getDb,
  rollbackTransaction,
} from "./helpers/db.ts";
import { ungatedConfig, ungatedTuple } from "./helpers/ungated.ts";

/** Row order is not part of the read contract; compare as sets. */
function sortedBySubject(tuples: readonly Tuple[]): Tuple[] {
  return [...tuples].sort((a, b) =>
    `${a.subjectType}:${a.subjectId}#${a.subjectRelation}`.localeCompare(
      `${b.subjectType}:${b.subjectId}#${b.subjectRelation}`,
    ),
  );
}

describe("KyselyTupleStore", () => {
  let db: Kysely<DB>;
  let store: KyselyTupleStore;

  // UUIDs for testing
  const uuid1 = "00000000-0000-0000-0000-000000000001";
  const uuid2 = "00000000-0000-0000-0000-000000000002";
  const uuid3 = "00000000-0000-0000-0000-000000000003";

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

  /**
   * The direct probe on its own. Most read-back assertions want
   * exactly one tuple by its natural key, which is one of the
   * three parts `findCheckTuples` can serve.
   */
  async function readDirect(
    objectType: string,
    objectId: string,
    relation: string,
    subjectType: string,
    subjectId: string,
  ): Promise<Tuple | null> {
    const { direct } = await store.findCheckTuples({
      objectType,
      objectId,
      relation,
      subjectType,
      subjectId,
      directRefs: null,
      wildcardRefs: [],
      usersetRefs: [],
    });
    return direct;
  }

  describe("Relation configs", () => {
    test("upsertRelationConfig and findRelationConfig", async () => {
      await store.upsertRelationConfig(
        ungatedConfig({
          objectType: "workspace",
          relation: "member",
          directlyAssignable: [{ type: "user" }],
          impliedBy: ["channels_admin"],
          computedUserset: null,
          tupleToUserset: null,
          excludedBy: null,
          intersection: null,
        }),
      );

      const config = await store.findRelationConfig("workspace", "member");
      expect(config).not.toBeNull();
      expect(config?.objectType).toBe("workspace");
      expect(config?.relation).toBe("member");
      expect(config?.directlyAssignable).toEqual([{ type: "user" }]);
      expect(config?.impliedBy).toEqual(["channels_admin"]);
    });

    test("findRelationConfig returns null for missing config", async () => {
      const config = await store.findRelationConfig("nonexistent", "rel");
      expect(config).toBeNull();
    });

    /**
     * The subject gate's read. Both arms matter: a type with
     * relations of its own is defined by its configs, and a type
     * with none — the shape of nearly every subject type there is —
     * only by the restrictions that admit it.
     */
    describe("hasTypeDefinition", () => {
      beforeEach(async () => {
        await store.upsertRelationConfig(
          ungatedConfig({
            objectType: "workspace",
            relation: "member",
            directlyAssignable: [
              { type: "user" },
              { type: "robot", wildcard: true },
              { type: "team", relation: "member" },
              { type: "vendor", condition: "weekday_only" },
            ],
            impliedBy: null,
            computedUserset: null,
            tupleToUserset: null,
            excludedBy: null,
            intersection: null,
          }),
        );
      });

      test("a type with a relation config of its own", async () => {
        expect(await store.hasTypeDefinition("workspace")).toBe(true);
      });

      test("a type only a restriction names", async () => {
        expect(await store.hasTypeDefinition("user")).toBe(true);
      });

      test("every restriction shape counts, not just the bare one", async () => {
        // The containment probe is `[{"type": t}]`, which every
        // restriction naming `t` contains — wildcard, userset and
        // conditioned alike.
        expect(await store.hasTypeDefinition("robot")).toBe(true);
        expect(await store.hasTypeDefinition("team")).toBe(true);
        expect(await store.hasTypeDefinition("vendor")).toBe(true);
      });

      test("a type nothing names", async () => {
        expect(await store.hasTypeDefinition("no_such_type")).toBe(false);
      });

      test("a type only a stored tuple names", async () => {
        // Rows say nothing about the model: one can outlive the
        // config that admitted it, and a dropped type must not look
        // defined for as long as its rows survive.
        await store.insertTuple(
          ungatedTuple({
            objectType: "workspace",
            objectId: uuid1,
            relation: "member",
            subjectType: "ghost",
            subjectId: uuid2,
          }),
        );

        expect(await store.hasTypeDefinition("ghost")).toBe(false);
      });
    });

    test("upsertRelationConfig updates existing", async () => {
      await store.upsertRelationConfig(
        ungatedConfig({
          objectType: "workspace",
          relation: "member",
          directlyAssignable: [{ type: "user" }],
          impliedBy: null,
          computedUserset: null,
          tupleToUserset: null,
          excludedBy: null,
          intersection: null,
        }),
      );
      await store.upsertRelationConfig(
        ungatedConfig({
          objectType: "workspace",
          relation: "member",
          directlyAssignable: [
            { type: "user" },
            { type: "team" },
            { type: "workspace", relation: "member" },
          ],
          impliedBy: null,
          computedUserset: null,
          tupleToUserset: null,
          excludedBy: null,
          intersection: null,
        }),
      );

      const config = await store.findRelationConfig("workspace", "member");
      expect(config?.directlyAssignable).toEqual([
        { type: "user" },
        { type: "team" },
        { type: "workspace", relation: "member" },
      ]);
    });

    test("deleteRelationConfig", async () => {
      await store.upsertRelationConfig(
        ungatedConfig({
          objectType: "workspace",
          relation: "member",
          directlyAssignable: [
            { type: "user" },
            { type: "user", wildcard: true },
            { type: "workspace" },
            { type: "workspace", wildcard: true },
          ],
          impliedBy: null,
          computedUserset: null,
          tupleToUserset: null,
          excludedBy: null,
          intersection: null,
        }),
      );
      expect(await store.deleteRelationConfig("workspace", "member")).toBe(
        true,
      );
      expect(await store.findRelationConfig("workspace", "member")).toBeNull();
    });

    test("deleteRelationConfig returns false for missing", async () => {
      expect(await store.deleteRelationConfig("nonexistent", "rel")).toBe(
        false,
      );
    });

    test("upsertRelationConfig with tupleToUserset", async () => {
      await store.upsertRelationConfig(
        ungatedConfig({
          objectType: "repo",
          relation: "reader",
          directlyAssignable: [
            { type: "user" },
            { type: "user", wildcard: true },
            { type: "workspace" },
            { type: "workspace", wildcard: true },
          ],
          impliedBy: null,
          computedUserset: null,
          tupleToUserset: [
            { tupleset: "organization", computedUserset: "member" },
          ],
          excludedBy: null,
          intersection: null,
        }),
      );

      const config = await store.findRelationConfig("repo", "reader");
      expect(config?.tupleToUserset).toEqual([
        { tupleset: "organization", computedUserset: "member" },
      ]);
    });
  });

  describe("Condition definitions", () => {
    test("upsertConditionDefinition and findConditionDefinition", async () => {
      await store.upsertConditionDefinition({
        name: "in_region",
        expression: 'region == "us"',
        parameters: { region: "string" },
      });

      const cond = await store.findConditionDefinition("in_region");
      expect(cond).not.toBeNull();
      expect(cond?.name).toBe("in_region");
      expect(cond?.expression).toBe('region == "us"');
      expect(cond?.parameters).toEqual({ region: "string" });
    });

    test("findConditionDefinition returns null for missing", async () => {
      expect(await store.findConditionDefinition("nope")).toBeNull();
    });

    test("a container parameter round-trips with its element type", async () => {
      // The element type is half the declaration: `list<string>`
      // given `[1]` is a value upstream refuses, and only the
      // element type says so. The stored-JSON validation used to
      // know a bare `list` and would reject this row.
      await store.upsertConditionDefinition({
        name: "domains",
        expression: "domain in domains",
        parameters: { domain: "string", domains: "list<string>" },
      });

      const cond = await store.findConditionDefinition("domains");
      expect(cond?.parameters).toEqual({
        domain: "string",
        domains: "list<string>",
      });
    });

    test("deleteConditionDefinition", async () => {
      await store.upsertConditionDefinition({
        name: "test",
        expression: "true",
        parameters: {},
      });
      expect(await store.deleteConditionDefinition("test")).toBe(true);
      expect(await store.findConditionDefinition("test")).toBeNull();
    });
  });

  describe("Tuples", () => {
    test("insertTuple then read back the direct probe", async () => {
      await store.insertTuple(
        ungatedTuple({
          objectType: "workspace",
          objectId: uuid1,
          relation: "member",
          subjectType: "user",
          subjectId: uuid2,
        }),
      );

      const tuple = await readDirect(
        "workspace",
        uuid1,
        "member",
        "user",
        uuid2,
      );
      expect(tuple).not.toBeNull();
      expect(tuple?.objectType).toBe("workspace");
      expect(tuple?.objectId).toBe(uuid1);
      expect(tuple?.subjectId).toBe(uuid2);
      expect(tuple?.subjectRelation).toBeNull();
    });

    test("the direct probe is null for a missing tuple", async () => {
      expect(
        await readDirect("workspace", uuid1, "member", "user", uuid2),
      ).toBeNull();
    });

    test("the direct probe ignores tuples with subject_relation", async () => {
      await store.insertTuple(
        ungatedTuple({
          objectType: "channel",
          objectId: uuid1,
          relation: "writer",
          subjectType: "workspace",
          subjectId: uuid2,
          subjectRelation: "member",
        }),
      );

      expect(
        await readDirect("channel", uuid1, "writer", "workspace", uuid2),
      ).toBeNull();
    });

    test("the userset part returns only subject_relation rows", async () => {
      await store.insertTuple(
        ungatedTuple({
          objectType: "channel",
          objectId: uuid1,
          relation: "writer",
          subjectType: "workspace",
          subjectId: uuid2,
          subjectRelation: "member",
        }),
      );
      // Direct tuple should not appear
      await store.insertTuple(
        ungatedTuple({
          objectType: "channel",
          objectId: uuid1,
          relation: "writer",
          subjectType: "user",
          subjectId: uuid3,
        }),
      );

      const { direct, wildcard, usersets } = await store.findCheckTuples({
        objectType: "channel",
        objectId: uuid1,
        relation: "writer",
        subjectType: "user",
        subjectId: uuid3,
        directRefs: [],
        wildcardRefs: [],
        usersetRefs: null,
      });
      expect(usersets).toHaveLength(1);
      expect(usersets[0]?.subjectRelation).toBe("member");
      // The parts the query excluded stay empty even though rows
      // matching them exist.
      expect(direct).toBeNull();
      expect(wildcard).toHaveLength(0);
    });

    test("findTuplesByRelation returns all tuples", async () => {
      await store.insertTuple(
        ungatedTuple({
          objectType: "channel",
          objectId: uuid1,
          relation: "writer",
          subjectType: "user",
          subjectId: uuid2,
        }),
      );
      await store.insertTuple(
        ungatedTuple({
          objectType: "channel",
          objectId: uuid1,
          relation: "writer",
          subjectType: "workspace",
          subjectId: uuid3,
          subjectRelation: "member",
        }),
      );

      const tuples = await store.findTuplesByRelation(
        "channel",
        uuid1,
        "writer",
      );
      expect(tuples).toHaveLength(2);
    });

    test("insertTuple reports a conflict and writes nothing", async () => {
      // The natural key excludes the condition, so this used to be
      // an upsert that replaced `old_cond` with `new_cond` and said
      // nothing about it. Upstream has no write that edits a row in
      // place: the row stands, and `addTuple` turns the `false`
      // into a `DuplicateTupleError`.
      const first = await store.insertTuple(
        ungatedTuple({
          objectType: "workspace",
          objectId: uuid1,
          relation: "member",
          subjectType: "user",
          subjectId: uuid2,
          conditionName: "old_cond",
        }),
      );
      const second = await store.insertTuple(
        ungatedTuple({
          objectType: "workspace",
          objectId: uuid1,
          relation: "member",
          subjectType: "user",
          subjectId: uuid2,
          conditionName: "new_cond",
        }),
      );

      expect(first).toBe(true);
      expect(second).toBe(false);

      const tuple = await readDirect(
        "workspace",
        uuid1,
        "member",
        "user",
        uuid2,
      );
      expect(tuple?.conditionName).toBe("old_cond");
    });

    test("insertTuple with condition context", async () => {
      await store.insertTuple(
        ungatedTuple({
          objectType: "doc",
          objectId: uuid1,
          relation: "viewer",
          subjectType: "user",
          subjectId: uuid2,
          conditionName: "in_region",
          conditionContext: { region: "us" },
        }),
      );

      const tuple = await readDirect("doc", uuid1, "viewer", "user", uuid2);
      expect(tuple?.conditionName).toBe("in_region");
      expect(tuple?.conditionContext).toEqual({ region: "us" });
    });

    test("deleteTuple", async () => {
      await store.insertTuple(
        ungatedTuple({
          objectType: "workspace",
          objectId: uuid1,
          relation: "member",
          subjectType: "user",
          subjectId: uuid2,
        }),
      );

      expect(
        await store.deleteTuple({
          objectType: "workspace",
          objectId: uuid1,
          relation: "member",
          subjectType: "user",
          subjectId: uuid2,
        }),
      ).toBe(true);

      expect(
        await readDirect("workspace", uuid1, "member", "user", uuid2),
      ).toBeNull();
    });

    test("deleteTuple with subject_relation", async () => {
      await store.insertTuple(
        ungatedTuple({
          objectType: "channel",
          objectId: uuid1,
          relation: "writer",
          subjectType: "workspace",
          subjectId: uuid2,
          subjectRelation: "member",
        }),
      );

      expect(
        await store.deleteTuple({
          objectType: "channel",
          objectId: uuid1,
          relation: "writer",
          subjectType: "workspace",
          subjectId: uuid2,
          subjectRelation: "member",
        }),
      ).toBe(true);
    });

    test("deleteTuple returns false for missing", async () => {
      expect(
        await store.deleteTuple({
          objectType: "workspace",
          objectId: uuid1,
          relation: "member",
          subjectType: "user",
          subjectId: uuid2,
        }),
      ).toBe(false);
    });
  });

  describe("Null round-trips", () => {
    test("tuple without optional fields returns null", async () => {
      await store.insertTuple(
        ungatedTuple({
          objectType: "workspace",
          objectId: uuid1,
          relation: "member",
          subjectType: "user",
          subjectId: uuid2,
        }),
      );

      const tuple = await readDirect(
        "workspace",
        uuid1,
        "member",
        "user",
        uuid2,
      );
      expect(tuple?.subjectRelation).toBeNull();
      expect(tuple?.conditionName).toBeNull();
      expect(tuple?.conditionContext).toBeNull();
    });

    test("a second write does not clear conditionName", async () => {
      // This asserted the opposite while `insertTuple` was an
      // upsert, and that is the widening direction: a conditioned
      // grant became a permanent one because someone re-wrote the
      // edge without its condition. The row stands.
      await store.insertTuple(
        ungatedTuple({
          objectType: "doc",
          objectId: uuid1,
          relation: "viewer",
          subjectType: "user",
          subjectId: uuid2,
          conditionName: "in_region",
        }),
      );
      const second = await store.insertTuple(
        ungatedTuple({
          objectType: "doc",
          objectId: uuid1,
          relation: "viewer",
          subjectType: "user",
          subjectId: uuid2,
          conditionName: null,
        }),
      );

      expect(second).toBe(false);
      const tuple = await readDirect("doc", uuid1, "viewer", "user", uuid2);
      expect(tuple?.conditionName).toBe("in_region");
    });

    test("deleting then writing clears the condition", async () => {
      // The supported way to change a grant's condition, and the
      // only one upstream has.
      const key = {
        objectType: "doc",
        objectId: uuid1,
        relation: "viewer",
        subjectType: "user",
        subjectId: uuid2,
      };
      await store.insertTuple(
        ungatedTuple({
          ...key,
          conditionName: "in_region",
          conditionContext: { region: "us" },
        }),
      );
      expect(await store.deleteTuple(key)).toBe(true);
      expect(await store.insertTuple(ungatedTuple(key))).toBe(true);

      const tuple = await readDirect("doc", uuid1, "viewer", "user", uuid2);
      expect(tuple?.conditionName).toBeNull();
      expect(tuple?.conditionContext).toBeNull();
    });

    test("relation config nullable fields return null", async () => {
      await store.upsertRelationConfig(
        ungatedConfig({
          objectType: "workspace",
          relation: "member",
          directlyAssignable: [
            { type: "user" },
            { type: "user", wildcard: true },
            { type: "workspace" },
            { type: "workspace", wildcard: true },
          ],
          impliedBy: null,
          computedUserset: null,
          tupleToUserset: null,
          excludedBy: null,
          intersection: null,
        }),
      );

      const config = await store.findRelationConfig("workspace", "member");
      expect(config?.directlyAssignable).toEqual([
        { type: "user" },
        { type: "user", wildcard: true },
        { type: "workspace" },
        { type: "workspace", wildcard: true },
      ]);
      expect(config?.impliedBy).toBeNull();
      expect(config?.computedUserset).toBeNull();
      expect(config?.tupleToUserset).toBeNull();
    });

    test("upsert clears relation config impliedBy with null", async () => {
      await store.upsertRelationConfig(
        ungatedConfig({
          objectType: "workspace",
          relation: "member",
          directlyAssignable: [{ type: "user" }],
          impliedBy: ["channels_admin"],
          computedUserset: null,
          tupleToUserset: null,
          excludedBy: null,
          intersection: null,
        }),
      );
      await store.upsertRelationConfig(
        ungatedConfig({
          objectType: "workspace",
          relation: "member",
          directlyAssignable: [{ type: "user" }],
          impliedBy: null,
          computedUserset: null,
          tupleToUserset: null,
          excludedBy: null,
          intersection: null,
        }),
      );

      const config = await store.findRelationConfig("workspace", "member");
      expect(config?.impliedBy).toBeNull();
    });

    test("condition definition parameters null round-trip", async () => {
      await store.upsertConditionDefinition({
        name: "no_params",
        expression: "true",
        parameters: null,
      });

      const cond = await store.findConditionDefinition("no_params");
      expect(cond?.parameters).toBeNull();
    });

    test("upsert clears condition definition parameters", async () => {
      await store.upsertConditionDefinition({
        name: "test_cond",
        expression: 'region == "us"',
        parameters: { region: "string" },
      });
      await store.upsertConditionDefinition({
        name: "test_cond",
        expression: "true",
        parameters: null,
      });

      const cond = await store.findConditionDefinition("test_cond");
      expect(cond?.parameters).toBeNull();
    });
  });

  describe("Wildcard subjects", () => {
    /**
     * An ordinary subject id that used to be the wildcard's
     * storage encoding. Since `006` it is reserved by nothing.
     */
    const nilUuid = "00000000-0000-0000-0000-000000000000";

    test("insertTuple stores the wildcard out of the id namespace", async () => {
      await store.insertTuple(
        ungatedTuple({
          objectType: "doc",
          objectId: uuid1,
          relation: "viewer",
          subjectType: "user",
          subjectId: "*",
        }),
      );

      // The shape is a column of its own and the id is absent, so
      // no id value is reserved and the nil UUID is free to be an
      // ordinary subject -- which the two tests below assert.
      const row = await db
        .selectFrom("tsfga.tuples")
        .select(["subject_id", "subject_wildcard"])
        .where("object_type", "=", "doc")
        .where("object_id", "=", uuid1)
        .executeTakeFirst();
      expect(row?.subject_id).toBeNull();
      expect(row?.subject_wildcard).toBe(true);
    });

    test("the direct probe reads the wildcard back as *", async () => {
      await store.insertTuple(
        ungatedTuple({
          objectType: "doc",
          objectId: uuid1,
          relation: "viewer",
          subjectType: "user",
          subjectId: "*",
        }),
      );

      const tuple = await readDirect("doc", uuid1, "viewer", "user", "*");
      expect(tuple).not.toBeNull();
      expect(tuple?.subjectId).toBe("*");
    });

    test("findTuplesByRelation reads the wildcard back as *", async () => {
      await store.insertTuple(
        ungatedTuple({
          objectType: "doc",
          objectId: uuid1,
          relation: "viewer",
          subjectType: "user",
          subjectId: "*",
        }),
      );

      const tuples = await store.findTuplesByRelation("doc", uuid1, "viewer");
      expect(tuples).toHaveLength(1);
      expect(tuples[0]?.subjectId).toBe("*");
    });

    test("a wildcard row and a concrete row stay distinct", async () => {
      await store.insertTuple(
        ungatedTuple({
          objectType: "doc",
          objectId: uuid1,
          relation: "viewer",
          subjectType: "user",
          subjectId: "*",
        }),
      );
      await store.insertTuple(
        ungatedTuple({
          objectType: "doc",
          objectId: uuid1,
          relation: "viewer",
          subjectType: "user",
          subjectId: uuid2,
        }),
      );

      const subjects = await store.findTuplesByRelation("doc", uuid1, "viewer");
      expect(subjects).toHaveLength(2);
      expect(subjects.find((t) => t.subjectId === "*")).toBeTruthy();
      expect(subjects.find((t) => t.subjectId === uuid2)).toBeTruthy();
    });

    /**
     * The nil UUID used to *be* the wildcard's storage
     * encoding, so a grant written for it read back as `"*"` and
     * granted every subject of the type, while the subject it was
     * written for stopped matching. Both halves are asserted:
     * the grant belongs to the subject it names, and it is not
     * the wildcard row.
     */
    test("the nil UUID is an ordinary subject, not the wildcard", async () => {
      await store.insertTuple(
        ungatedTuple({
          objectType: "doc",
          objectId: uuid1,
          relation: "viewer",
          subjectType: "user",
          subjectId: nilUuid,
        }),
      );

      const own = await readDirect("doc", uuid1, "viewer", "user", nilUuid);
      expect(own?.subjectId).toBe(nilUuid);

      const { wildcard } = await store.findCheckTuples({
        objectType: "doc",
        objectId: uuid1,
        relation: "viewer",
        subjectType: "user",
        subjectId: uuid2,
        directRefs: [],
        wildcardRefs: null,
        usersetRefs: [],
      });
      expect(wildcard).toHaveLength(0);
    });

    test("a nil-UUID grant and a wildcard grant coexist", async () => {
      await store.insertTuple(
        ungatedTuple({
          objectType: "doc",
          objectId: uuid1,
          relation: "viewer",
          subjectType: "user",
          subjectId: nilUuid,
        }),
      );
      await store.insertTuple(
        ungatedTuple({
          objectType: "doc",
          objectId: uuid1,
          relation: "viewer",
          subjectType: "user",
          subjectId: "*",
        }),
      );

      const tuples = await store.findTuplesByRelation("doc", uuid1, "viewer");
      expect(tuples).toHaveLength(2);

      // Deleting one leaves the other: they are different rows,
      // not two spellings of one.
      expect(
        await store.deleteTuple({
          objectType: "doc",
          objectId: uuid1,
          relation: "viewer",
          subjectType: "user",
          subjectId: nilUuid,
        }),
      ).toBe(true);
      const left = await store.findTuplesByRelation("doc", uuid1, "viewer");
      expect(left).toHaveLength(1);
      expect(left[0]?.subjectId).toBe("*");
    });

    test("deleteTuple removes a wildcard tuple by *", async () => {
      await store.insertTuple(
        ungatedTuple({
          objectType: "doc",
          objectId: uuid1,
          relation: "viewer",
          subjectType: "user",
          subjectId: "*",
        }),
      );

      expect(
        await store.deleteTuple({
          objectType: "doc",
          objectId: uuid1,
          relation: "viewer",
          subjectType: "user",
          subjectId: "*",
        }),
      ).toBe(true);
      expect(await readDirect("doc", uuid1, "viewer", "user", "*")).toBeNull();
    });
  });

  /**
   * The `uuid` column's grammar, from the other end. `object_id` is
   * a `uuid` column,
   * and that column's input grammar is many-to-one: the uppercase,
   * hyphenless, braced, braced-hyphenless and odd-hyphen spellings
   * of one value all store as the same row, while OpenFGA holds
   * them apart as distinct objects.
   *
   * That is the measurement `CANONICAL_UUID_IDS` exists for, and
   * it is asserted here rather than argued: the store is where the
   * folding happens, and core's gate is what stops a caller
   * reaching it. These calls go straight to the store, so the gate
   * is deliberately out of the way.
   *
   * The three tests this replaces asserted the opposite -- that
   * the two spellings were two rows -- because migrations `006`
   * and `007` had made both columns `text`. Both are deleted; that
   * premise is retired, and with it the third test, which round-
   * tripped `readme.md`.
   */
  describe("a uuid column folds the spellings OpenFGA holds apart", () => {
    test("the uppercase spelling reads back the same row", async () => {
      const lower = "00000000-0000-4000-a000-0000000000ff";
      const upper = lower.toUpperCase();

      await store.insertTuple(
        ungatedTuple({
          objectType: "doc",
          objectId: upper,
          relation: "viewer",
          subjectType: "user",
          subjectId: uuid2,
        }),
      );

      // One row, reachable under either spelling and reported
      // under the canonical one. Two objects upstream.
      const written = await readDirect("doc", upper, "viewer", "user", uuid2);
      expect(written?.objectId).toBe(lower);
      const other = await readDirect("doc", lower, "viewer", "user", uuid2);
      expect(other?.objectId).toBe(lower);
      expect(
        await store.findTuplesByRelation("doc", lower, "viewer"),
      ).toHaveLength(1);
    });

    test("the hyphenless spelling reads back the same row", async () => {
      const hyphenated = "00000000-0000-4000-a000-0000000000fe";
      const bare = hyphenated.replaceAll("-", "");

      await store.insertTuple(
        ungatedTuple({
          objectType: "doc",
          objectId: bare,
          relation: "viewer",
          subjectType: "user",
          subjectId: uuid2,
        }),
      );

      expect(
        (await readDirect("doc", bare, "viewer", "user", uuid2))?.objectId,
      ).toBe(hyphenated);
      expect(
        (await readDirect("doc", hyphenated, "viewer", "user", uuid2))
          ?.objectId,
      ).toBe(hyphenated);
    });

    test("a subject id folds the same way", async () => {
      const lower = "00000000-0000-4000-a000-0000000000fd";

      await store.insertTuple(
        ungatedTuple({
          objectType: "doc",
          objectId: uuid1,
          relation: "viewer",
          subjectType: "user",
          subjectId: lower.toUpperCase(),
        }),
      );

      expect(
        (await readDirect("doc", uuid1, "viewer", "user", lower))?.subjectId,
      ).toBe(lower);
    });
  });

  /**
   * The merged read has to return exactly the rows the three
   * separate predicates would have. The oracle here is
   * `findTuplesByRelation`, which returns every row on the
   * object+relation and is independent of the query being tested:
   * partitioning its output by the same three predicates gives the
   * expected answer without reusing the code under test.
   *
   * Run over every combination of the three flags, on a fixture
   * that puts a matching row in each part plus rows that must not
   * be picked up — a different subject, a different subject type,
   * a different relation.
   */
  describe("the merged read agrees with the predicates it replaces", () => {
    const parts = [false, true];

    async function seed() {
      const rows = [
        // The subject's own direct tuple.
        { subjectType: "user", subjectId: uuid2 },
        // The public wildcard.
        { subjectType: "user", subjectId: "*" },
        // Two usersets.
        { subjectType: "team", subjectId: uuid3, subjectRelation: "member" },
        { subjectType: "team", subjectId: uuid1, subjectRelation: "owner" },
        // Must never be returned: another subject of the same
        // type, and a wildcard of a different type.
        { subjectType: "user", subjectId: uuid3 },
        { subjectType: "robot", subjectId: "*" },
      ];
      for (const row of rows) {
        await store.insertTuple(
          ungatedTuple({
            objectType: "doc",
            objectId: uuid1,
            relation: "viewer",
            ...row,
          }),
        );
      }
      // Same object, different relation — out of scope entirely.
      await store.insertTuple(
        ungatedTuple({
          objectType: "doc",
          objectId: uuid1,
          relation: "editor",
          subjectType: "user",
          subjectId: uuid2,
        }),
      );
    }

    for (const includeDirect of parts) {
      for (const includeWildcard of parts) {
        for (const includeUsersets of parts) {
          const label = [
            includeDirect ? "direct" : null,
            includeWildcard ? "wildcard" : null,
            includeUsersets ? "usersets" : null,
          ]
            .filter((part) => part !== null)
            .join("+");

          test(`${label || "nothing"} requested`, async () => {
            await seed();

            const all = await store.findTuplesByRelation(
              "doc",
              uuid1,
              "viewer",
            );
            const expected = {
              direct: includeDirect
                ? (all.find(
                    (t) =>
                      t.subjectType === "user" &&
                      t.subjectId === uuid2 &&
                      t.subjectRelation === null,
                  ) ?? null)
                : null,
              // A list since the wildcard slot became one; the
              // unique index means it holds 0 or 1 rows here.
              wildcard: includeWildcard
                ? all.filter(
                    (t) =>
                      t.subjectType === "user" &&
                      t.subjectId === "*" &&
                      t.subjectRelation === null,
                  )
                : [],
              usersets: includeUsersets
                ? all.filter((t) => t.subjectRelation !== null)
                : [],
              // `null` asks for every userset row, `[]` for none —
              // the two ends the flag used to stand for.
            };

            const actual = await store.findCheckTuples({
              objectType: "doc",
              objectId: uuid1,
              relation: "viewer",
              subjectType: "user",
              subjectId: uuid2,
              directRefs: includeDirect ? null : [],
              wildcardRefs: includeWildcard ? null : [],
              usersetRefs: includeUsersets ? null : [],
            });

            expect(actual.direct).toEqual(expected.direct);
            expect(actual.wildcard).toEqual(expected.wildcard);
            // Row order is not part of the contract; compare as
            // sets keyed by the subject.
            expect(sortedBySubject(actual.usersets)).toEqual(
              sortedBySubject(expected.usersets),
            );
          });
        }
      }
    }

    test("a wildcard subject lands in the direct slot, not both", async () => {
      // Checking `user:*` itself makes the two probes the same
      // query. It must be reported once, and as the direct hit.
      await seed();

      const result = await store.findCheckTuples({
        objectType: "doc",
        objectId: uuid1,
        relation: "viewer",
        subjectType: "user",
        subjectId: "*",
        directRefs: null,
        wildcardRefs: null,
        usersetRefs: [],
      });

      expect(result.direct?.subjectId).toBe("*");
      expect(result.wildcard).toHaveLength(0);
    });
  });

  describe("Intersection round-trip", () => {
    test("all operand kinds survive upsert and read", async () => {
      const intersection = [
        { type: "direct" as const },
        { type: "computedUserset" as const, relation: "member" },
        {
          type: "tupleToUserset" as const,
          tupleset: "owner",
          computedUserset: "admin",
        },
      ];
      await store.upsertRelationConfig(
        ungatedConfig({
          objectType: "resource",
          relation: "can_edit",
          directlyAssignable: [{ type: "user" }],
          impliedBy: null,
          computedUserset: null,
          tupleToUserset: null,
          excludedBy: null,
          intersection,
        }),
      );

      const config = await store.findRelationConfig("resource", "can_edit");
      expect(config?.intersection).toEqual(intersection);
    });

    test("upsert replaces an existing intersection", async () => {
      await store.upsertRelationConfig(
        ungatedConfig({
          objectType: "resource",
          relation: "can_edit",
          directlyAssignable: [
            { type: "user" },
            { type: "user", wildcard: true },
            { type: "workspace" },
            { type: "workspace", wildcard: true },
          ],
          impliedBy: null,
          computedUserset: null,
          tupleToUserset: null,
          excludedBy: null,
          intersection: [{ type: "direct" }],
        }),
      );
      await store.upsertRelationConfig(
        ungatedConfig({
          objectType: "resource",
          relation: "can_edit",
          directlyAssignable: [
            { type: "user" },
            { type: "user", wildcard: true },
            { type: "workspace" },
            { type: "workspace", wildcard: true },
          ],
          impliedBy: null,
          computedUserset: null,
          tupleToUserset: null,
          excludedBy: null,
          intersection: [{ type: "computedUserset", relation: "member" }],
        }),
      );

      const config = await store.findRelationConfig("resource", "can_edit");
      expect(config?.intersection).toEqual([
        { type: "computedUserset", relation: "member" },
      ]);
    });
  });

  describe("Query methods", () => {
    test("listCandidateObjectIds", async () => {
      await store.insertTuple(
        ungatedTuple({
          objectType: "channel",
          objectId: uuid1,
          relation: "writer",
          subjectType: "user",
          subjectId: uuid2,
        }),
      );
      await store.insertTuple(
        ungatedTuple({
          objectType: "channel",
          objectId: uuid3,
          relation: "writer",
          subjectType: "user",
          subjectId: uuid2,
        }),
      );

      const ids = await store.listCandidateObjectIds("channel");
      expect(ids.sort()).toEqual([uuid1, uuid3].sort());
    });

    test("findTuplesByRelation returns direct and userset rows", async () => {
      await store.insertTuple(
        ungatedTuple({
          objectType: "channel",
          objectId: uuid1,
          relation: "writer",
          subjectType: "user",
          subjectId: uuid2,
        }),
      );
      await store.insertTuple(
        ungatedTuple({
          objectType: "channel",
          objectId: uuid1,
          relation: "writer",
          subjectType: "workspace",
          subjectId: uuid3,
          subjectRelation: "member",
        }),
      );

      const subjects = await store.findTuplesByRelation(
        "channel",
        uuid1,
        "writer",
      );
      expect(subjects).toHaveLength(2);
      expect(subjects.find((t) => t.subjectId === uuid2)).toBeTruthy();
      expect(subjects.find((t) => t.subjectRelation === "member")).toBeTruthy();
    });
  });

  /**
   * A consumer's result-transforming plugin must not change how the
   * adapter reads its own tables.
   *
   * `CamelCasePlugin.transformResult` renames every result-row key
   * regardless of how the query was built, so an adapter that reads
   * `row.subject_relation` gets `undefined` — which is not `null`,
   * so every row files as a userset and `direct` is always null.
   * Silent, and wrong in the granting direction.
   *
   * `withPlugin` returns an instance sharing this one's executor, so
   * these reads run on the same connection and see the surrounding
   * transaction.
   */
  describe("consumer result plugins do not reach adapter reads", () => {
    let camelStore: KyselyTupleStore;

    beforeEach(() => {
      camelStore = new KyselyTupleStore(db.withPlugin(new CamelCasePlugin()));
    });

    test("findCheckTuples partitions rows correctly", async () => {
      await store.insertTuple(
        ungatedTuple({
          objectType: "channel",
          objectId: uuid1,
          relation: "writer",
          subjectType: "user",
          subjectId: uuid2,
        }),
      );
      await store.insertTuple(
        ungatedTuple({
          objectType: "channel",
          objectId: uuid1,
          relation: "writer",
          subjectType: "workspace",
          subjectId: uuid3,
          subjectRelation: "member",
        }),
      );

      const result = await camelStore.findCheckTuples({
        objectType: "channel",
        objectId: uuid1,
        relation: "writer",
        subjectType: "user",
        subjectId: uuid2,
        directRefs: null,
        wildcardRefs: null,
        usersetRefs: null,
      });

      expect(result.direct).not.toBeNull();
      expect(result.direct?.subjectId).toBe(uuid2);
      expect(result.direct?.subjectRelation).toBeNull();
      expect(result.wildcard).toHaveLength(0);
      expect(result.usersets).toHaveLength(1);
      expect(result.usersets[0]?.subjectRelation).toBe("member");
    });

    test("findCheckTuples maps the wildcard row back", async () => {
      await store.insertTuple(
        ungatedTuple({
          objectType: "channel",
          objectId: uuid1,
          relation: "writer",
          subjectType: "user",
          subjectId: "*",
        }),
      );

      const result = await camelStore.findCheckTuples({
        objectType: "channel",
        objectId: uuid1,
        relation: "writer",
        subjectType: "user",
        subjectId: uuid2,
        directRefs: null,
        wildcardRefs: null,
        usersetRefs: null,
      });

      expect(result.direct).toBeNull();
      expect(result.wildcard).toHaveLength(1);
      expect(result.wildcard[0]?.subjectId).toBe("*");
    });

    test("rowToTuple carries every field", async () => {
      await store.upsertConditionDefinition({
        name: "in_hours",
        expression: "hour < 18",
        parameters: { hour: "int" },
      });
      await store.insertTuple(
        ungatedTuple({
          objectType: "channel",
          objectId: uuid1,
          relation: "writer",
          subjectType: "user",
          subjectId: uuid2,
          conditionName: "in_hours",
          conditionContext: { hour: 9 },
        }),
      );

      const tuples = await camelStore.findTuplesByRelation(
        "channel",
        uuid1,
        "writer",
      );
      expect(tuples).toHaveLength(1);
      expect(tuples[0]).toEqual({
        objectType: "channel",
        objectId: uuid1,
        relation: "writer",
        subjectType: "user",
        subjectId: uuid2,
        subjectRelation: null,
        conditionName: "in_hours",
        conditionContext: { hour: 9 },
      });
    });

    test("findRelationConfig round-trips", async () => {
      await store.upsertRelationConfig(
        ungatedConfig({
          objectType: "channel",
          relation: "writer",
          directlyAssignable: [
            { type: "user" },
            { type: "workspace", relation: "member" },
          ],
          impliedBy: ["admin"],
          computedUserset: null,
          tupleToUserset: [{ tupleset: "parent", computedUserset: "member" }],
          excludedBy: "banned",
          intersection: null,
        }),
      );

      const config = await camelStore.findRelationConfig("channel", "writer");
      expect(config).not.toBeNull();
      expect(config?.objectType).toBe("channel");
      expect(config?.relation).toBe("writer");
      expect(config?.directlyAssignable).toEqual([
        { type: "user" },
        { type: "workspace", relation: "member" },
      ]);
      expect(config?.impliedBy).toEqual(["admin"]);
      expect(config?.tupleToUserset).toEqual([
        { tupleset: "parent", computedUserset: "member" },
      ]);
      expect(config?.excludedBy).toBe("banned");
    });

    test("findConditionDefinition round-trips", async () => {
      await store.upsertConditionDefinition({
        name: "in_hours",
        expression: "hour < 18",
        parameters: { hour: "int" },
      });

      const def = await camelStore.findConditionDefinition("in_hours");
      expect(def).not.toBeNull();
      expect(def?.name).toBe("in_hours");
      expect(def?.expression).toBe("hour < 18");
      expect(def?.parameters).toEqual({ hour: "int" });
    });

    test("the query methods round-trip", async () => {
      await store.insertTuple(
        ungatedTuple({
          objectType: "channel",
          objectId: uuid1,
          relation: "writer",
          subjectType: "workspace",
          subjectId: uuid3,
          subjectRelation: "member",
        }),
      );

      expect(await camelStore.listCandidateObjectIds("channel")).toEqual([
        uuid1,
      ]);
      expect(
        await camelStore.findTuplesByRelation("channel", uuid1, "writer"),
      ).toEqual([
        {
          objectType: "channel",
          objectId: uuid1,
          relation: "writer",
          subjectType: "workspace",
          subjectId: uuid3,
          subjectRelation: "member",
          conditionName: null,
          conditionContext: null,
        },
      ]);
    });
  });
});
