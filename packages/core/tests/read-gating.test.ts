import { beforeEach, describe, expect, test } from "bun:test";
import { check } from "../src/check.ts";
import { InvalidSubjectTypeError } from "../src/errors.ts";
import { validateTupleWrite } from "../src/tuple-validation.ts";
import type { RelationConfig, Tuple } from "../src/types.ts";
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
    directlyAssignable: ["user", "user:*", "team", "team:*"],
    impliedBy: null,
    computedUserset: null,
    tupleToUserset: null,
    excludedBy: null,
    intersection: null,
    ...overrides,
  };
}

const request = {
  objectType: "doc",
  objectId: "1",
  relation: "viewer",
  subjectType: "user",
  subjectId: "alice",
};

describe("structurally impossible reads are skipped", () => {
  let store: MockTupleStore;

  beforeEach(() => {
    store = new MockTupleStore();
  });

  /** Push a `doc.viewer` config and run one check against it. */
  async function checkWith(config: Partial<RelationConfig>) {
    store.relationConfigs.push(
      makeConfig({ objectType: "doc", relation: "viewer", ...config }),
    );
    store.resetCounts();
    return check(store, request);
  }

  /**
   * The one query the node under test sent, or `null` when it sent
   * none at all.
   */
  function nodeQuery() {
    return store.queriesFor("doc", "1", "viewer")[0] ?? null;
  }

  describe("each read is gated on its own declaration", () => {
    test("a type list without the subject skips its probe", async () => {
      // Usersets stay allowed so a query is still sent — otherwise
      // nothing is asked for at all and this would pass for the
      // wrong reason. That case has its own test below.
      await checkWith({
        directlyAssignable: ["team", "team#member"],
      });

      expect(nodeQuery()?.includeDirect).toBe(false);
    });

    test("a type list with the subject keeps its probe", async () => {
      await checkWith({ directlyAssignable: ["user"] });

      expect(nodeQuery()?.includeDirect).toBe(true);
    });

    test("no `type:*` in the list skips the wildcard probe", async () => {
      await checkWith({ directlyAssignable: ["user"] });

      expect(nodeQuery()?.includeWildcard).toBe(false);
    });

    test("`type:*` in the list keeps the wildcard probe", async () => {
      await checkWith({ directlyAssignable: ["user", "user:*"] });

      expect(nodeQuery()?.includeWildcard).toBe(true);
    });

    test("admitting no userset skips the userset scan", async () => {
      await checkWith({
        directlyAssignable: ["user", "user:*", "team", "team:*"],
      });

      expect(nodeQuery()?.usersetRefs).toEqual([]);
    });

    test("the scan is narrowed to the usersets admitted", async () => {
      // Not a flag: the refs name the relation, so a relation
      // admitting `team#member` never asks for `team#owner`.
      await checkWith({
        directlyAssignable: ["user", "user:*", "team", "team#member"],
      });

      expect(nodeQuery()?.usersetRefs).toEqual(["team#member"]);
    });

    test("a relation that admits nothing sends no query", async () => {
      // Nothing left to ask for, so the node skips the store
      // rather than sending a query that cannot match.
      await checkWith({
        directlyAssignable: [],
      });

      expect(nodeQuery()).toBeNull();
    });
  });

  describe("only a positive exclusion skips a read", () => {
    test("a list naming the subject asks for both probes", async () => {
      // The probes are gated on their own refs, so a list that
      // names both the bare type and the wildcard keeps both.
      await checkWith({
        directlyAssignable: ["user", "user:*", "team", "team:*"],
      });

      expect(nodeQuery()?.includeDirect).toBe(true);
      expect(nodeQuery()?.includeWildcard).toBe(true);
    });

    test("no config at all reads everything", async () => {
      store.resetCounts();

      await check(store, request);

      expect(nodeQuery()?.includeDirect).toBe(true);
      expect(nodeQuery()?.includeWildcard).toBe(true);
      expect(nodeQuery()?.usersetRefs).toBeNull();
    });
  });

  describe("the read gate matches the write gate", () => {
    // The two must agree or a tuple could be written and then
    // never found. These walk the same configs through both paths
    // and require the same verdict.
    const configs: Array<[string, Partial<RelationConfig>]> = [
      [
        "null type list",
        { directlyAssignable: ["user", "user:*", "team", "team:*"] },
      ],
      ["subject listed", { directlyAssignable: ["user"] }],
      ["subject absent", { directlyAssignable: ["team"] }],
      ["wildcard only", { directlyAssignable: ["user:*"] }],
      ["both forms", { directlyAssignable: ["user", "user:*"] }],
      ["empty list", { directlyAssignable: [] }],
    ];

    for (const [name, config] of configs) {
      test(`${name}: a writable tuple is always findable`, async () => {
        const full = makeConfig({
          objectType: "doc",
          relation: "viewer",
          ...config,
        });
        store.relationConfigs.push(full);

        const writable = await validateTupleWrite(store, {
          ...request,
        }).then(
          () => true,
          (error: unknown) => {
            if (error instanceof InvalidSubjectTypeError) return false;
            throw error;
          },
        );
        if (!writable) return;

        // Writable, so the check must actually look for it.
        store.tuples.push(makeTuple({ ...request }));
        store.resetCounts();

        expect(await check(store, request)).toBe(true);
      });
    }
  });

  describe("a tuple the model does not admit is ignored", () => {
    test("a stray direct tuple no longer grants", async () => {
      // Written straight to the store, bypassing addTuple — or
      // left behind by a config that has since narrowed. Upstream
      // never sees such a row because the read is typed; tsfga
      // now skips it for the same reason. Fail-closed.
      store.relationConfigs.push(
        makeConfig({
          objectType: "doc",
          relation: "viewer",
          directlyAssignable: ["team"],
        }),
      );
      store.tuples.push(makeTuple({ ...request }));

      expect(await check(store, request)).toBe(false);
    });

    test("a stray userset tuple no longer grants", async () => {
      store.relationConfigs.push(
        makeConfig({
          objectType: "doc",
          relation: "viewer",
          directlyAssignable: ["team"],
        }),
        makeConfig({
          objectType: "team",
          relation: "member",
          directlyAssignable: ["user"],
        }),
      );
      store.tuples.push(
        makeTuple({
          objectType: "doc",
          objectId: "1",
          relation: "viewer",
          subjectType: "team",
          subjectId: "t1",
          subjectRelation: "member",
        }),
        makeTuple({
          objectType: "team",
          objectId: "t1",
          relation: "member",
          subjectType: "user",
          subjectId: "alice",
        }),
      );

      expect(await check(store, request)).toBe(false);
    });
  });

  describe("gating does not disturb the rewrite steps", () => {
    test("a computed relation still resolves with no reads of its own", async () => {
      // `viewer` admits nothing directly, so all three of its
      // reads are gated out — but it still rewrites to `owner`,
      // which does read.
      store.relationConfigs.push(
        makeConfig({
          objectType: "doc",
          relation: "viewer",
          directlyAssignable: [],
          computedUserset: "owner",
        }),
        makeConfig({
          objectType: "doc",
          relation: "owner",
          directlyAssignable: ["user"],
        }),
      );
      store.tuples.push(makeTuple({ ...request, relation: "owner" }));
      store.resetCounts();

      expect(await check(store, request)).toBe(true);
      expect(store.queriesFor("doc", "1", "viewer")).toEqual([]);
      expect(store.queriesFor("doc", "1", "owner")).toHaveLength(1);
    });
  });
});
