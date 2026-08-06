import { describe, expect, test } from "bun:test";
import { check } from "../src/check.ts";
import {
  ConditionNotFoundError,
  DepthExceededError,
  RelationConfigNotFoundError,
} from "../src/errors.ts";
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
 * MockTupleStore that holds every node read open for a few
 * milliseconds and records the maximum number of simultaneously
 * in-flight reads, so tests can assert reads overlap.
 */
class GatedStore extends MockTupleStore {
  inflight = 0;
  highWater = 0;

  private async gate<T>(op: () => Promise<T>): Promise<T> {
    this.inflight++;
    this.highWater = Math.max(this.highWater, this.inflight);
    await delay(10);
    const result = await op();
    this.inflight--;
    return result;
  }

  override findRelationConfig(
    objectType: string,
    relation: string,
  ): Promise<RelationConfig | null> {
    return this.gate(() => super.findRelationConfig(objectType, relation));
  }

  override findDirectTuple(
    objectType: string,
    objectId: string,
    relation: string,
    subjectType: string,
    subjectId: string,
  ): Promise<Tuple | null> {
    return this.gate(() =>
      super.findDirectTuple(
        objectType,
        objectId,
        relation,
        subjectType,
        subjectId,
      ),
    );
  }

  override findUsersetTuples(
    objectType: string,
    objectId: string,
    relation: string,
  ): Promise<Tuple[]> {
    return this.gate(() =>
      super.findUsersetTuples(objectType, objectId, relation),
    );
  }
}

/** Rejects the config read after the tuple reads have resolved. */
class DelayedConfigErrorStore extends MockTupleStore {
  override async findRelationConfig(
    _objectType: string,
    _relation: string,
  ): Promise<RelationConfig | null> {
    await delay(10);
    throw new RelationConfigReadFailure("config read failed");
  }
}

class RelationConfigReadFailure extends Error {}

/**
 * Delays config reads for the "slow" object type so a
 * later-indexed validation failure completes first.
 */
class SlowConfigStore extends MockTupleStore {
  configHighWater = 0;
  private configInflight = 0;

  override async findRelationConfig(
    objectType: string,
    relation: string,
  ): Promise<RelationConfig | null> {
    this.configInflight++;
    this.configHighWater = Math.max(this.configHighWater, this.configInflight);
    if (objectType === "slow") {
      await delay(20);
    }
    const result = await super.findRelationConfig(objectType, relation);
    this.configInflight--;
    return result;
  }
}

