import { describe, expect, test } from "bun:test";
import {
  type CheckResult,
  check,
  INTERSECTION_REDUCER,
  resolveShortCircuit,
  UNION_REDUCER,
} from "../src/check.ts";
import { ConditionNotFoundError, TsfgaError } from "../src/errors.ts";
import type {
  CheckTuples,
  CheckTuplesQuery,
  ConditionDefinition,
  RelationConfig,
  Tuple,
} from "../src/types.ts";
import {
  ConfigErrorStore,
  StoreReadFailure,
} from "./helpers/erroring-store.ts";
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
    directlyAssignable: ["user", "user:*"],
    impliedBy: null,
    computedUserset: null,
    tupleToUserset: null,
    excludedBy: null,
    intersection: null,
    ...overrides,
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Records which relations are probed (node tuple reads and config
 * reads), so tests can assert that queued branches beyond the
 * breadth limit never start once the node has settled.
 */
class RecordingStore extends MockTupleStore {
  probedRelations: string[] = [];
  configRelations: string[] = [];

  override findCheckTuples(query: CheckTuplesQuery): Promise<CheckTuples> {
    this.probedRelations.push(query.relation);
    return super.findCheckTuples(query);
  }

  override findRelationConfig(
    objectType: string,
    relation: string,
  ): Promise<RelationConfig | null> {
    this.configRelations.push(relation);
    return super.findRelationConfig(objectType, relation);
  }
}

/**
 * Holds config reads open and records the maximum number in
 * flight at once. Increments happen synchronously at call time,
 * so the high-water mark is deterministic.
 */
class GatedConfigStore extends MockTupleStore {
  configHighWater = 0;
  private configInflight = 0;

  override async findRelationConfig(
    objectType: string,
    relation: string,
  ): Promise<RelationConfig | null> {
    this.configInflight++;
    this.configHighWater = Math.max(this.configHighWater, this.configInflight);
    await delay(10);
    const result = await super.findRelationConfig(objectType, relation);
    this.configInflight--;
    return result;
  }
}

/**
 * Slow condition lookups on top of the config-read failure, so one
 * store can host a slow-failing branch and a fast-failing one with
 * distinguishable error classes.
 */
class SlowConditionLookupStore extends ConfigErrorStore {
  override async findConditionDefinition(
    name: string,
  ): Promise<ConditionDefinition | null> {
    await delay(30);
    return super.findConditionDefinition(name);
  }
}

/**
 * Seed a store so doc:1#viewer is implied by the given relations
 * and a direct tuple grants (only) the relations in `granted` to
 * user:anne. Returns the store for chaining.
 */
function seedUnion<S extends MockTupleStore>(
  store: S,
  implied: string[],
  granted: string[],
): S {
  store.relationConfigs.push(
    makeConfig({ objectType: "doc", relation: "viewer", impliedBy: implied }),
  );
  for (const relation of implied) {
    store.relationConfigs.push(
      makeConfig({
        objectType: "doc",
        relation,
        directlyAssignable: ["user"],
      }),
    );
  }
  for (const relation of granted) {
    store.tuples.push(
      makeTuple({
        objectType: "doc",
        objectId: "1",
        relation,
        subjectType: "user",
        subjectId: "anne",
      }),
    );
  }
  return store;
}

const viewerRequest = {
  objectType: "doc",
  objectId: "1",
  relation: "viewer",
  subjectType: "user",
  subjectId: "anne",
};

describe("maxBreadth validation", () => {
  test("rejects zero", async () => {
    const store = new MockTupleStore();
    await expect(
      check(store, viewerRequest, { maxBreadth: 0 }),
    ).rejects.toBeInstanceOf(TsfgaError);
  });

  test("rejects negative values", async () => {
    const store = new MockTupleStore();
    await expect(
      check(store, viewerRequest, { maxBreadth: -3 }),
    ).rejects.toBeInstanceOf(TsfgaError);
  });

  test("rejects NaN", async () => {
    const store = new MockTupleStore();
    await expect(
      check(store, viewerRequest, { maxBreadth: Number.NaN }),
    ).rejects.toBeInstanceOf(TsfgaError);
  });
});

