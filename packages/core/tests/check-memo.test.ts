import { beforeEach, describe, expect, test } from "bun:test";
import { check } from "../src/check.ts";
import { DepthExceededError } from "../src/errors.ts";
import type {
  CheckTuples,
  CheckTuplesQuery,
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

/**
 * Fails the first read of one relation and serves every later one.
 * Enough to make an in-flight entry reject while the node it stands
 * for is perfectly resolvable on a second attempt.
 */
class FailFirstStore extends MockTupleStore {
  private failed = false;

  constructor(private readonly relation: string) {
    super();
  }

  override findCheckTuples(query: CheckTuplesQuery): Promise<CheckTuples> {
    if (query.relation === this.relation && !this.failed) {
      this.failed = true;
      return Promise.reject(new Error("transient store failure"));
    }
    return super.findCheckTuples(query);
  }
}

/**
 * These tests count `findCheckTuples` as the "this node was
 * resolved" signal. A node makes exactly one of those calls, for
 * whichever of the three reads its relation config admits, so the
 * node's identity alone is enough to count visits — no subject
 * arguments needed to disambiguate.
 *
 * Every test here runs at `maxBreadth: 1` unless it says otherwise.
 * The settled memo only answers a route that arrives after another
 * route finished, so a hit requires that ordering; bounded breadth
 * makes it deterministic instead of a race. Routes that *overlap*
 * are the in-flight registry's job — see the last block.
 */
const SEQUENTIAL = { maxBreadth: 1 };

describe("request-scoped node memoization", () => {
  let store: MockTupleStore;

  beforeEach(() => {
    store = new MockTupleStore();
  });

  const viewerRequest = {
    objectType: "doc",
    objectId: "1",
    relation: "top",
    subjectType: "user",
    subjectId: "alice",
  };

  describe("shared nodes resolve once", () => {
    /** top -> {left, right} -> shared. A diamond on one object. */
    function seedDiamond() {
      store.relationConfigs.push(
        makeConfig({
          objectType: "doc",
          relation: "top",
          impliedBy: ["left", "right"],
        }),
        makeConfig({
          objectType: "doc",
          relation: "left",
          impliedBy: ["shared"],
        }),
        makeConfig({
          objectType: "doc",
          relation: "right",
          impliedBy: ["shared"],
        }),
        makeConfig({
          objectType: "doc",
          relation: "shared",
          directlyAssignableTypes: ["user"],
        }),
      );
    }

    test("a definitive false is served from the memo", async () => {
      // The induction the memo rests on: `shared` is refuted with
      // no branch truncated and none errored, so it is false by
      // whatever route it is reached.
      seedDiamond();
      store.resetCounts();

      expect(await check(store, viewerRequest, SEQUENTIAL)).toBe(false);
      expect(store.callsWith("findCheckTuples", "doc", "1", "shared")).toBe(1);
    });

    test("a definitive true is served from the memo", async () => {
      // A grant is a proof found, and a proof does not stop
      // existing on another route. `left` grants, so the union at
      // `top` short-circuits — reach the second route explicitly.
      seedDiamond();
      const cfg = store.relationConfigs.find((c) => c.relation === "top");
      if (cfg) cfg.impliedBy = ["left", "right", "missing"];
      store.tuples.push(
        makeTuple({
          objectType: "doc",
          objectId: "1",
          relation: "shared",
          subjectType: "user",
          subjectId: "alice",
        }),
      );
      store.resetCounts();

      expect(await check(store, viewerRequest, SEQUENTIAL)).toBe(true);
      // `left` grants and the union stops, so `shared` is read once
      // — by `left`, never by `right`.
      expect(store.callsWith("findCheckTuples", "doc", "1", "shared")).toBe(1);
      expect(store.callsWith("findCheckTuples", "doc", "1", "right")).toBe(0);
    });

    test("without a shared node nothing is deduplicated", async () => {
      // Control: the counts above should come from the memo, not
      // from the graph happening to be small.
      store.relationConfigs.push(
        makeConfig({
          objectType: "doc",
          relation: "top",
          impliedBy: ["left", "right"],
        }),
        makeConfig({
          objectType: "doc",
          relation: "left",
          impliedBy: ["l2"],
        }),
        makeConfig({
          objectType: "doc",
          relation: "right",
          impliedBy: ["r2"],
        }),
      );
      store.resetCounts();

      expect(await check(store, viewerRequest, SEQUENTIAL)).toBe(false);
      expect(store.callsWith("findCheckTuples", "doc", "1", "l2")).toBe(1);
      expect(store.callsWith("findCheckTuples", "doc", "1", "r2")).toBe(1);
    });
  });

  describe("indeterminate results are never published", () => {
    test("a cycle-truncated node is re-resolved on another route", async () => {
      // top -> p -> x -> p (cycle), then top -> x directly.
      // x's first result is `false` only because the path already
      // held p. Publishing it would poison the second route, which
      // has a different path. So x must be read twice.
      store.relationConfigs.push(
        makeConfig({
          objectType: "doc",
          relation: "top",
          impliedBy: ["p", "x"],
        }),
        makeConfig({ objectType: "doc", relation: "p", impliedBy: ["x"] }),
        makeConfig({ objectType: "doc", relation: "x", impliedBy: ["p"] }),
      );
      store.resetCounts();

      expect(await check(store, viewerRequest, SEQUENTIAL)).toBe(false);
      expect(store.callsWith("findCheckTuples", "doc", "1", "x")).toBe(2);
      expect(store.callsWith("findCheckTuples", "doc", "1", "p")).toBe(2);
    });

    test("a cross-branch cycle terminates instead of deadlocking", async () => {
      // The shape that makes naive in-flight coalescing deadlock:
      // at breadth >= 2 both branches are launched before either
      // settles, and each reaches the other's node, which is not on
      // its own path. The wait graph refuses the second of the two
      // waits, and that branch resolves the node itself.
      store.relationConfigs.push(
        makeConfig({
          objectType: "doc",
          relation: "top",
          impliedBy: ["a", "b"],
        }),
        makeConfig({ objectType: "doc", relation: "a", impliedBy: ["b"] }),
        makeConfig({ objectType: "doc", relation: "b", impliedBy: ["a"] }),
      );

      expect(await check(store, viewerRequest, { maxBreadth: 2 })).toBe(false);
    });

    test("a granting sibling still wins with the memo in place", async () => {
      store.relationConfigs.push(
        makeConfig({
          objectType: "doc",
          relation: "top",
          impliedBy: ["a", "granted"],
        }),
        makeConfig({ objectType: "doc", relation: "a", impliedBy: ["top"] }),
        makeConfig({
          objectType: "doc",
          relation: "granted",
          directlyAssignableTypes: ["user"],
        }),
      );
      store.tuples.push(
        makeTuple({
          objectType: "doc",
          objectId: "1",
          relation: "granted",
          subjectType: "user",
          subjectId: "alice",
        }),
      );

      expect(await check(store, viewerRequest, SEQUENTIAL)).toBe(true);
    });
  });

  describe("reuse is gated on depth", () => {
    /**
     * Two routes from doc:1#top to group:g#member at different
     * depths, since only userset expansion costs depth:
     *
     *   short: doc:1#top -> g            (g at depth 1)
     *   long:  doc:1#top -> a -> b -> g  (g at depth 3)
     *
     * g expands once more, to `leaf`, so resolving g costs one
     * further level. `order` decides which route the union walks
     * first.
     */
    function seedTwoDepths(order: "shortFirst" | "longFirst") {
      store.relationConfigs.push(
        makeConfig({
          objectType: "doc",
          relation: "top",
          directlyAssignableTypes: ["group"],
          allowsUsersetSubjects: true,
        }),
        makeConfig({
          objectType: "group",
          relation: "member",
          directlyAssignableTypes: ["user", "group"],
          allowsUsersetSubjects: true,
        }),
      );
      const link = (
        objectType: string,
        objectId: string,
        relation: string,
        subjectId: string,
      ) =>
        makeTuple({
          objectType,
          objectId,
          relation,
          subjectType: "group",
          subjectId,
          subjectRelation: "member",
        });

      const short = link("doc", "1", "top", "g");
      const long = link("doc", "1", "top", "a");
      store.tuples.push(
        ...(order === "shortFirst" ? [short, long] : [long, short]),
        link("group", "a", "member", "b"),
        link("group", "b", "member", "g"),
        link("group", "g", "member", "leaf"),
      );
    }

    test("an entry recorded deeper is reused shallower", async () => {
      // The long route resolves g at depth 3 with budget to spare.
      // The short route then asks for g at depth 1, where there is
      // strictly more headroom, so the entry is sound to reuse.
      seedTwoDepths("longFirst");
      store.resetCounts();

      expect(await check(store, viewerRequest, { maxBreadth: 1 })).toBe(false);
      expect(store.callsWith("findCheckTuples", "group", "g", "member")).toBe(
        1,
      );
    });

    test("an entry recorded shallower is not reused deeper", async () => {
      // Reversed order, and a budget that only the short route
      // fits in: g at depth 1 reaches leaf at depth 2, but g at
      // depth 3 would reach leaf at depth 4, which is out of
      // budget. Reusing the depth-1 entry would answer `false`
      // where a fresh resolution throws — so the deeper visit must
      // recompute, and the error must surface.
      seedTwoDepths("shortFirst");

      await expect(
        check(store, viewerRequest, { maxBreadth: 1, maxDepth: 4 }),
      ).rejects.toBeInstanceOf(DepthExceededError);
    });

    test("the same graph resolves when the budget fits", async () => {
      // Control for the previous test: one more level of budget
      // and nothing throws, so the rejection above is about depth
      // and not about the fixture being malformed.
      seedTwoDepths("shortFirst");

      expect(
        await check(store, viewerRequest, { maxBreadth: 1, maxDepth: 5 }),
      ).toBe(false);
    });
  });

  describe("overlapping routes coalesce on one resolution", () => {
    const CONCURRENT = { maxBreadth: 10 };

    test("sibling branches share one resolution of a shared node", async () => {
      // The diamond again, but at a breadth that launches both
      // branches before either settles. The settled memo cannot
      // help here — when `right` asks for `shared`, `left` has not
      // finished with it — so a second read would mean the DAG is
      // being walked as a tree.
      store.relationConfigs.push(
        makeConfig({
          objectType: "doc",
          relation: "top",
          impliedBy: ["left", "right"],
        }),
        makeConfig({ objectType: "doc", relation: "left", impliedBy: ["deep"] }),
        makeConfig({
          objectType: "doc",
          relation: "right",
          impliedBy: ["deep"],
        }),
        makeConfig({ objectType: "doc", relation: "deep", impliedBy: ["leaf"] }),
        makeConfig({
          objectType: "doc",
          relation: "leaf",
          directlyAssignableTypes: ["user"],
        }),
      );
      store.resetCounts();

      expect(await check(store, viewerRequest, CONCURRENT)).toBe(false);
      expect(store.callsWith("findCheckTuples", "doc", "1", "deep")).toBe(1);
      // And the whole subtree behind it, not just the shared node.
      expect(store.callsWith("findCheckTuples", "doc", "1", "leaf")).toBe(1);
    });

    test("a grant found by one branch answers the other", async () => {
      store.relationConfigs.push(
        makeConfig({
          objectType: "doc",
          relation: "top",
          impliedBy: ["left", "right"],
        }),
        makeConfig({
          objectType: "doc",
          relation: "left",
          impliedBy: ["shared"],
        }),
        makeConfig({
          objectType: "doc",
          relation: "right",
          impliedBy: ["shared"],
        }),
        makeConfig({
          objectType: "doc",
          relation: "shared",
          directlyAssignableTypes: ["user"],
        }),
      );
      store.tuples.push(
        makeTuple({
          objectType: "doc",
          objectId: "1",
          relation: "shared",
          subjectType: "user",
          subjectId: "alice",
        }),
      );
      store.resetCounts();

      expect(await check(store, viewerRequest, CONCURRENT)).toBe(true);
      expect(store.callsWith("findCheckTuples", "doc", "1", "shared")).toBe(1);
    });

    test("a three-branch wait cycle terminates", async () => {
      // Pairwise detection is not enough: a waits on b, b on c, and
      // only c closes the loop back to a. The refusal has to walk
      // the wait graph transitively to see it.
      store.relationConfigs.push(
        makeConfig({
          objectType: "doc",
          relation: "top",
          impliedBy: ["a", "b", "c"],
        }),
        makeConfig({ objectType: "doc", relation: "a", impliedBy: ["b"] }),
        makeConfig({ objectType: "doc", relation: "b", impliedBy: ["c"] }),
        makeConfig({ objectType: "doc", relation: "c", impliedBy: ["a"] }),
      );

      expect(await check(store, viewerRequest, { maxBreadth: 3 })).toBe(false);
    });

    test("a cycle behind a grant does not hide it", async () => {
      // The refusal must not swallow an answer: `c` loops back
      // through the wait graph, and `granted` still wins.
      store.relationConfigs.push(
        makeConfig({
          objectType: "doc",
          relation: "top",
          impliedBy: ["a", "b", "c", "granted"],
        }),
        makeConfig({ objectType: "doc", relation: "a", impliedBy: ["b"] }),
        makeConfig({ objectType: "doc", relation: "b", impliedBy: ["c"] }),
        makeConfig({ objectType: "doc", relation: "c", impliedBy: ["a"] }),
        makeConfig({
          objectType: "doc",
          relation: "granted",
          directlyAssignableTypes: ["user"],
        }),
      );
      store.tuples.push(
        makeTuple({
          objectType: "doc",
          objectId: "1",
          relation: "granted",
          subjectType: "user",
          subjectId: "alice",
        }),
      );

      expect(await check(store, viewerRequest, { maxBreadth: 4 })).toBe(true);
    });

    test("a coalesced waiter does not adopt the entry's error", async () => {
      // Errors are not path-independent — a sibling truncated by a
      // cycle can hide an error on one route and not another — so a
      // waiter re-resolves rather than inheriting a rejection. Here
      // the shared node's first read fails and its second succeeds:
      // `left` errors, `right` coalesces onto that same failing
      // resolution, and must still find the grant on its own.
      store.relationConfigs.push(
        makeConfig({
          objectType: "doc",
          relation: "top",
          impliedBy: ["left", "right"],
        }),
        makeConfig({
          objectType: "doc",
          relation: "left",
          impliedBy: ["shared"],
        }),
        makeConfig({
          objectType: "doc",
          relation: "right",
          impliedBy: ["shared"],
        }),
        makeConfig({
          objectType: "doc",
          relation: "shared",
          directlyAssignableTypes: ["user"],
        }),
      );
      store.tuples.push(
        makeTuple({
          objectType: "doc",
          objectId: "1",
          relation: "shared",
          subjectType: "user",
          subjectId: "alice",
        }),
      );

      const flaky = new FailFirstStore("shared");
      flaky.relationConfigs = store.relationConfigs;
      flaky.tuples = store.tuples;

      expect(await check(flaky, viewerRequest, CONCURRENT)).toBe(true);
    });
  });

  describe("the memo does not outlive the request", () => {
    test("a second check re-reads what the first resolved", async () => {
      store.relationConfigs.push(
        makeConfig({
          objectType: "doc",
          relation: "top",
          impliedBy: ["shared"],
        }),
        makeConfig({
          objectType: "doc",
          relation: "shared",
          directlyAssignableTypes: ["user"],
        }),
      );

      await check(store, viewerRequest, SEQUENTIAL);
      store.resetCounts();
      await check(store, viewerRequest, SEQUENTIAL);

      expect(store.callsWith("findCheckTuples", "doc", "1", "shared")).toBe(1);
    });
  });
});
