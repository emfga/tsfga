import { beforeEach, describe, expect, test } from "bun:test";
import { check } from "../src/check.ts";
import { DepthExceededError } from "../src/errors.ts";
import { createTsfga } from "../src/index.ts";
import { listObjects } from "../src/list-objects.ts";
import type {
  CheckTuples,
  CheckTuplesQuery,
  RelationConfig,
  Tuple,
} from "../src/types.ts";
import { delay, StoreReadFailure } from "./helpers/erroring-store.ts";
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

      await listObjects(store, "doc", "viewer", "user", "alice");

      expect(store.callsWith("findRelationConfig", "doc", "viewer")).toBe(1);
      expect(store.callsWith("findRelationConfig", "folder", "member")).toBe(1);
    });

    test("a shared subtree resolves once for the whole call", async () => {
      // At breadth 1 the candidates are sequential, so each one
      // after the first finds the subtree already settled in the
      // memo. See the control below for what this replaces.
      seedSharedSubtree(5);
      store.resetCounts();

      await listObjects(store, "doc", "viewer", "user", "alice", undefined, {
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

      await listObjects(store, "doc", "viewer", "user", "alice", undefined, {
        maxBreadth: 3,
      });

      expect(store.peakInFlight).toBe(3);
    });

    test("breadth 1 runs candidates one at a time", async () => {
      seedSharedSubtree(4);

      await listObjects(store, "doc", "viewer", "user", "alice", undefined, {
        maxBreadth: 1,
      });

      expect(store.peakInFlight).toBe(1);
    });

    test("an invalid maxBreadth rejects rather than throwing", async () => {
      seedSharedSubtree(2);

      await expect(
        listObjects(store, "doc", "viewer", "user", "alice", undefined, {
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
        await listObjects(store, "doc", "viewer", "user", "alice", undefined, {
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
          listObjects(store, "doc", "viewer", "user", "alice", undefined, {
            maxBreadth: 4,
          }),
        ),
      ).toBe("doc:2 failed");
    });

    test("no candidate after a failure is started", async () => {
      seedSharedSubtree(5);
      store.failures.set("2", new StoreReadFailure("doc:2 failed"));

      await failureMessage(
        listObjects(store, "doc", "viewer", "user", "alice", undefined, {
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

      expect(
        await failureMessage(
          listObjects(store, "doc", "viewer", "user", "alice"),
        ),
      ).toBe("doc:3 failed");
    });

    test("depth exhaustion aborts the whole call", async () => {
      // Upstream maps a depth-exceeded candidate to a failed
      // ListObjects rather than silently dropping that object.
      seedSharedSubtree(3);

      await expect(
        listObjects(store, "doc", "viewer", "user", "alice", undefined, {
          maxDepth: 1,
        }),
      ).rejects.toBeInstanceOf(DepthExceededError);
    });
  });

  describe("no candidates", () => {
    test("an empty candidate list resolves to an empty array", async () => {
      // The pool must settle with nothing ever launched rather
      // than hanging on a promise no callback will resolve.
      expect(
        await listObjects(store, "doc", "viewer", "user", "alice"),
      ).toEqual([]);
    });
  });

  describe("through the client", () => {
    test("createTsfga forwards its options to the candidate pool", async () => {
      seedSharedSubtree(6);
      for (const id of docIds(6)) store.delays.set(id, 10);

      await createTsfga(store, { maxBreadth: 2 }).listObjects(
        "doc",
        "viewer",
        "user",
        "alice",
      );

      expect(store.peakInFlight).toBe(2);
    });
  });
});