describe("sequential equivalence across breadths", () => {
  const breadths = [1, 2, 3, Number.POSITIVE_INFINITY];

  for (const maxBreadth of breadths) {
    test(`union hit on last branch at breadth ${maxBreadth}`, async () => {
      const store = seedUnion(
        new MockTupleStore(),
        ["a", "b", "c", "d"],
        ["d"],
      );
      const result = await check(store, viewerRequest, { maxBreadth });
      expect(result).toBe(true);
    });

    test(`union miss at breadth ${maxBreadth}`, async () => {
      const store = seedUnion(new MockTupleStore(), ["a", "b", "c", "d"], []);
      const result = await check(store, viewerRequest, { maxBreadth });
      expect(result).toBe(false);
    });

    test(`intersection at breadth ${maxBreadth}`, async () => {
      const store = new MockTupleStore();
      store.relationConfigs.push(
        makeConfig({
          objectType: "doc",
          relation: "access",
          directlyAssignable: ["user"],
          intersection: [
            { type: "direct" },
            { type: "computedUserset", relation: "member" },
          ],
        }),
        makeConfig({
          objectType: "doc",
          relation: "member",
          directlyAssignable: ["user"],
        }),
      );
      store.tuples.push(
        makeTuple({
          objectType: "doc",
          objectId: "1",
          relation: "access",
          subjectType: "user",
          subjectId: "anne",
        }),
        makeTuple({
          objectType: "doc",
          objectId: "1",
          relation: "member",
          subjectType: "user",
          subjectId: "anne",
        }),
      );
      const granted = await check(
        store,
        { ...viewerRequest, relation: "access" },
        { maxBreadth },
      );
      expect(granted).toBe(true);

      const denied = await check(
        store,
        { ...viewerRequest, relation: "access", subjectId: "bob" },
        { maxBreadth },
      );
      expect(denied).toBe(false);
    });
  }
});

describe("bounded launch behavior", () => {
  test("queued branches never start after a win at breadth 1", async () => {
    const recording = seedUnion(
      new RecordingStore(),
      ["granted", "never"],
      ["granted"],
    );
    const result = await check(recording, viewerRequest, { maxBreadth: 1 });
    expect(result).toBe(true);
    expect(recording.probedRelations.includes("never")).toBe(false);
  });

  test("the same branch does start at unbounded breadth", async () => {
    const recording = seedUnion(
      new RecordingStore(),
      ["granted", "never"],
      ["granted"],
    );
    const result = await check(recording, viewerRequest, {
      maxBreadth: Number.POSITIVE_INFINITY,
    });
    expect(result).toBe(true);
    expect(recording.probedRelations.includes("never")).toBe(true);
  });

  test("all-false union visits every branch at breadth 1", async () => {
    const recording = seedUnion(new RecordingStore(), ["r1", "r2", "r3"], []);
    const result = await check(recording, viewerRequest, { maxBreadth: 1 });
    expect(result).toBe(false);
    expect(recording.probedRelations.includes("r1")).toBe(true);
    expect(recording.probedRelations.includes("r2")).toBe(true);
    expect(recording.probedRelations.includes("r3")).toBe(true);
  });

  test("false intersection operand skips queued operands at breadth 1", async () => {
    const recording = new RecordingStore();
    recording.relationConfigs.push(
      makeConfig({
        objectType: "doc",
        relation: "access",
        directlyAssignable: ["user"],
        intersection: [
          { type: "direct" },
          { type: "computedUserset", relation: "member" },
        ],
      }),
      makeConfig({
        objectType: "doc",
        relation: "member",
        directlyAssignable: ["user"],
      }),
    );
    const result = await check(
      recording,
      { ...viewerRequest, relation: "access" },
      { maxBreadth: 1 },
    );
    expect(result).toBe(false);
    expect(recording.configRelations.includes("member")).toBe(false);
  });

  test("breadth bounds concurrent branch resolution", async () => {
    const relations = ["r1", "r2", "r3", "r4"];
    const bounded = seedUnion(new GatedConfigStore(), relations, []);
    await check(bounded, viewerRequest, { maxBreadth: 1 });
    expect(bounded.configHighWater).toBe(1);

    const unbounded = seedUnion(new GatedConfigStore(), relations, []);
    await check(unbounded, viewerRequest, {
      maxBreadth: Number.POSITIVE_INFINITY,
    });
    expect(unbounded.configHighWater).toBe(4);
  });

  test("default maxBreadth is 10, matching OpenFGA's default", async () => {
    // 12 branches: the default admits exactly 10 in flight;
    // explicit Infinity restores unbounded fanout.
    const relations = Array.from({ length: 12 }, (_, i) => `r${i}`);
    const defaulted = seedUnion(new GatedConfigStore(), relations, []);
    await check(defaulted, viewerRequest, {});
    expect(defaulted.configHighWater).toBe(10);

    const unbounded = seedUnion(new GatedConfigStore(), relations, []);
    await check(unbounded, viewerRequest, {
      maxBreadth: Number.POSITIVE_INFINITY,
    });
    expect(unbounded.configHighWater).toBe(12);
  });
});

