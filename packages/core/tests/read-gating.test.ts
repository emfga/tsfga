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

  describe("each read is gated on its own declaration", () => {
    test("a type list without the subject skips its probe", async () => {
      await checkWith({ directlyAssignableTypes: ["team"] });

      expect(
        store.callsWith(
          "findDirectTuple",
          "doc",
          "1",
          "viewer",
          "user",
          "alice",
        ),
      ).toBe(0);
    });

    test("a type list with the subject keeps its probe", async () => {
      await checkWith({ directlyAssignableTypes: ["user"] });

      expect(
        store.callsWith(
          "findDirectTuple",
          "doc",
          "1",
          "viewer",
          "user",
          "alice",
        ),
      ).toBe(1);
    });

    test("no `type:*` in the list skips the wildcard probe", async () => {
      await checkWith({ directlyAssignableTypes: ["user"] });

      expect(
        store.callsWith("findDirectTuple", "doc", "1", "viewer", "user", "*"),
      ).toBe(0);
    });

    test("`type:*` in the list keeps the wildcard probe", async () => {
      await checkWith({ directlyAssignableTypes: ["user", "user:*"] });

      expect(
        store.callsWith("findDirectTuple", "doc", "1", "viewer", "user", "*"),
      ).toBe(1);
    });

    test("forbidding userset subjects skips the userset scan", async () => {
      await checkWith({ allowsUsersetSubjects: false });

      expect(store.counts.findUsersetTuples).toBe(undefined);
    });

    test("allowing userset subjects keeps the userset scan", async () => {
      await checkWith({ allowsUsersetSubjects: true });

      expect(store.counts.findUsersetTuples).toBe(1);
    });
  });

  describe("only a positive exclusion skips a read", () => {
    test("a null type list reads both probes", async () => {
      // `null` means the config declines to narrow the relation,
      // not that the relation is purely computed. Reading it as
      // "none" would skip probes for tuples `addTuple` accepts.
      await checkWith({ directlyAssignableTypes: null });

      expect(store.counts.findDirectTuple).toBe(2);
    });

    test("no config at all reads everything", async () => {
      store.resetCounts();

      await check(store, request);

      expect(store.counts.findDirectTuple).toBe(2);
      expect(store.counts.findUsersetTuples).toBe(1);
    });
  });

  describe("the read gate matches the write gate", () => {
    // The two must agree or a tuple could be written and then
    // never found. These walk the same configs through both paths
    // and require the same verdict.
    const configs: Array<[string, Partial<RelationConfig>]> = [
      ["null type list", { directlyAssignableTypes: null }],
      ["subject listed", { directlyAssignableTypes: ["user"] }],
      ["subject absent", { directlyAssignableTypes: ["team"] }],
      ["wildcard only", { directlyAssignableTypes: ["user:*"] }],
      ["both forms", { directlyAssignableTypes: ["user", "user:*"] }],
      ["empty list", { directlyAssignableTypes: [] }],
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
          directlyAssignableTypes: ["team"],
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
          directlyAssignableTypes: ["team"],
          allowsUsersetSubjects: false,
        }),
        makeConfig({
          objectType: "team",
          relation: "member",
          directlyAssignableTypes: ["user"],
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
          directlyAssignableTypes: [],
          computedUserset: "owner",
        }),
        makeConfig({
          objectType: "doc",
          relation: "owner",
          directlyAssignableTypes: ["user"],
        }),
      );
      store.tuples.push(makeTuple({ ...request, relation: "owner" }));
      store.resetCounts();

      expect(await check(store, request)).toBe(true);
      expect(
        store.callsWith(
          "findDirectTuple",
          "doc",
          "1",
          "viewer",
          "user",
          "alice",
        ),
      ).toBe(0);
      expect(
        store.callsWith(
          "findDirectTuple",
          "doc",
          "1",
          "owner",
          "user",
          "alice",
        ),
      ).toBe(1);
    });
  });
});
