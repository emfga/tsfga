import { beforeEach, describe, expect, test } from "bun:test";
import { check } from "../src/check.ts";
import {
  ConditionEvaluationError,
  DepthExceededError,
  InvalidRequestContextError,
  RelationConfigNotFoundError,
  TsfgaError,
} from "../src/errors.ts";
import { createTsfga } from "../src/index.ts";
import { listObjects } from "../src/list-objects.ts";
import type {
  CheckTuples,
  CheckTuplesQuery,
  ListObjectsRequest,
  RelationConfig,
  Tuple,
} from "../src/types.ts";
import { delay, StoreReadFailure } from "./helpers/erroring-store.ts";
import { MockTupleStore } from "./helpers/mock-store.ts";

/**
 * The one request every scope, breadth and ordering test asks.
 *
 * Named rather than repeated because these tests are about how the
 * candidates are resolved, not about which request they answer:
 * the request is the fixture's constant, and spelling it out
 * eleven times invited it to drift.
 */
const ALICE_VIEWER: ListObjectsRequest = {
  objectType: "doc",
  relation: "viewer",
  subjectType: "user",
  subjectId: "alice",
};

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
      { type: "folder" },
      { type: "folder", wildcard: true },
    ],
    impliedBy: null,
    computedUserset: null,
    tupleToUserset: null,
    excludedBy: null,
    intersection: null,
    ...overrides,
  };
}

/**
 * Every candidate check opens with a tuple read on the candidate
 * object, which makes that read a usable proxy for "this candidate
 * has started". Stalling it parks each candidate at a point where
 * the pool's concurrency is observable, and failing it fails
 * exactly one candidate without disturbing the shared subtree
 * behind them all.
 */
class CandidateStore extends MockTupleStore {
  inFlight = 0;
  peakInFlight = 0;
  started: string[] = [];
  /** Candidate object id -> the failure its check should raise. */
  failures = new Map<string, Error>();
  /** Candidate object id -> ms to stall before settling. */
  delays = new Map<string, number>();

  override async findCheckTuples(
    query: CheckTuplesQuery,
  ): Promise<CheckTuples> {
    // Instrument only the candidate objects, so one candidate
    // counts as one in flight and the shared subtree behind them
    // is neither stalled nor failed.
    if (query.objectType !== "doc") {
      return super.findCheckTuples(query);
    }
    const objectId = query.objectId;
    this.started.push(objectId);
    this.inFlight++;
    this.peakInFlight = Math.max(this.peakInFlight, this.inFlight);
    try {
      await delay(this.delays.get(objectId) ?? 1);
      const failure = this.failures.get(objectId);
      if (failure) {
        throw failure;
      }
      return await super.findCheckTuples(query);
    } finally {
      this.inFlight--;
    }
  }
}

/** The thrown error's message, or a marker when nothing threw. */
async function failureMessage(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return "<resolved>";
}