describe("error semantics under bounded breadth", () => {
  /**
   * viewer implied by [broken, ...rest], where `broken`'s config
   * read rejects. The error source is a store failure rather than
   * a cycle: what is under test is how the bounded combinator
   * treats *an* erroring branch, which is independent of cycle
   * semantics.
   */
  function erringStore(rest: string[], granted: string[]): MockTupleStore {
    const store = seedUnion(new ConfigErrorStore(["broken"]), rest, granted);
    const viewer = store.relationConfigs.find((c) => c.relation === "viewer");
    if (viewer) {
      viewer.impliedBy = ["broken", ...rest];
    }
    return store;
  }

  test("error plus all-false at breadth 1 propagates the error", async () => {
    const store = erringStore(["r2"], []);
    await expect(
      check(store, viewerRequest, { maxBreadth: 1 }),
    ).rejects.toBeInstanceOf(StoreReadFailure);
  });

  test("a later true beats an earlier error at breadth 1", async () => {
    const store = erringStore(["granted"], ["granted"]);
    const result = await check(store, viewerRequest, { maxBreadth: 1 });
    expect(result).toBe(true);
  });

  test("false intersection operand beats an errored sibling at breadth 1", async () => {
    const store = new ConfigErrorStore(["broken"]);
    store.relationConfigs.push(
      makeConfig({
        objectType: "doc",
        relation: "access",
        intersection: [
          { type: "computedUserset", relation: "broken" },
          { type: "computedUserset", relation: "member" },
        ],
      }),
      makeConfig({
        objectType: "doc",
        relation: "member",
        directlyAssignable: ["user"],
      }),
    );
    const result = await check(
      store,
      { ...viewerRequest, relation: "access" },
      { maxBreadth: 1 },
    );
    expect(result).toBe(false);
  });

  test("losing branch that errors after a win still resolves true", async () => {
    // `slowbroken` rejects 20ms in, well after the granted branch
    // has already won the union.
    const store = new ConfigErrorStore(["slowbroken"], 20);
    store.relationConfigs.push(
      makeConfig({
        objectType: "doc",
        relation: "viewer",
        impliedBy: ["granted", "slowbroken"],
      }),
      makeConfig({
        objectType: "doc",
        relation: "granted",
        directlyAssignable: ["user"],
      }),
    );
    store.tuples.push(
      makeTuple({
        objectType: "doc",
        objectId: "1",
        relation: "granted",
        subjectType: "user",
        subjectId: "anne",
      }),
    );

    const result = await check(store, viewerRequest, { maxBreadth: 2 });
    expect(result).toBe(true);
    // Let the losing branch reject; an unhandled rejection would
    // fail the run.
    await delay(50);
  });
});

describe("adversarial-review regressions", () => {
  test("rejects fractional maxBreadth", async () => {
    // 1.5 would admit 2 branches in flight (`active < 1.5`),
    // silently exceeding the stated bound.
    const store = new MockTupleStore();
    await expect(
      check(store, viewerRequest, { maxBreadth: 1.5 }),
    ).rejects.toBeInstanceOf(TsfgaError);
  });

  test("empty intersection config errors instead of granting", async () => {
    // A zero-operand intersection used to resolve vacuously true
    // for every subject. OpenFGA's typesystem rejects set
    // operations with too few children as an invalid model.
    const store = new MockTupleStore();
    store.relationConfigs.push(
      makeConfig({
        objectType: "doc",
        relation: "access",
        intersection: [],
      }),
    );
    await expect(
      check(store, { ...viewerRequest, relation: "access" }),
    ).rejects.toBeInstanceOf(TsfgaError);
  });

  test("surfaced error class is pinned to array order at breadth 1", async () => {
    // Two failing branches with different error classes: slowerr
    // (first in array, ConditionNotFoundError after a delayed
    // condition lookup) and fasterr (StoreReadFailure from the
    // config read, immediately). The boolean/reject status is
    // breadth-invariant but the surfaced class is
    // completion-ordered: breadth 1 completes in array order,
    // unbounded lets the fast error record first. Pinned as
    // accepted, upstream-matching nondeterminism (OpenFGA's union
    // keeps a completion-ordered error too).
    function makeStore(): MockTupleStore {
      const store = new SlowConditionLookupStore(["fasterr"]);
      store.relationConfigs.push(
        makeConfig({
          objectType: "doc",
          relation: "viewer",
          impliedBy: ["slowerr", "fasterr"],
        }),
        makeConfig({
          objectType: "doc",
          relation: "slowerr",
          directlyAssignable: ["user"],
        }),
      );
      store.tuples.push(
        makeTuple({
          objectType: "doc",
          objectId: "1",
          relation: "slowerr",
          subjectType: "user",
          subjectId: "anne",
          conditionName: "missing_definition",
        }),
      );
      return store;
    }

    await expect(
      check(makeStore(), viewerRequest, { maxBreadth: 1 }),
    ).rejects.toBeInstanceOf(ConditionNotFoundError);
    await expect(
      check(makeStore(), viewerRequest, {
        maxBreadth: Number.POSITIVE_INFINITY,
      }),
    ).rejects.toBeInstanceOf(StoreReadFailure);
  });
});

