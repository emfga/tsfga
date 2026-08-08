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
import type { Kysely } from "kysely";
import { KyselyTupleStore } from "../src/adapter.ts";
import type { DB } from "../src/schema.ts";
import {
  beginTransaction,
  destroyDb,
  getDb,
  rollbackTransaction,
} from "./helpers/db.ts";

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
      includeDirect: true,
      includeWildcard: false,
      includeUsersets: false,
    });
    return direct;
  }

  describe("Relation configs", () => {
    test("upsertRelationConfig and findRelationConfig", async () => {
      await store.upsertRelationConfig({
        objectType: "workspace",
        relation: "member",
        directlyAssignableTypes: ["user"],
        impliedBy: ["channels_admin"],
        computedUserset: null,
        tupleToUserset: null,
        excludedBy: null,
        intersection: null,
        allowsUsersetSubjects: false,
      });

      const config = await store.findRelationConfig("workspace", "member");
      expect(config).not.toBeNull();
      expect(config?.objectType).toBe("workspace");
      expect(config?.relation).toBe("member");
      expect(config?.directlyAssignableTypes).toEqual(["user"]);
      expect(config?.impliedBy).toEqual(["channels_admin"]);
      expect(config?.allowsUsersetSubjects).toBe(false);
    });

    test("findRelationConfig returns null for missing config", async () => {
      const config = await store.findRelationConfig("nonexistent", "rel");
      expect(config).toBeNull();
    });

    test("upsertRelationConfig updates existing", async () => {
      await store.upsertRelationConfig({
        objectType: "workspace",
        relation: "member",
        directlyAssignableTypes: ["user"],
        impliedBy: null,
        computedUserset: null,
        tupleToUserset: null,
        excludedBy: null,
        intersection: null,
        allowsUsersetSubjects: false,
      });
      await store.upsertRelationConfig({
        objectType: "workspace",
        relation: "member",
        directlyAssignableTypes: ["user", "team"],
        impliedBy: null,
        computedUserset: null,
        tupleToUserset: null,
        excludedBy: null,
        intersection: null,
        allowsUsersetSubjects: true,
      });

      const config = await store.findRelationConfig("workspace", "member");
      expect(config?.directlyAssignableTypes).toEqual(["user", "team"]);
      expect(config?.allowsUsersetSubjects).toBe(true);
    });

    test("deleteRelationConfig", async () => {
      await store.upsertRelationConfig({
        objectType: "workspace",
        relation: "member",
        directlyAssignableTypes: null,
        impliedBy: null,
        computedUserset: null,
        tupleToUserset: null,
        excludedBy: null,
        intersection: null,
        allowsUsersetSubjects: false,
      });
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
      await store.upsertRelationConfig({
        objectType: "repo",
        relation: "reader",
        directlyAssignableTypes: null,
        impliedBy: null,
        computedUserset: null,
        tupleToUserset: [
          { tupleset: "organization", computedUserset: "member" },
        ],
        excludedBy: null,
        intersection: null,
        allowsUsersetSubjects: false,
      });

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
      await store.insertTuple({
        objectType: "workspace",
        objectId: uuid1,
        relation: "member",
        subjectType: "user",
        subjectId: uuid2,
      });

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
      await store.insertTuple({
        objectType: "channel",
        objectId: uuid1,
        relation: "writer",
        subjectType: "workspace",
        subjectId: uuid2,
        subjectRelation: "member",
      });

      expect(
        await readDirect("channel", uuid1, "writer", "workspace", uuid2),
      ).toBeNull();
    });

    test("the userset part returns only subject_relation rows", async () => {
      await store.insertTuple({
        objectType: "channel",
        objectId: uuid1,
        relation: "writer",
        subjectType: "workspace",
        subjectId: uuid2,
        subjectRelation: "member",
      });
      // Direct tuple should not appear
      await store.insertTuple({
        objectType: "channel",
        objectId: uuid1,
        relation: "writer",
        subjectType: "user",
        subjectId: uuid3,
      });

      const { direct, wildcard, usersets } = await store.findCheckTuples({
        objectType: "channel",
        objectId: uuid1,
        relation: "writer",
        subjectType: "user",
        subjectId: uuid3,
        includeDirect: false,
        includeWildcard: false,
        includeUsersets: true,
      });
      expect(usersets).toHaveLength(1);
      expect(usersets[0]?.subjectRelation).toBe("member");
      // The parts the query excluded stay empty even though rows
      // matching them exist.
      expect(direct).toBeNull();
      expect(wildcard).toBeNull();
    });

    test("findTuplesByRelation returns all tuples", async () => {
      await store.insertTuple({
        objectType: "channel",
        objectId: uuid1,
        relation: "writer",
        subjectType: "user",
        subjectId: uuid2,
      });
      await store.insertTuple({
        objectType: "channel",
        objectId: uuid1,
        relation: "writer",
        subjectType: "workspace",
        subjectId: uuid3,
        subjectRelation: "member",
      });

      const tuples = await store.findTuplesByRelation(
        "channel",
        uuid1,
        "writer",
      );
      expect(tuples).toHaveLength(2);
    });

    test("insertTuple upserts on conflict", async () => {
      await store.insertTuple({
        objectType: "workspace",
        objectId: uuid1,
        relation: "member",
        subjectType: "user",
        subjectId: uuid2,
        conditionName: "old_cond",
      });
      await store.insertTuple({
        objectType: "workspace",
        objectId: uuid1,
        relation: "member",
        subjectType: "user",
        subjectId: uuid2,
        conditionName: "new_cond",
      });

      const tuple = await readDirect(
        "workspace",
        uuid1,
        "member",
        "user",
        uuid2,
      );
      expect(tuple?.conditionName).toBe("new_cond");
    });

    test("insertTuple with condition context", async () => {
      await store.insertTuple({
        objectType: "doc",
        objectId: uuid1,
        relation: "viewer",
        subjectType: "user",
        subjectId: uuid2,
        conditionName: "in_region",
        conditionContext: { region: "us" },
      });

      const tuple = await readDirect("doc", uuid1, "viewer", "user", uuid2);
      expect(tuple?.conditionName).toBe("in_region");
      expect(tuple?.conditionContext).toEqual({ region: "us" });
    });

    test("deleteTuple", async () => {
      await store.insertTuple({
        objectType: "workspace",
        objectId: uuid1,
        relation: "member",
        subjectType: "user",
        subjectId: uuid2,
      });

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
      await store.insertTuple({
        objectType: "channel",
        objectId: uuid1,
        relation: "writer",
        subjectType: "workspace",
        subjectId: uuid2,
        subjectRelation: "member",
      });

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
      await store.insertTuple({
        objectType: "workspace",
        objectId: uuid1,
        relation: "member",
        subjectType: "user",
        subjectId: uuid2,
      });

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

    test("upsert clears conditionName with null", async () => {
      await store.insertTuple({
        objectType: "doc",
        objectId: uuid1,
        relation: "viewer",
        subjectType: "user",
        subjectId: uuid2,
        conditionName: "in_region",
      });
      await store.insertTuple({
        objectType: "doc",
        objectId: uuid1,
        relation: "viewer",
        subjectType: "user",
        subjectId: uuid2,
        conditionName: null,
      });

      const tuple = await readDirect("doc", uuid1, "viewer", "user", uuid2);
      expect(tuple?.conditionName).toBeNull();
    });

    test("upsert clears conditionContext with null", async () => {
      await store.insertTuple({
        objectType: "doc",
        objectId: uuid1,
        relation: "viewer",
        subjectType: "user",
        subjectId: uuid2,
        conditionName: "in_region",
        conditionContext: { region: "us" },
      });
      await store.insertTuple({
        objectType: "doc",
        objectId: uuid1,
        relation: "viewer",
        subjectType: "user",
        subjectId: uuid2,
        conditionName: "in_region",
        conditionContext: null,
      });

      const tuple = await readDirect("doc", uuid1, "viewer", "user", uuid2);
      expect(tuple?.conditionContext).toBeNull();
    });

    test("relation config nullable fields return null", async () => {
      await store.upsertRelationConfig({
        objectType: "workspace",
        relation: "member",
        directlyAssignableTypes: null,
        impliedBy: null,
        computedUserset: null,
        tupleToUserset: null,
        excludedBy: null,
        intersection: null,
        allowsUsersetSubjects: false,
      });

      const config = await store.findRelationConfig("workspace", "member");
      expect(config?.directlyAssignableTypes).toBeNull();
      expect(config?.impliedBy).toBeNull();
      expect(config?.computedUserset).toBeNull();
      expect(config?.tupleToUserset).toBeNull();
    });

    test("upsert clears relation config impliedBy with null", async () => {
      await store.upsertRelationConfig({
        objectType: "workspace",
        relation: "member",
        directlyAssignableTypes: ["user"],
        impliedBy: ["channels_admin"],
        computedUserset: null,
        tupleToUserset: null,
        excludedBy: null,
        intersection: null,
        allowsUsersetSubjects: false,
      });
      await store.upsertRelationConfig({
        objectType: "workspace",
        relation: "member",
        directlyAssignableTypes: ["user"],
        impliedBy: null,
        computedUserset: null,
        tupleToUserset: null,
        excludedBy: null,
        intersection: null,
        allowsUsersetSubjects: false,
      });

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
    const sentinel = "00000000-0000-0000-0000-000000000000";

    test("insertTuple stores the wildcard as the nil UUID", async () => {
      await store.insertTuple({
        objectType: "doc",
        objectId: uuid1,
        relation: "viewer",
        subjectType: "user",
        subjectId: "*",
      });

      const row = await db
        .selectFrom("tsfga.tuples")
        .select("subject_id")
        .where("object_type", "=", "doc")
        .where("object_id", "=", uuid1)
        .executeTakeFirst();
      expect(row?.subject_id).toBe(sentinel);
    });

    test("the direct probe maps the sentinel back to *", async () => {
      await store.insertTuple({
        objectType: "doc",
        objectId: uuid1,
        relation: "viewer",
        subjectType: "user",
        subjectId: "*",
      });

      const tuple = await readDirect("doc", uuid1, "viewer", "user", "*");
      expect(tuple).not.toBeNull();
      expect(tuple?.subjectId).toBe("*");
    });

    test("findTuplesByRelation maps the sentinel back to *", async () => {
      await store.insertTuple({
        objectType: "doc",
        objectId: uuid1,
        relation: "viewer",
        subjectType: "user",
        subjectId: "*",
      });

      const tuples = await store.findTuplesByRelation("doc", uuid1, "viewer");
      expect(tuples).toHaveLength(1);
      expect(tuples[0]?.subjectId).toBe("*");
    });

    test("listDirectSubjects maps the sentinel back to *", async () => {
      await store.insertTuple({
        objectType: "doc",
        objectId: uuid1,
        relation: "viewer",
        subjectType: "user",
        subjectId: "*",
      });
      await store.insertTuple({
        objectType: "doc",
        objectId: uuid1,
        relation: "viewer",
        subjectType: "user",
        subjectId: uuid2,
      });

      const subjects = await store.listDirectSubjects("doc", uuid1, "viewer");
      expect(subjects).toHaveLength(2);
      expect(subjects.find((s) => s.subjectId === "*")).toBeTruthy();
      expect(subjects.find((s) => s.subjectId === sentinel)).toBe(undefined);
    });

    test("deleteTuple removes a wildcard tuple by *", async () => {
      await store.insertTuple({
        objectType: "doc",
        objectId: uuid1,
        relation: "viewer",
        subjectType: "user",
        subjectId: "*",
      });

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
        await store.insertTuple({
          objectType: "doc",
          objectId: uuid1,
          relation: "viewer",
          ...row,
        });
      }
      // Same object, different relation — out of scope entirely.
      await store.insertTuple({
        objectType: "doc",
        objectId: uuid1,
        relation: "editor",
        subjectType: "user",
        subjectId: uuid2,
      });
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
              wildcard: includeWildcard
                ? (all.find(
                    (t) =>
                      t.subjectType === "user" &&
                      t.subjectId === "*" &&
                      t.subjectRelation === null,
                  ) ?? null)
                : null,
              usersets: includeUsersets
                ? all.filter((t) => t.subjectRelation !== null)
                : [],
            };

            const actual = await store.findCheckTuples({
              objectType: "doc",
              objectId: uuid1,
              relation: "viewer",
              subjectType: "user",
              subjectId: uuid2,
              includeDirect,
              includeWildcard,
              includeUsersets,
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
        includeDirect: true,
        includeWildcard: true,
        includeUsersets: false,
      });

      expect(result.direct?.subjectId).toBe("*");
      expect(result.wildcard).toBeNull();
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
      await store.upsertRelationConfig({
        objectType: "resource",
        relation: "can_edit",
        directlyAssignableTypes: ["user"],
        impliedBy: null,
        computedUserset: null,
        tupleToUserset: null,
        excludedBy: null,
        intersection,
        allowsUsersetSubjects: false,
      });

      const config = await store.findRelationConfig("resource", "can_edit");
      expect(config?.intersection).toEqual(intersection);
    });

    test("upsert replaces an existing intersection", async () => {
      await store.upsertRelationConfig({
        objectType: "resource",
        relation: "can_edit",
        directlyAssignableTypes: null,
        impliedBy: null,
        computedUserset: null,
        tupleToUserset: null,
        excludedBy: null,
        intersection: [{ type: "direct" }],
        allowsUsersetSubjects: false,
      });
      await store.upsertRelationConfig({
        objectType: "resource",
        relation: "can_edit",
        directlyAssignableTypes: null,
        impliedBy: null,
        computedUserset: null,
        tupleToUserset: null,
        excludedBy: null,
        intersection: [{ type: "computedUserset", relation: "member" }],
        allowsUsersetSubjects: false,
      });

      const config = await store.findRelationConfig("resource", "can_edit");
      expect(config?.intersection).toEqual([
        { type: "computedUserset", relation: "member" },
      ]);
    });
  });

  describe("Query methods", () => {
    test("listCandidateObjectIds", async () => {
      await store.insertTuple({
        objectType: "channel",
        objectId: uuid1,
        relation: "writer",
        subjectType: "user",
        subjectId: uuid2,
      });
      await store.insertTuple({
        objectType: "channel",
        objectId: uuid3,
        relation: "writer",
        subjectType: "user",
        subjectId: uuid2,
      });

      const ids = await store.listCandidateObjectIds("channel");
      expect(ids.sort()).toEqual([uuid1, uuid3].sort());
    });

    test("listDirectSubjects", async () => {
      await store.insertTuple({
        objectType: "channel",
        objectId: uuid1,
        relation: "writer",
        subjectType: "user",
        subjectId: uuid2,
      });
      await store.insertTuple({
        objectType: "channel",
        objectId: uuid1,
        relation: "writer",
        subjectType: "workspace",
        subjectId: uuid3,
        subjectRelation: "member",
      });

      const subjects = await store.listDirectSubjects(
        "channel",
        uuid1,
        "writer",
      );
      expect(subjects).toHaveLength(2);
      expect(subjects.find((s) => s.subjectId === uuid2)).toBeTruthy();
      expect(subjects.find((s) => s.subjectRelation === "member")).toBeTruthy();
    });
  });
});