describe("listObjects", () => {
  let store: CandidateStore;

  /**
   * Many documents, one shared subtree behind all of them.
   *
   *   doc:N#viewer --TTU parent--> folder:shared#member
   *   folder:shared#member --userset--> folder:sub#member
   *
   * Nothing grants, so no candidate short-circuits and every one
   * of them walks the whole shared subtree.
   */
  function seedSharedSubtree(candidates: number) {
    store.relationConfigs.push(
      makeConfig({
        objectType: "doc",
        relation: "viewer",
        tupleToUserset: [{ tupleset: "parent", computedUserset: "member" }],
      }),
      makeConfig({
        objectType: "folder",
        relation: "member",
        directlyAssignable: [
          { type: "user" },
          { type: "folder" },
          { type: "folder", relation: "member" },
        ],
      }),
      // The tupleset relation is a relation like any other, and a
      // check refuses one the model does not define.
      makeConfig({
        objectType: "doc",
        relation: "parent",
        directlyAssignable: [{ type: "folder" }],
      }),
    );
    for (let i = 1; i <= candidates; i++) {
      store.tuples.push(
        makeTuple({
          objectType: "doc",
          objectId: String(i),
          relation: "parent",
          subjectType: "folder",
          subjectId: "shared",
        }),
      );
    }
    store.tuples.push(
      makeTuple({
        objectType: "folder",
        objectId: "shared",
        relation: "member",
        subjectType: "folder",
        subjectId: "sub",
        subjectRelation: "member",
      }),
    );
  }

  const docIds = (count: number) =>
    Array.from({ length: count }, (_, i) => String(i + 1));

  beforeEach(() => {
    store = new CandidateStore();
  });

  describe("the request scope spans the whole call", () => {
    test("relation configs are fetched once, not once per candidate", async () => {
      // Independent of concurrency: the caching store is built by
      // the scope, so it is shared however the candidates overlap.
      seedSharedSubtree(5);
      store.resetCounts();

      await listObjects(store, ALICE_VIEWER);

      expect(store.callsWith("findRelationConfig", "doc", "viewer")).toBe(1);
      expect(store.callsWith("findRelationConfig", "folder", "member")).toBe(1);
    });

    test("a shared subtree resolves once for the whole call", async () => {
      // At breadth 1 the candidates are sequential, so each one
      // after the first finds the subtree already settled in the
      // memo. See the control below for what this replaces.
      seedSharedSubtree(5);
      store.resetCounts();

      await listObjects(store, ALICE_VIEWER, {
        maxBreadth: 1,
      });

      expect(
        store.callsWith("findCheckTuples", "folder", "shared", "member"),
      ).toBe(1);
    });

    test("control: separate checks each re-resolve the subtree", async () => {
      // The same five objects checked one call at a time — which
      // is what listObjects did before the scope was hoisted.
      // Without this, the count above could just mean the fixture
      // is too small to share anything.
      seedSharedSubtree(5);
      store.resetCounts();

      for (const objectId of docIds(5)) {
        await check(
          store,
          {
            objectType: "doc",
            objectId,
            relation: "viewer",
            subjectType: "user",
            subjectId: "alice",
          },
          { maxBreadth: 1 },
        );
      }

      expect(
        store.callsWith("findCheckTuples", "folder", "shared", "member"),
      ).toBe(5);
    });
  });

  describe("candidate concurrency is bounded by maxBreadth", () => {
    test("at most maxBreadth candidates are in flight", async () => {
      seedSharedSubtree(8);
      // Long enough that all eight would overlap if unbounded.
      for (const id of docIds(8)) store.delays.set(id, 10);

      await listObjects(store, ALICE_VIEWER, {
        maxBreadth: 3,
      });

      expect(store.peakInFlight).toBe(3);
    });

    test("breadth 1 runs candidates one at a time", async () => {
      seedSharedSubtree(4);

      await listObjects(store, ALICE_VIEWER, {
        maxBreadth: 1,
      });

      expect(store.peakInFlight).toBe(1);
    });

    test("an invalid maxBreadth rejects rather than throwing", async () => {
      seedSharedSubtree(2);

      await expect(
        listObjects(store, ALICE_VIEWER, {
          maxBreadth: 0,
        }),
      ).rejects.toBeInstanceOf(Error);
    });
  });

  describe("results are in candidate order", () => {
    test("a slow early candidate still comes first", async () => {
      // Grant the first and last candidate, and make the first the
      // slowest, so completion order and candidate order disagree.
      seedSharedSubtree(4);
      for (const objectId of ["1", "4"]) {
        store.tuples.push(
          makeTuple({
            objectType: "doc",
            objectId,
            relation: "viewer",
            subjectType: "user",
            subjectId: "alice",
          }),
        );
      }
      store.delays.set("1", 20);
      store.delays.set("4", 1);

      expect(
        await listObjects(store, ALICE_VIEWER, {
          maxBreadth: 4,
        }),
      ).toEqual(["1", "4"]);
    });
  });

  describe("error contract", () => {
    test("the lowest-index failure wins, not the first to fail", async () => {
      // Candidate 4 fails immediately, candidate 2 slowly. Both
      // are in flight together at breadth 4, so completion order
      // reports 4 — candidate order must still report 2.
      seedSharedSubtree(4);
      store.failures.set("2", new StoreReadFailure("doc:2 failed"));
      store.failures.set("4", new StoreReadFailure("doc:4 failed"));
      store.delays.set("2", 20);
      store.delays.set("4", 1);

      expect(
        await failureMessage(
          listObjects(store, ALICE_VIEWER, {
            maxBreadth: 4,
          }),
        ),
      ).toBe("doc:2 failed");
    });

    test("no candidate after a failure is started", async () => {
      seedSharedSubtree(5);
      store.failures.set("2", new StoreReadFailure("doc:2 failed"));

      await failureMessage(
        listObjects(store, ALICE_VIEWER, {
          maxBreadth: 1,
        }),
      );

      expect(store.started).toEqual(["1", "2"]);
    });

    test("a granted candidate does not mask a later failure", async () => {
      // Fail closed: a partial list is not a valid answer, so the
      // grant on candidate 1 must not turn the call into `["1"]`.
      seedSharedSubtree(3);
      store.tuples.push(
        makeTuple({
          objectType: "doc",
          objectId: "1",
          relation: "viewer",
          subjectType: "user",
          subjectId: "alice",
        }),
      );
      store.failures.set("3", new StoreReadFailure("doc:3 failed"));

      expect(await failureMessage(listObjects(store, ALICE_VIEWER))).toBe(
        "doc:3 failed",
      );
    });

    test("depth exhaustion drops the candidate, it does not abort", async () => {
      // The one error that does not abort. Upstream's reverse
      // expansion walks a job queue rather than recursing, so a
      // chain long enough to exhaust tsfga's budget is one it
      // still answers -- and aborting here costs the caller every
      // object, including the ones well inside the budget that
      // both engines agree on. Dropping the candidate is closer to
      // upstream on every shape upstream can actually answer.
      //
      // The three cases above still hold: every other error
      // aborts the call, bar the deferred condition error the
      // block below is about. `StoreReadFailure` is not one, so
      // none of the three moved.
      seedSharedSubtree(3);

      expect(await listObjects(store, ALICE_VIEWER, { maxDepth: 1 })).toEqual(
        [],
      );
    });
  });

  /**
   * The other exception, and the one that is not a blanket rule:
   * whether a `ConditionEvaluationError` aborts depends on *which
   * read* raised it, which `check.ts` records on the error as
   * `onSubjectRow`.
   *
   * Upstream reverse-expands `ListObjects` from the subject, and
   * its first query is for the rows whose subject is the request
   * subject on that relation. A condition on one of those is
   * always evaluated upstream too, so an error there must refuse
   * here. Anything further out upstream may never materialise, so
   * an error there is dropped outright: the candidate counts
   * `false` and the call answers with the granted set, which may
   * be empty.
   *
   * These go through the real check path rather than injecting the
   * error, because the flag is only worth anything if the read
   * sites actually set it.
   */
  describe("which read raised a condition error decides", () => {
    /** A condition whose parameter no request here supplies. */
    function seedCondition() {
      store.conditionDefinitions.push({
        name: "flag",
        expression: "flag == true",
        parameters: { flag: "bool" },
      });
    }

    /**
     * `doc:1` grants alice outright; `doc:2` carries her own row
     * on the same relation, conditioned. That second row is
     * exactly upstream's first reverse-expansion query.
     */
    function seedSubjectRow() {
      seedCondition();
      store.relationConfigs.push(
        makeConfig({
          objectType: "doc",
          relation: "viewer",
          directlyAssignable: [
            { type: "user" },
            { type: "user", condition: "flag" },
          ],
        }),
      );
      store.tuples.push(
        makeTuple({
          objectType: "doc",
          objectId: "1",
          relation: "viewer",
          subjectType: "user",
          subjectId: "alice",
        }),
        makeTuple({
          objectType: "doc",
          objectId: "2",
          relation: "viewer",
          subjectType: "user",
          subjectId: "alice",
          conditionName: "flag",
        }),
      );
    }

    /**
     * `doc:2`'s failure is a hop away: its tupleset row is
     * conditioned, so the error comes off a scan rather than off
     * alice's own row. `grantOk` decides whether the candidate
     * beside it grants anything.
     */
    function seedTuplesetScan(grantOk: boolean) {
      seedCondition();
      store.relationConfigs.push(
        makeConfig({
          objectType: "doc",
          relation: "viewer",
          // Nothing is assigned directly, but the arm is kept so
          // the candidate still opens with a `findCheckTuples` --
          // which is what `CandidateStore` counts and fails on.
          directlyAssignable: [{ type: "user" }],
          tupleToUserset: [{ tupleset: "parent", computedUserset: "member" }],
        }),
        makeConfig({
          objectType: "doc",
          relation: "parent",
          directlyAssignable: [
            { type: "folder" },
            { type: "folder", condition: "flag" },
          ],
        }),
        makeConfig({
          objectType: "folder",
          relation: "member",
          directlyAssignable: [{ type: "user" }],
        }),
      );
      store.tuples.push(
        makeTuple({
          objectType: "doc",
          objectId: "1",
          relation: "parent",
          subjectType: "folder",
          subjectId: "ok",
        }),
        makeTuple({
          objectType: "doc",
          objectId: "2",
          relation: "parent",
          subjectType: "folder",
          subjectId: "err",
          conditionName: "flag",
        }),
      );
      if (grantOk) {
        store.tuples.push(
          makeTuple({
            objectType: "folder",
            objectId: "ok",
            relation: "member",
            subjectType: "user",
            subjectId: "alice",
          }),
        );
      }
    }

    test("an error on the subject's own row aborts the call", async () => {
      // Both engines refuse: upstream reads alice's conditioned
      // row on `doc:2` in the very first query it issues, so
      // answering `["1"]` here would answer where upstream
      // refuses -- on the commonest shape there is, one
      // conditioned row beside an unconditioned one.
      seedSubjectRow();

      await expect(listObjects(store, ALICE_VIEWER)).rejects.toBeInstanceOf(
        ConditionEvaluationError,
      );
    });

    test("an error a hop away does not cost the answer", async () => {
      // `doc:2` grants alice nothing -- the conditioned row under
      // it points at a folder she is not a member of. Upstream
      // never walks back to it and answers `["1"]`.
      seedTuplesetScan(true);

      expect(await listObjects(store, ALICE_VIEWER)).toEqual(["1"]);
    });

    test("a dropped error still lets the call answer empty", async () => {
      // The same shape with the grant removed, and the rule does
      // not change with it: an empty granted set is not evidence
      // that the erroring row was on alice's path -- a subject who
      // reaches nothing grants nothing for reasons that have
      // nothing to do with the condition. So the error is dropped
      // here too and the call answers `[]`.
      //
      // The earlier shape of this rule raised it instead, which is
      // what made `listObjects` refuse where upstream answers `[]`.
      // The cost is stated with it:
      // where upstream's reverse expansion *does* reach the
      // erroring row it refuses the whole call and this answers,
      // which is the under-reporting residue pinned in
      // `tests/conformance/vault.test.ts` and
      // `list-objects-probes.test.ts`.
      seedTuplesetScan(false);

      expect(await listObjects(store, ALICE_VIEWER)).toEqual([]);
    });

    test("a hard failure still wins over a dropped one", async () => {
      // A dropped failure is not a launch cut-off, so `doc:3` is
      // reached and its failure aborts -- even though the
      // condition error sits at a lower index.
      seedTuplesetScan(true);
      store.tuples.push(
        makeTuple({
          objectType: "doc",
          objectId: "3",
          relation: "parent",
          subjectType: "folder",
          subjectId: "ok",
        }),
      );
      store.failures.set("3", new StoreReadFailure("doc:3 failed"));

      expect(await failureMessage(listObjects(store, ALICE_VIEWER))).toBe(
        "doc:3 failed",
      );
    });
  });

  /**
   * Upstream stops at `ListObjectsMaxResults` (default 1000) and
   * truncates silently — no cursor, no error, no field saying the
   * answer was cut. The cap is asserted from **both** sides here on
   * purpose: a cap that quietly shortened a small answer would be
   * far worse than the divergence it closes, and nothing else in
   * the suite would notice.
   *
   * Which thousand upstream keeps is whatever its worker pool
   * finished first, so tsfga does not try to reproduce the
   * membership. It keeps the first `listObjectsMaxResults` granting
   * candidates in candidate order, which is deterministic on this
   * side whatever the completion order was.
   */
  describe("the answer stops at listObjectsMaxResults", () => {
    /** Grant alice outright on every candidate `1..count`. */
    function grantAll(count: number) {
      for (const objectId of docIds(count)) {
        store.tuples.push(
          makeTuple({
            objectType: "doc",
            objectId,
            relation: "viewer",
            subjectType: "user",
            subjectId: "alice",
          }),
        );
      }
    }

    test("a pool below the cap is returned whole", async () => {
      // The boundary from below. This is the case a cap must never
      // touch, and it is the expensive one to get wrong.
      seedSharedSubtree(5);
      grantAll(5);

      expect(
        await listObjects(store, ALICE_VIEWER, { listObjectsMaxResults: 10 }),
      ).toEqual(docIds(5));
    });

    test("a pool exactly at the cap is returned whole", async () => {
      seedSharedSubtree(5);
      grantAll(5);

      expect(
        await listObjects(store, ALICE_VIEWER, { listObjectsMaxResults: 5 }),
      ).toEqual(docIds(5));
    });

    test("a pool one over the cap loses exactly its last object", async () => {
      seedSharedSubtree(6);
      grantAll(6);

      expect(
        await listObjects(store, ALICE_VIEWER, { listObjectsMaxResults: 5 }),
      ).toEqual(docIds(5));
    });

    test("the default cap is 1000", async () => {
      // The figure itself, not just that some cap exists:
      // `DefaultListObjectsMaxResults` is what the conformance
      // fixtures measured at 1006 and 1100 candidates.
      seedSharedSubtree(1001);
      grantAll(1001);
      for (const id of docIds(1001)) store.delays.set(id, 0);

      expect(await listObjects(store, ALICE_VIEWER)).toHaveLength(1000);
    });

    test("Infinity opts out", async () => {
      seedSharedSubtree(6);
      grantAll(6);

      expect(
        await listObjects(store, ALICE_VIEWER, {
          listObjectsMaxResults: Number.POSITIVE_INFINITY,
        }),
      ).toEqual(docIds(6));
    });

    test("a cap of 1 answers with the first granting candidate", async () => {
      seedSharedSubtree(6);
      grantAll(6);

      expect(
        await listObjects(store, ALICE_VIEWER, { listObjectsMaxResults: 1 }),
      ).toEqual(["1"]);
    });

    test("only granting candidates count against the cap", async () => {
      // The cap bounds the answer, not the walk: four candidates
      // are checked to fill a cap of two, because two of them do
      // not grant.
      seedSharedSubtree(5);
      for (const objectId of ["2", "4"]) {
        store.tuples.push(
          makeTuple({
            objectType: "doc",
            objectId,
            relation: "viewer",
            subjectType: "user",
            subjectId: "alice",
          }),
        );
      }

      expect(
        await listObjects(store, ALICE_VIEWER, {
          listObjectsMaxResults: 2,
          maxBreadth: 1,
        }),
      ).toEqual(["2", "4"]);
      expect(store.started).toEqual(["1", "2", "3", "4"]);
    });

    test("reaching the cap stops the producers", async () => {
      // Upstream stops its producers rather than filtering a
      // complete walk, so a candidate past the cap is never
      // resolved. Candidate 6 would fail the whole call; it is
      // never launched, so it never does.
      seedSharedSubtree(6);
      grantAll(6);
      store.failures.set("6", new StoreReadFailure("doc:6 failed"));

      expect(
        await listObjects(store, ALICE_VIEWER, {
          listObjectsMaxResults: 3,
          maxBreadth: 1,
        }),
      ).toEqual(["1", "2", "3"]);
      expect(store.started).toEqual(["1", "2", "3"]);
    });

    test("a failure the pool did reach still aborts under a cap", async () => {
      // The other half of the rule above, and the one that keeps
      // the cap from becoming a way to swallow errors: the cap
      // stops candidates being *launched*, it does not suppress a
      // refusal from one that was.
      seedSharedSubtree(6);
      grantAll(6);
      store.failures.set("2", new StoreReadFailure("doc:2 failed"));

      expect(
        await failureMessage(
          listObjects(store, ALICE_VIEWER, {
            listObjectsMaxResults: 3,
            maxBreadth: 1,
          }),
        ),
      ).toBe("doc:2 failed");
    });

    test("truncation is in candidate order, not completion order", async () => {
      // All six race at breadth 6, so the granted count overshoots
      // the cap and the answer is truncated on the way out. Which
      // three survive must not depend on who finished first.
      seedSharedSubtree(6);
      grantAll(6);
      for (const [index, id] of docIds(6).entries()) {
        store.delays.set(id, (6 - index) * 5);
      }

      expect(
        await listObjects(store, ALICE_VIEWER, {
          listObjectsMaxResults: 3,
          maxBreadth: 6,
        }),
      ).toEqual(["1", "2", "3"]);
    });

    test("a cap does not turn a refusal into a short list", async () => {
      // A relation with no config is refused whatever the cap is.
      // The gates run before the pool, and the cap bounds only the
      // answer.
      await expect(
        listObjects(store, ALICE_VIEWER, { listObjectsMaxResults: 1 }),
      ).rejects.toBeInstanceOf(RelationConfigNotFoundError);
    });

    test("an invalid cap rejects before any store read", async () => {
      seedSharedSubtree(3);
      grantAll(3);
      store.resetCounts();

      for (const listObjectsMaxResults of [0, -1, 1.5, Number.NaN]) {
        await expect(
          listObjects(store, ALICE_VIEWER, { listObjectsMaxResults }),
        ).rejects.toBeInstanceOf(TsfgaError);
      }

      // Same predicate `maxDepth` carries, and applied in the same
      // place it is read: an option the library cannot honour costs
      // no round trip.
      expect(store.callsWith("listCandidateObjectIds", "doc")).toBe(0);
      expect(store.started).toEqual([]);
    });
  });

  describe("no candidates", () => {
    test("an empty candidate list resolves to an empty array", async () => {
      // The pool must settle with nothing ever launched rather
      // than hanging on a promise no callback will resolve.
      //
      // Seeded so the relation is *defined* with no candidates,
      // which is the state this is about. An undefined relation is
      // now refused before the pool is read -- the case below.
      seedSharedSubtree(0);

      expect(await listObjects(store, ALICE_VIEWER)).toEqual([]);
    });

    test("an undefined relation is refused, not answered empty", async () => {
      // The gate upstream applies before it touches data. Without
      // it the answer depends on whether the candidate pool
      // happens to be empty: a relation nothing defines would
      // report `[]` on an empty type and refuse on a populated
      // one, so the same model would answer two different ways
      // for a reason that has nothing to do with the model.
      await expect(listObjects(store, ALICE_VIEWER)).rejects.toBeInstanceOf(
        RelationConfigNotFoundError,
      );
    });
  });

  describe("through the client", () => {
    test("createTsfga forwards its options to the candidate pool", async () => {
      seedSharedSubtree(6);
      for (const id of docIds(6)) store.delays.set(id, 10);

      await createTsfga(store, { maxBreadth: 2 }).listObjects(ALICE_VIEWER);

      expect(store.peakInFlight).toBe(2);
    });
  });
});