describe("single-wave node reads", () => {
  test("config fetch and tuple reads are issued concurrently", async () => {
    const store = new GatedStore();
    store.relationConfigs.push(
      makeConfig({
        objectType: "doc",
        relation: "viewer",
        directlyAssignableTypes: ["user"],
      }),
    );

    const result = await check(store, {
      objectType: "doc",
      objectId: "1",
      relation: "viewer",
      subjectType: "user",
      subjectId: "alice",
    });

    expect(result).toBe(false);
    // One node issues 4 reads (config, direct, wildcard, userset)
    // in a single overlapping wave.
    expect(store.highWater).toBe(4);
  });

  test("config-read error surfaces after tuple reads resolve", async () => {
    const store = new DelayedConfigErrorStore();
    store.tuples.push(
      makeTuple({
        objectType: "doc",
        objectId: "1",
        relation: "viewer",
        subjectType: "user",
        subjectId: "alice",
      }),
    );

    await expect(
      check(store, {
        objectType: "doc",
        objectId: "1",
        relation: "viewer",
        subjectType: "user",
        subjectId: "alice",
      }),
    ).rejects.toBeInstanceOf(RelationConfigReadFailure);
  });

  test("unconditioned direct hit launches no sub-checks", async () => {
    const store = new MockTupleStore();
    store.relationConfigs.push(
      makeConfig({
        objectType: "doc",
        relation: "viewer",
        directlyAssignableTypes: ["user"],
        allowsUsersetSubjects: true,
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
        subjectType: "user",
        subjectId: "alice",
      }),
    );
    for (let i = 0; i < 3; i++) {
      store.tuples.push(
        makeTuple({
          objectType: "doc",
          objectId: "1",
          relation: "viewer",
          subjectType: "team",
          subjectId: `t${i}`,
          subjectRelation: "member",
        }),
      );
    }
    store.resetCounts();

    const result = await check(store, {
      objectType: "doc",
      objectId: "1",
      relation: "viewer",
      subjectType: "user",
      subjectId: "alice",
    });

    expect(result).toBe(true);
    // Only the root node's probes; the 3 userset branches would
    // each have added 2 more findDirectTuple calls.
    expect(store.counts.findDirectTuple).toBe(2);
    expect(store.counts.findUsersetTuples).toBe(1);
  });

  test("sibling grant wins over a direct-condition error", async () => {
    const store = new MockTupleStore();
    store.relationConfigs.push(
      makeConfig({
        objectType: "doc",
        relation: "viewer",
        directlyAssignableTypes: ["user"],
        allowsUsersetSubjects: true,
      }),
      makeConfig({
        objectType: "team",
        relation: "member",
        directlyAssignableTypes: ["user"],
      }),
    );
    store.tuples.push(
      // Direct hit whose condition definition does not exist.
      makeTuple({
        objectType: "doc",
        objectId: "1",
        relation: "viewer",
        subjectType: "user",
        subjectId: "alice",
        conditionName: "missing",
      }),
      makeTuple({
        objectType: "doc",
        objectId: "1",
        relation: "viewer",
        subjectType: "team",
        subjectId: "eng",
        subjectRelation: "member",
      }),
      makeTuple({
        objectType: "team",
        objectId: "eng",
        relation: "member",
        subjectType: "user",
        subjectId: "alice",
      }),
    );

    expect(
      await check(store, {
        objectType: "doc",
        objectId: "1",
        relation: "viewer",
        subjectType: "user",
        subjectId: "alice",
      }),
    ).toBe(true);
  });

  test("direct-condition error propagates when nothing grants", async () => {
    const store = new MockTupleStore();
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
        subjectType: "user",
        subjectId: "alice",
        conditionName: "missing",
      }),
    );

    await expect(
      check(store, {
        objectType: "doc",
        objectId: "1",
        relation: "viewer",
        subjectType: "user",
        subjectId: "alice",
      }),
    ).rejects.toBeInstanceOf(ConditionNotFoundError);
  });

  test("conditioned direct hit races the full sibling fanout", async () => {
    // Unlike an unconditioned hit, a conditioned one is a union
    // branch: all sibling sub-checks launch concurrently. This
    // matches OpenFGA, where checkDirectUserTuple always races
    // the userset branches; breadth bounding comes later via
    // maxBreadth (mirroring OPENFGA_RESOLVE_NODE_BREADTH_LIMIT).
    const store = new MockTupleStore();
    store.relationConfigs.push(
      makeConfig({
        objectType: "doc",
        relation: "viewer",
        directlyAssignableTypes: ["user"],
        allowsUsersetSubjects: true,
      }),
      makeConfig({
        objectType: "team",
        relation: "member",
        directlyAssignableTypes: ["user"],
      }),
    );
    store.conditionDefinitions.push({
      name: "flagged",
      expression: "x == 1",
      parameters: { x: "int" },
    });
    store.tuples.push(
      makeTuple({
        objectType: "doc",
        objectId: "1",
        relation: "viewer",
        subjectType: "user",
        subjectId: "alice",
        conditionName: "flagged",
        conditionContext: { x: 1 },
      }),
    );
    for (let i = 0; i < 3; i++) {
      store.tuples.push(
        makeTuple({
          objectType: "doc",
          objectId: "1",
          relation: "viewer",
          subjectType: "team",
          subjectId: `t${i}`,
          subjectRelation: "member",
        }),
      );
    }
    store.resetCounts();

    const result = await check(store, {
      objectType: "doc",
      objectId: "1",
      relation: "viewer",
      subjectType: "user",
      subjectId: "alice",
    });

    expect(result).toBe(true);
    // Root probes (2) plus 2 probes per launched userset branch.
    expect(store.counts.findDirectTuple).toBe(8);
  });

  test("surfaced error follows completion order across branches", async () => {
    // Two erroring branches, no grant: the faster error wins, as
    // in OpenFGA's union (error identity is completion-ordered).
    // Here the direct branch's condition lookup is slowed, so the
    // sibling cycle error surfaces deterministically.
    class SlowConditionStore extends MockTupleStore {
      override async findConditionDefinition(name: string) {
        await delay(20);
        return super.findConditionDefinition(name);
      }
    }
    const store = new SlowConditionStore();
    store.relationConfigs.push(
      makeConfig({
        objectType: "doc",
        relation: "viewer",
        directlyAssignableTypes: ["user"],
        impliedBy: ["looper"],
      }),
      makeConfig({
        objectType: "doc",
        relation: "looper",
        impliedBy: ["viewer"],
      }),
    );
    store.tuples.push(
      makeTuple({
        objectType: "doc",
        objectId: "1",
        relation: "viewer",
        subjectType: "user",
        subjectId: "alice",
        conditionName: "missing",
      }),
    );

    await expect(
      check(store, {
        objectType: "doc",
        objectId: "1",
        relation: "viewer",
        subjectType: "user",
        subjectId: "alice",
      }),
    ).rejects.toBeInstanceOf(DepthExceededError);
  });

  test("tuples sampled before a mid-request config swap deny", async () => {
    // Accepted staleness: the tuple batch overlaps the config
    // fetch, so a node can pair older tuples with a newer config
    // and deny where strict config-then-tuples ordering granted.
    // Fail-closed direction only — a grant read at time t implies
    // the store granted at time t. OpenFGA cannot express this
    // scenario at all: a request resolves against one immutable
    // model snapshot, which mutable relation configs approximate
    // via the request-scoped config cache.
    class MigratingStore extends MockTupleStore {
      override async findRelationConfig(
        objectType: string,
        relation: string,
      ): Promise<RelationConfig | null> {
        if (objectType === "doc" && relation === "viewer") {
          // Atomic migration between the two samplings: grant
          // alice directly, drop the implied path she relied on.
          this.tuples.push(
            makeTuple({
              objectType: "doc",
              objectId: "1",
              relation: "viewer",
              subjectType: "user",
              subjectId: "alice",
            }),
          );
          const config = this.relationConfigs.find(
            (c) => c.objectType === "doc" && c.relation === "viewer",
          );
          if (config) {
            config.impliedBy = null;
          }
        }
        return super.findRelationConfig(objectType, relation);
      }
    }
    const store = new MigratingStore();
    store.relationConfigs.push(
      makeConfig({
        objectType: "doc",
        relation: "viewer",
        directlyAssignableTypes: ["user"],
        impliedBy: ["editor"],
      }),
      makeConfig({
        objectType: "doc",
        relation: "editor",
        directlyAssignableTypes: ["user"],
      }),
    );
    store.tuples.push(
      makeTuple({
        objectType: "doc",
        objectId: "1",
        relation: "editor",
        subjectType: "user",
        subjectId: "alice",
      }),
    );

    // Every instantaneous snapshot grants alice, and the old
    // config-then-tuples order returned true; the overlapping
    // waves pair pre-migration tuples with the post-migration
    // config and deny.
    expect(
      await check(store, {
        objectType: "doc",
        objectId: "1",
        relation: "viewer",
        subjectType: "user",
        subjectId: "alice",
      }),
    ).toBe(false);
  });
});

