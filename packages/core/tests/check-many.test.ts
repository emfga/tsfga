import { beforeEach, describe, expect, test } from "bun:test";
import { checkMany } from "../src/check-many.ts";
import {
  InvalidSubjectTypeError,
  RelationConfigNotFoundError,
  TsfgaError,
} from "../src/errors.ts";
import type {
  ConditionDefinition,
  RelationConfig,
  Tuple,
} from "../src/types.ts";
import { MockTupleStore } from "./helpers/mock-store.ts";

function makeTuple(overrides: Partial<Tuple> = {}): Tuple {
  return {
    objectType: "",
    objectId: "",
    relation: "",
    subjectType: "",
    subjectId: "",
    subjectRelation: null,
    conditionName: null,
    conditionContext: null,
    ...overrides,
  };
}

function makeConfig(overrides: Partial<RelationConfig> = {}): RelationConfig {
  return {
    objectType: "",
    relation: "",
    directlyAssignableTypes: null,
    impliedBy: null,
    computedUserset: null,
    tupleToUserset: null,
    excludedBy: null,
    intersection: null,
    allowsUsersetSubjects: false,
    ...overrides,
  };
}

const alice = { subjectType: "user", subjectId: "alice" };

describe("checkMany", () => {
  let store: MockTupleStore;

  beforeEach(() => {
    store = new MockTupleStore();
  });

  /**
   * Two permissions on one object, both reached through the same
   * `shared` node — the shape of a page render asking several
   * questions about one record.
   */
  function seedSharedSubtree() {
    store.relationConfigs.push(
      makeConfig({
        objectType: "doc",
        relation: "can_view",
        impliedBy: ["shared"],
      }),
      makeConfig({
        objectType: "doc",
        relation: "can_edit",
        impliedBy: ["shared"],
      }),
      makeConfig({
        objectType: "doc",
        relation: "shared",
        impliedBy: ["deep"],
      }),
      makeConfig({
        objectType: "doc",
        relation: "deep",
        directlyAssignableTypes: ["user"],
      }),
    );
  }

  describe("one scope spans the batch", () => {
    test("a shared subtree is resolved once for the batch", async () => {
      seedSharedSubtree();
      store.resetCounts();

      const outcomes = await checkMany(store, [
        { objectType: "doc", objectId: "1", relation: "can_view", ...alice },
        { objectType: "doc", objectId: "1", relation: "can_edit", ...alice },
      ]);

      expect(outcomes.map((o) => o.allowed)).toEqual([false, false]);
      expect(store.callsWith("findCheckTuples", "doc", "1", "shared")).toBe(1);
      expect(store.callsWith("findCheckTuples", "doc", "1", "deep")).toBe(1);
      // And the config cache spans the batch too.
      expect(store.callsWith("findRelationConfig", "doc", "shared")).toBe(1);
    });

    test("two identical requests cost one resolution", async () => {
      // Upstream de-duplicates a batch by cache key before
      // dispatching; here the shared scope does it at the root node.
      seedSharedSubtree();
      store.resetCounts();

      const request = {
        objectType: "doc",
        objectId: "1",
        relation: "can_view",
        ...alice,
      };
      const outcomes = await checkMany(store, [request, request]);

      expect(outcomes.map((o) => o.allowed)).toEqual([false, false]);
      expect(store.callsWith("findCheckTuples", "doc", "1", "can_view")).toBe(
        1,
      );
    });

    test("separate check calls still pay per call", async () => {
      // Control: the counts above are the scope's doing, not the
      // fixture being trivially small.
      seedSharedSubtree();
      store.resetCounts();

      await checkMany(store, [
        { objectType: "doc", objectId: "1", relation: "can_view", ...alice },
      ]);
      await checkMany(store, [
        { objectType: "doc", objectId: "1", relation: "can_edit", ...alice },
      ]);

      expect(store.callsWith("findCheckTuples", "doc", "1", "shared")).toBe(2);
    });
  });

  describe("answers", () => {
    test("come back in request order", async () => {
      store.relationConfigs.push(
        makeConfig({
          objectType: "doc",
          relation: "viewer",
          directlyAssignableTypes: ["user"],
        }),
      );
      store.tuples.push(
        makeTuple({
          objectType: "doc",
          objectId: "2",
          relation: "viewer",
          ...alice,
        }),
      );

      const outcomes = await checkMany(store, [
        { objectType: "doc", objectId: "1", relation: "viewer", ...alice },
        { objectType: "doc", objectId: "2", relation: "viewer", ...alice },
        { objectType: "doc", objectId: "3", relation: "viewer", ...alice },
      ]);

      expect(outcomes.map((o) => o.allowed)).toEqual([false, true, false]);
    });

    test("an empty batch answers nothing", async () => {
      expect(await checkMany(store, [])).toEqual([]);
    });

    test("order holds at every concurrency bound", async () => {
      store.relationConfigs.push(
        makeConfig({
          objectType: "doc",
          relation: "viewer",
          directlyAssignableTypes: ["user"],
        }),
      );
      const ids = ["1", "2", "3", "4", "5"];
      store.tuples.push(
        makeTuple({
          objectType: "doc",
          objectId: "3",
          relation: "viewer",
          ...alice,
        }),
      );
      const requests = ids.map((objectId) => ({
        objectType: "doc",
        objectId,
        relation: "viewer",
        ...alice,
      }));

      for (const maxConcurrentChecks of [1, 2, 50, Number.POSITIVE_INFINITY]) {
        const outcomes = await checkMany(store, requests, {
          maxConcurrentChecks,
        });
        expect(outcomes.map((o) => o.allowed)).toEqual([
          false,
          false,
          true,
          false,
          false,
        ]);
      }
    });
  });

  describe("errors are per check, not per batch", () => {
    test("a failing check does not stop the others", async () => {
      store.relationConfigs.push(
        makeConfig({
          objectType: "doc",
          relation: "viewer",
          directlyAssignableTypes: ["user"],
        }),
      );
      store.tuples.push(
        makeTuple({
          objectType: "doc",
          objectId: "1",
          relation: "viewer",
          ...alice,
        }),
      );

      const outcomes = await checkMany(store, [
        {
          objectType: "doc",
          objectId: "1",
          relation: "viewer",
          ...alice,
          // Validated exactly as `addTuple` would validate it, and
          // this relation admits `user` subjects only.
          contextualTuples: [
            {
              objectType: "doc",
              objectId: "9",
              relation: "viewer",
              subjectType: "team",
              subjectId: "eng",
              subjectRelation: "member",
            },
          ],
        },
        { objectType: "doc", objectId: "1", relation: "viewer", ...alice },
        {
          objectType: "doc",
          objectId: "1",
          relation: "viewer",
          ...alice,
          // No relation config for `doc.missing` to validate against.
          contextualTuples: [
            {
              objectType: "doc",
              objectId: "9",
              relation: "missing",
              ...alice,
            },
          ],
        },
        { objectType: "doc", objectId: "1", relation: "viewer", ...alice },
      ]);

      expect(outcomes[0]?.allowed).toBe(false);
      expect(outcomes[0]?.error).toBeInstanceOf(InvalidSubjectTypeError);
      expect(outcomes[1]).toEqual({ allowed: true });
      expect(outcomes[2]?.error).toBeInstanceOf(RelationConfigNotFoundError);
      expect(outcomes[3]).toEqual({ allowed: true });
    });

    test("an invalid option throws instead", async () => {
      // Options are the caller's mistake, not a check's outcome.
      await expect(
        checkMany(store, [], { maxConcurrentChecks: 0 }),
      ).rejects.toBeInstanceOf(TsfgaError);
      await expect(
        checkMany(store, [], { maxConcurrentChecks: 1.5 }),
      ).rejects.toBeInstanceOf(TsfgaError);
      await expect(
        checkMany(store, [], { maxBreadth: 0 }),
      ).rejects.toBeInstanceOf(TsfgaError);
    });
  });

  describe("context is not shared across contexts", () => {
    /** `viewer` granted only while the condition holds. */
    function seedConditioned() {
      store.relationConfigs.push(
        makeConfig({
          objectType: "doc",
          relation: "viewer",
          directlyAssignableTypes: ["user"],
        }),
      );
      store.tuples.push(
        makeTuple({
          objectType: "doc",
          objectId: "1",
          relation: "viewer",
          ...alice,
          conditionName: "is_open",
        }),
      );
      const condition: ConditionDefinition = {
        name: "is_open",
        expression: "open == true",
        parameters: { open: "bool" },
      };
      store.conditionDefinitions.push(condition);
    }

    test("two contexts get two answers", async () => {
      // The memo does not key on the context, so requests carrying
      // different contexts must not share one. If they did, the
      // second answer here would be a copy of the first.
      seedConditioned();

      const outcomes = await checkMany(store, [
        {
          objectType: "doc",
          objectId: "1",
          relation: "viewer",
          ...alice,
          context: { open: true },
        },
        {
          objectType: "doc",
          objectId: "1",
          relation: "viewer",
          ...alice,
          context: { open: false },
        },
      ]);

      expect(outcomes.map((o) => o.allowed)).toEqual([true, false]);
    });

    test("one context object is shared", async () => {
      seedConditioned();
      store.resetCounts();
      const context = { open: true };

      const outcomes = await checkMany(store, [
        {
          objectType: "doc",
          objectId: "1",
          relation: "viewer",
          ...alice,
          context,
        },
        {
          objectType: "doc",
          objectId: "1",
          relation: "viewer",
          ...alice,
          context,
        },
      ]);

      expect(outcomes.map((o) => o.allowed)).toEqual([true, true]);
      expect(store.callsWith("findCheckTuples", "doc", "1", "viewer")).toBe(1);
    });
  });
});
