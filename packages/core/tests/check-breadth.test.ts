import { describe, expect, test } from "bun:test";
import { check } from "../src/check.ts";
import { DepthExceededError, TsfgaError } from "../src/errors.ts";
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Records which relations are probed (direct reads and config
 * reads), so tests can assert that queued branches beyond the
 * breadth limit never start once the node has settled.
 */
class RecordingStore extends MockTupleStore {
  probedRelations: string[] = [];
  configRelations: string[] = [];

  override findDirectTuple(
    objectType: string,
    objectId: string,
    relation: string,
    subjectType: string,
    subjectId: string,
  ): Promise<Tuple | null> {
    this.probedRelations.push(relation);
    return super.findDirectTuple(
      objectType,
      objectId,
      relation,
      subjectType,
      subjectId,
    );
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
        directlyAssignableTypes: ["user"],
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
  test("rejects zero", () => {
    const store = new MockTupleStore();
    expect(
      check(store, viewerRequest, { maxBreadth: 0 }),
    ).rejects.toBeInstanceOf(TsfgaError);
  });

  test("rejects negative values", () => {
    const store = new MockTupleStore();
    expect(
      check(store, viewerRequest, { maxBreadth: -3 }),
    ).rejects.toBeInstanceOf(TsfgaError);
  });

  test("rejects NaN", () => {
    const store = new MockTupleStore();
    expect(
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
          directlyAssignableTypes: ["user"],
          intersection: [
            { type: "direct" },
            { type: "computedUserset", relation: "member" },
          ],
        }),
        makeConfig({
          objectType: "doc",
          relation: "member",
          directlyAssignableTypes: ["user"],
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
    const result = await check(recording, viewerRequest, {});
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
        directlyAssignableTypes: ["user"],
        intersection: [
          { type: "direct" },
          { type: "computedUserset", relation: "member" },
        ],
      }),
      makeConfig({
        objectType: "doc",
        relation: "member",
        directlyAssignableTypes: ["user"],
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
    await check(unbounded, viewerRequest, {});
    expect(unbounded.configHighWater).toBe(4);
  });
});

describe("error semantics under bounded breadth", () => {
  /** viewer implied by [looper, ...rest]; looper cycles back. */
  function erringStore(rest: string[], granted: string[]): MockTupleStore {
    const store = seedUnion(new MockTupleStore(), rest, granted);
    const viewer = store.relationConfigs.find((c) => c.relation === "viewer");
    if (viewer) {
      viewer.impliedBy = ["looper", ...rest];
    }
    store.relationConfigs.push(
      makeConfig({
        objectType: "doc",
        relation: "looper",
        impliedBy: ["viewer"],
      }),
    );
    return store;
  }

  test("error plus all-false at breadth 1 propagates the error", () => {
    const store = erringStore(["r2"], []);
    expect(
      check(store, viewerRequest, { maxBreadth: 1 }),
    ).rejects.toBeInstanceOf(DepthExceededError);
  });

  test("a later true beats an earlier error at breadth 1", async () => {
    const store = erringStore(["granted"], ["granted"]);
    const result = await check(store, viewerRequest, { maxBreadth: 1 });
    expect(result).toBe(true);
  });

  test("false intersection operand beats an errored sibling at breadth 1", async () => {
    const store = new MockTupleStore();
    store.relationConfigs.push(
      makeConfig({
        objectType: "doc",
        relation: "access",
        intersection: [
          { type: "computedUserset", relation: "looper" },
          { type: "computedUserset", relation: "member" },
        ],
      }),
      makeConfig({
        objectType: "doc",
        relation: "looper",
        impliedBy: ["access"],
      }),
      makeConfig({
        objectType: "doc",
        relation: "member",
        directlyAssignableTypes: ["user"],
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
    const store = new MockTupleStore();
    store.relationConfigs.push(
      makeConfig({
        objectType: "doc",
        relation: "viewer",
        impliedBy: ["granted", "slowlooper"],
      }),
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
        subjectId: "anne",
      }),
    );
    const original = store.findRelationConfig.bind(store);
    store.findRelationConfig = async (objectType, relation) => {
      if (relation === "slowlooper") {
        await delay(20);
        return makeConfig({
          objectType: "doc",
          relation: "slowlooper",
          impliedBy: ["viewer"],
        });
      }
      return original(objectType, relation);
    };

    const result = await check(store, viewerRequest, { maxBreadth: 2 });
    expect(result).toBe(true);
    // Let the losing branch reject; an unhandled rejection would
    // fail the run.
    await delay(50);
  });
});
