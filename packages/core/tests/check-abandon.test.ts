import { beforeEach, describe, expect, test } from "bun:test";
import { check } from "../src/check.ts";
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

/** Serves reads of one relation prefix slowly, the rest at once. */
class SlowStore extends MockTupleStore {
  constructor(private readonly slowPrefix: string) {
    super();
  }

  override async findCheckTuples(
    query: CheckTuplesQuery,
  ): Promise<CheckTuples> {
    const reply = await super.findCheckTuples(query);
    if (query.relation.startsWith(this.slowPrefix)) {
      await new Promise((done) => setTimeout(done, 20));
    }
    return reply;
  }
}

const settle = (ms: number) => new Promise((done) => setTimeout(done, ms));

/**
 * A union that has found its grant stops launching queued branches,
 * but the branches already in flight are a separate question: their
 * subtrees keep resolving, and keep reading, after `check()` has
 * returned. The reads are the observable — count them *after* the
 * call resolves, having drained everything already issued.
 */
describe("branches abandoned after the answer is decided", () => {
  let store: SlowStore;

  const request = {
    objectType: "doc",
    objectId: "1",
    relation: "top",
    subjectType: "user",
    subjectId: "alice",
  };

  beforeEach(() => {
    store = new SlowStore("slow");
    // `slow0` heads a chain of five nodes, each read taking 20ms.
    // `fast` grants outright. Both are launched together; `fast`
    // wins while `slow0`'s read is still in flight.
    store.relationConfigs.push(
      makeConfig({
        objectType: "doc",
        relation: "top",
        impliedBy: ["slow0", "fast"],
      }),
      makeConfig({
        objectType: "doc",
        relation: "slow0",
        impliedBy: ["slow1"],
      }),
      makeConfig({
        objectType: "doc",
        relation: "slow1",
        impliedBy: ["slow2"],
      }),
      makeConfig({
        objectType: "doc",
        relation: "slow2",
        impliedBy: ["slow3"],
      }),
      makeConfig({
        objectType: "doc",
        relation: "slow3",
        impliedBy: ["slow4"],
      }),
      makeConfig({
        objectType: "doc",
        relation: "slow4",
        directlyAssignableTypes: ["user"],
      }),
      makeConfig({
        objectType: "doc",
        relation: "fast",
        directlyAssignableTypes: ["user"],
      }),
    );
    store.tuples.push(
      makeTuple({
        objectType: "doc",
        objectId: "1",
        relation: "fast",
        subjectType: "user",
        subjectId: "alice",
      }),
    );
  });

  test("the losing branch stops reading the store", async () => {
    store.resetCounts();
    expect(await check(store, request, { maxBreadth: 10 })).toBe(true);

    // The read `slow0` had already handed to the store cannot be
    // called back, so one slow read is expected. What must not
    // happen is the other four: the chain walking on past the
    // answer.
    const duringCheck = store.counts.findCheckTuples ?? 0;
    await settle(200);
    const afterCheck = store.counts.findCheckTuples ?? 0;

    expect(afterCheck).toBe(duringCheck);
    expect(store.callsWith("findCheckTuples", "doc", "1", "slow1")).toBe(0);
    expect(store.callsWith("findCheckTuples", "doc", "1", "slow4")).toBe(0);
  });

  test("abandonment never leaks out as an error", async () => {
    // The sentinel an abandoned branch rejects with is internal. It
    // reaches a combinator that has already settled and stops
    // there; a caller must never see it, whatever the answer.
    for (const maxBreadth of [1, 2, 10, Number.POSITIVE_INFINITY]) {
      expect(await check(store, request, { maxBreadth })).toBe(true);
    }
    await settle(200);
  });

  test("a denial still walks every branch", async () => {
    // Control: abandonment must not truncate a check that has not
    // been decided. With no grant anywhere, the whole chain is
    // still read.
    store.tuples.length = 0;
    store.resetCounts();

    expect(await check(store, request, { maxBreadth: 10 })).toBe(false);
    expect(store.callsWith("findCheckTuples", "doc", "1", "slow4")).toBe(1);
  });
});