/**
 * What the two scan calls actually do at the two boundaries their
 * JSDoc used to describe backwards: a candidate the depth budget
 * cannot resolve, and a request context `check` refuses.
 *
 * Pinned here because both are documentation-shaped claims that
 * ship in `dist/index.d.ts`, and prose is the one part of the
 * library nothing else checks. The assertions are the contrast:
 * each says what `check` does beside what the scan does, so an
 * edit that makes the two agree fails rather than passes quietly.
 */
describe("the scan calls diverge from check at two boundaries", () => {
  function chain(): MockTupleStore {
    const store = new MockTupleStore();
    store.relationConfigs.push({
      objectType: "doc",
      relation: "viewer",
      directlyAssignable: [
        { type: "user" },
        { type: "doc", relation: "viewer" },
      ],
      impliedBy: null,
      computedUserset: null,
      tupleToUserset: null,
      excludedBy: null,
      intersection: null,
    });
    // `d0 -> d1 -> ... -> d10`, with only `d10` granting alice
    // directly. Under `maxDepth: 3` the shallow end of the chain
    // resolves and the deep end exhausts the budget.
    for (let i = 0; i < 10; i++) {
      store.tuples.push({
        objectType: "doc",
        objectId: `d${i}`,
        relation: "viewer",
        subjectType: "doc",
        subjectId: `d${i + 1}`,
        subjectRelation: "viewer",
        conditionName: null,
        conditionContext: null,
      });
    }
    store.tuples.push({
      objectType: "doc",
      objectId: "d10",
      relation: "viewer",
      subjectType: "user",
      subjectId: "alice",
      subjectRelation: null,
      conditionName: null,
      conditionContext: null,
    });
    return store;
  }

  test("a depth-exceeded candidate is dropped, not propagated", async () => {
    const client = createTsfga(chain(), { maxDepth: 3 });
    // `check` raises for the deep candidate...
    await expect(
      client.check({
        objectType: "doc",
        objectId: "d0",
        relation: "viewer",
        subjectType: "user",
        subjectId: "alice",
      }),
    ).rejects.toBeInstanceOf(DepthExceededError);
    // ...and `listObjects` answers with the candidates it could
    // resolve rather than abandoning the whole call.
    expect(
      await client.listObjects({
        objectType: "doc",
        relation: "viewer",
        subjectType: "user",
        subjectId: "alice",
      }),
    ).toEqual(["d8", "d9", "d10"]);
  });

  // A control character in a string value: the shape upstream's
  // `ValidateStruct` refuses, and `ValidateStruct` lives in
  // `CheckCommand` and nowhere else in `pkg/server/commands`.
  const context = { role: "ad\u0001min" };

  test("listObjects accepts a request context check refuses", async () => {
    const client = createTsfga(chain());
    await expect(
      client.check({
        objectType: "doc",
        objectId: "d10",
        relation: "viewer",
        subjectType: "user",
        subjectId: "alice",
        context,
      }),
    ).rejects.toBeInstanceOf(InvalidRequestContextError);
    expect(
      await client.listObjects({
        objectType: "doc",
        relation: "viewer",
        subjectType: "user",
        subjectId: "alice",
        context,
      }),
    ).toContain("d10");
  });

  test("listSubjects accepts a request context check refuses", async () => {
    const client = createTsfga(chain());
    expect(
      await client.listSubjects("doc", "d10", "viewer", { context }),
    ).toHaveLength(1);
  });
});