describe("resolveShortCircuit hardening", () => {
  // Direct combinator tests: neither trap is reachable through
  // check() (it only builds dense arrays of async closures), so
  // the latent liveness bugs found in review are pinned here
  // against the exported combinator itself.

  class SyncBoom extends Error {}

  const grant = async (): Promise<CheckResult> => ({
    allowed: true,
    cycleDetected: false,
  });
  const deny = async (): Promise<CheckResult> => ({
    allowed: false,
    cycleDetected: false,
  });
  const thrower = (): Promise<CheckResult> => {
    throw new SyncBoom("sync boom");
  };

  test("array holes cannot stall the combinator", async () => {
    // Before hardening, a hole consumed on the refill path could
    // exhaust the array with nothing in flight and never settle.
    const handlers: Array<() => Promise<CheckResult>> = [];
    handlers[0] = deny;
    handlers[2] = deny;
    expect(
      (await resolveShortCircuit(handlers, 1, UNION_REDUCER)).allowed,
    ).toBe(false);

    const onlyHoles: Array<() => Promise<CheckResult>> = [];
    onlyHoles.length = 3;
    expect(
      (await resolveShortCircuit(onlyHoles, 2, UNION_REDUCER)).allowed,
    ).toBe(false);
    expect(
      (await resolveShortCircuit([], 1, INTERSECTION_REDUCER)).allowed,
    ).toBe(true);
  });

  test("synchronously-throwing handler counts as a rejected branch", async () => {
    // Before hardening, a sync throw launched from the refill path
    // leaked its slot (permanent active over-count -> stall) and
    // escaped as an unhandled rejection.
    const laterTrueWins = await resolveShortCircuit(
      [deny, thrower, grant],
      1,
      UNION_REDUCER,
    );
    expect(laterTrueWins.allowed).toBe(true);

    await expect(
      resolveShortCircuit([deny, thrower], 1, UNION_REDUCER),
    ).rejects.toBeInstanceOf(SyncBoom);

    // Intersection dual: a sync throw with no definitive false
    // rejects; a definitive false still beats it.
    await expect(
      resolveShortCircuit([grant, thrower], 1, INTERSECTION_REDUCER),
    ).rejects.toBeInstanceOf(SyncBoom);
    const falseBeatsThrow = await resolveShortCircuit(
      [thrower, deny],
      1,
      INTERSECTION_REDUCER,
    );
    expect(falseBeatsThrow.allowed).toBe(false);
  });

  test("cycle flag folds per the reducer, not as a plain false", async () => {
    // The two reducers differ exactly here, so pin it directly on
    // the combinator rather than only through check().
    const cycle = async (): Promise<CheckResult> => ({
      allowed: false,
      cycleDetected: true,
    });

    // Union: a cycle among all-false branches makes the false
    // indeterminate; a grant anywhere clears it again.
    const unionCycled = await resolveShortCircuit(
      [deny, cycle],
      1,
      UNION_REDUCER,
    );
    expect(unionCycled.allowed).toBe(false);
    expect(unionCycled.cycleDetected).toBe(true);

    const unionGranted = await resolveShortCircuit(
      [cycle, grant],
      1,
      UNION_REDUCER,
    );
    expect(unionGranted.allowed).toBe(true);
    expect(unionGranted.cycleDetected).toBe(false);

    // Intersection: the first failing operand decides and carries
    // its flag out, whichever kind of failure it is. So the same
    // operand set answers differently depending on which failure
    // is reached first — deliberately, because that is what
    // upstream does and the flag is visible one level up. See
    // tests/conformance/intersection-cycle-precedence.test.ts.
    const intersected = await resolveShortCircuit(
      [grant, cycle, grant],
      1,
      INTERSECTION_REDUCER,
    );
    expect(intersected.allowed).toBe(false);
    expect(intersected.cycleDetected).toBe(true);

    const cycleFirst = await resolveShortCircuit(
      [cycle, deny],
      1,
      INTERSECTION_REDUCER,
    );
    expect(cycleFirst.allowed).toBe(false);
    expect(cycleFirst.cycleDetected).toBe(true);

    const denyFirst = await resolveShortCircuit(
      [deny, cycle],
      1,
      INTERSECTION_REDUCER,
    );
    expect(denyFirst.allowed).toBe(false);
    expect(denyFirst.cycleDetected).toBe(false);

    // An error still outranks a cycle-flagged false in a union.
    await expect(
      resolveShortCircuit([cycle, thrower], 1, UNION_REDUCER),
    ).rejects.toBeInstanceOf(SyncBoom);
  });
});
