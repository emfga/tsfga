import { beforeEach, describe, expect, test } from "bun:test";
import { check } from "../src/check.ts";
import {
  InvalidSubjectTypeError,
  RelationConfigNotFoundError,
} from "../src/errors.ts";
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
    directlyAssignable: [
      { type: "user" },
      { type: "user", wildcard: true },
      { type: "team" },
      { type: "team", wildcard: true },
    ],
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

/**
 * Define `user` without declaring anything about `doc.viewer`.
 *
 * A type is defined by the relation configs that name it, so a
 * fixture whose only config admits `team` defines no `user` — and
 * `check` refuses the *subject* before it reaches the read gating
 * these tests are about, upstream's order (`ValidateUser` ahead of
 * `ValidateRelation`, `internal/validation/validation.go:18-32`).
 * The declaration is on a type nothing else here mentions, so it
 * adds no `doc.viewer` read and every query assertion below still
 * measures what it did.
 */
function declareSubjectTypes(store: MockTupleStore): void {
  store.relationConfigs.push(
    makeConfig({
      objectType: "subject_types",
      relation: "declared",
      directlyAssignable: [{ type: "user" }],
    }),
  );
}

describe("structurally impossible reads are skipped", () => {
  let store: MockTupleStore;

  beforeEach(() => {
    store = new MockTupleStore();
    declareSubjectTypes(store);
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
        directlyAssignable: [
          { type: "team" },
          { type: "team", relation: "member" },
        ],
      });

      expect(nodeQuery()?.directRefs).toEqual([]);
    });

    test("a type list with the subject keeps its probe", async () => {
      await checkWith({ directlyAssignable: [{ type: "user" }] });

      expect(nodeQuery()?.directRefs).toEqual([{ type: "user" }]);
    });

    test("no `type:*` in the list skips the wildcard probe", async () => {
      await checkWith({ directlyAssignable: [{ type: "user" }] });

      expect(nodeQuery()?.wildcardRefs).toEqual([]);
    });

    test("`type:*` in the list keeps the wildcard probe", async () => {
      await checkWith({
        directlyAssignable: [
          { type: "user" },
          { type: "user", wildcard: true },
        ],
      });

      expect(nodeQuery()?.wildcardRefs).toEqual([
        { type: "user", wildcard: true },
      ]);
    });

    test("admitting no userset skips the userset scan", async () => {
      await checkWith({
        directlyAssignable: [
          { type: "user" },
          { type: "user", wildcard: true },
          { type: "team" },
          { type: "team", wildcard: true },
        ],
      });

      expect(nodeQuery()?.usersetRefs).toEqual([]);
    });

    test("the scan is narrowed to the usersets admitted", async () => {
      // Not a flag: the refs name the relation, so a relation
      // admitting `team#member` never asks for `team#owner`.
      await checkWith({
        directlyAssignable: [
          { type: "user" },
          { type: "user", wildcard: true },
          { type: "team" },
          { type: "team", relation: "member" },
        ],
      });

      expect(nodeQuery()?.usersetRefs).toEqual([
        { type: "team", relation: "member" },
      ]);
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

  describe("the query carries the conditions, not just the shapes", () => {
    // The read gate is condition-blind — it runs before the row
    // exists — so it asks for *every* restriction of the right
    // shape and lets the clamp do the exact match. What it sends
    // is therefore the admitted refs themselves, and a store can
    // narrow on them.
    test("both variants of a partially conditioned ref are sent", async () => {
      await checkWith({
        directlyAssignable: [
          { type: "user" },
          { type: "user", condition: "weekday_only" },
        ],
      });

      expect(nodeQuery()?.directRefs).toEqual([
        { type: "user" },
        { type: "user", condition: "weekday_only" },
      ]);
    });

    test("a conditioned-only ref still asks — it does not skip", async () => {
      // The gate cannot decide this one: whether the row qualifies
      // depends on the row. Skipping the read would lose the
      // conditioned rows that *are* admitted.
      await checkWith({
        directlyAssignable: [{ type: "user", condition: "weekday_only" }],
      });

      expect(nodeQuery()?.directRefs).toEqual([
        { type: "user", condition: "weekday_only" },
      ]);
    });

    test("refs of another shape are not sent to the direct slot", async () => {
      await checkWith({
        directlyAssignable: [
          { type: "user", condition: "weekday_only" },
          { type: "user", wildcard: true, condition: "weekday_only" },
          { type: "team", relation: "member", condition: "weekday_only" },
        ],
      });

      expect(nodeQuery()?.directRefs).toEqual([
        { type: "user", condition: "weekday_only" },
      ]);
      expect(nodeQuery()?.wildcardRefs).toEqual([
        { type: "user", wildcard: true, condition: "weekday_only" },
      ]);
      expect(nodeQuery()?.usersetRefs).toEqual([
        { type: "team", relation: "member", condition: "weekday_only" },
      ]);
    });

    test("the userset scan is narrowed on the condition too", async () => {
      await checkWith({
        directlyAssignable: [
          { type: "user" },
          { type: "team", relation: "member" },
          { type: "team", relation: "owner", condition: "weekday_only" },
        ],
      });

      expect(nodeQuery()?.usersetRefs).toEqual([
        { type: "team", relation: "member" },
        { type: "team", relation: "owner", condition: "weekday_only" },
      ]);
    });
  });

  describe("only a positive exclusion skips a read", () => {
    test("a list naming the subject asks for both probes", async () => {
      // The probes are gated on their own refs, so a list that
      // names both the bare type and the wildcard keeps both.
      await checkWith({
        directlyAssignable: [
          { type: "user" },
          { type: "user", wildcard: true },
          { type: "team" },
          { type: "team", wildcard: true },
        ],
      });

      expect(nodeQuery()?.directRefs).toEqual([{ type: "user" }]);
      expect(nodeQuery()?.wildcardRefs).toEqual([
        { type: "user", wildcard: true },
      ]);
    });

    test("no config at all reads nothing, because it raises", async () => {
      store.resetCounts();

      // This used to send a query whose three ref sets were all
      // `null` — "decline to narrow", so every stored row
      // qualified. A relation the model does not define is now
      // refused before anything is read, which is why no ref set
      // core builds is nullable any more.
      await expect(check(store, request)).rejects.toBeInstanceOf(
        RelationConfigNotFoundError,
      );
      expect(nodeQuery()).toBeNull();
    });
  });

  describe("the read gate covers the write gate", () => {
    // Not "agrees with": once a restriction carries a condition
    // the two gates cannot be the same predicate. The read gate
    // runs before the row exists and the condition is on the row,
    // so it matches the *shape* and is deliberately the wider of
    // the two; `clampToQuery` then performs the exact match on the
    // reply. The invariant is `readGate ⊇ writeGate` and
    // `clamp ≡ writeGate`.
    //
    // What these walk is the consequence that still has to hold:
    // a tuple the write path accepts is one a check can find.
    const configs: Array<[string, Partial<RelationConfig>]> = [
      [
        "null type list",
        {
          directlyAssignable: [
            { type: "user" },
            { type: "user", wildcard: true },
            { type: "team" },
            { type: "team", wildcard: true },
          ],
        },
      ],
      ["subject listed", { directlyAssignable: [{ type: "user" }] }],
      ["subject absent", { directlyAssignable: [{ type: "team" }] }],
      [
        "wildcard only",
        { directlyAssignable: [{ type: "user", wildcard: true }] },
      ],
      [
        "both forms",
        {
          directlyAssignable: [
            { type: "user" },
            { type: "user", wildcard: true },
          ],
        },
      ],
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
          directlyAssignable: [{ type: "team" }],
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
          directlyAssignable: [{ type: "team" }],
        }),
        makeConfig({
          objectType: "team",
          relation: "member",
          directlyAssignable: [{ type: "user" }],
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
          directlyAssignable: [{ type: "user" }],
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