describe("contextual-tuple validation concurrency", () => {
  test("validation errors surface in tuple order", async () => {
    const store = new SlowConfigStore();
    store.relationConfigs.push(
      makeConfig({
        objectType: "fast",
        relation: "viewer",
        directlyAssignableTypes: ["user"],
      }),
    );

    // Tuple 0 fails slowly (no config for type "slow"); tuple 1
    // fails immediately (disallowed subject type). The first
    // tuple's error must surface regardless of completion order.
    await expect(
      check(store, {
        objectType: "fast",
        objectId: "1",
        relation: "viewer",
        subjectType: "user",
        subjectId: "alice",
        contextualTuples: [
          {
            objectType: "slow",
            objectId: "1",
            relation: "viewer",
            subjectType: "user",
            subjectId: "alice",
          },
          {
            objectType: "fast",
            objectId: "1",
            relation: "viewer",
            subjectType: "robot",
            subjectId: "r2d2",
          },
        ],
      }),
    ).rejects.toBeInstanceOf(RelationConfigNotFoundError);
  });

  test("validations run concurrently", async () => {
    const store = new SlowConfigStore();
    store.relationConfigs.push(
      makeConfig({
        objectType: "slow",
        relation: "viewer",
        directlyAssignableTypes: ["user"],
      }),
      makeConfig({
        objectType: "slow",
        relation: "editor",
        directlyAssignableTypes: ["user"],
      }),
    );

    const result = await check(store, {
      objectType: "slow",
      objectId: "1",
      relation: "viewer",
      subjectType: "user",
      subjectId: "alice",
      contextualTuples: [
        {
          objectType: "slow",
          objectId: "1",
          relation: "viewer",
          subjectType: "user",
          subjectId: "alice",
        },
        {
          objectType: "slow",
          objectId: "1",
          relation: "editor",
          subjectType: "user",
          subjectId: "alice",
        },
      ],
    });

    expect(result).toBe(true);
    // Both validations' config reads were in flight together.
    expect(store.configHighWater).toBe(2);
  });
});
