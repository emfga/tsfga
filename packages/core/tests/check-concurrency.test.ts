import { describe, expect, test } from "bun:test";
import { check } from "../src/check.ts";
import {
  ConditionNotFoundError,
  RelationConfigNotFoundError,
} from "../src/errors.ts";
import type {
  CheckTuples,
  CheckTuplesQuery,
  RelationConfig,
  Tuple,
} from "../src/types.ts";
import {
  ConfigErrorStore,
  StoreReadFailure,
  TupleReadErrorStore,
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
    directlyAssignable: [
      { type: "user" },
      { type: "user", wildcard: true },
      { type: "robot" },
      { type: "robot", wildcard: true },
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

  override findCheckTuples(query: CheckTuplesQuery): Promise<CheckTuples> {
    return this.gate(() => super.findCheckTuples(query));
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

describe("node reads", () => {
  /** A relation that admits all three reads, so none is gated out. */
  function wideOpenConfig(relation: string): RelationConfig {
    return makeConfig({
      objectType: "doc",
      relation,
      directlyAssignable: [
        { type: "user" },
        { type: "user", wildcard: true },
        { type: "team", relation: "member" },
      ],
    });
  }

  test("a node asks the store once, not three times", async () => {
    // A relation that admits all three reads. They used to be
    // three concurrent store calls — one wave, but three
    // round-trips, which on a single-connection handle serialize.
    // They are now one call, so the gate never sees two at once.
    const store = new GatedStore();
    store.relationConfigs.push(wideOpenConfig("viewer"));

    const result = await check(store, {
      objectType: "doc",
      objectId: "1",
      relation: "viewer",
      subjectType: "user",
      subjectId: "alice",
    });

    expect(result).toBe(false);
    expect(store.highWater).toBe(1);
    expect(store.counts.findCheckTuples).toBe(1);
  });

  test("a second node of the same relation pays no config read", async () => {
    // The cost of ordering the config before the reads is one
    // round-trip per relation per request, not per node — this is
    // what makes that trade cheap enough to take. `outer` implies
    // `inner`, so two nodes resolve but `doc.inner` is read once.
    const store = new MockTupleStore();
    store.relationConfigs.push(
      makeConfig({
        objectType: "doc",
        relation: "outer",
        impliedBy: ["inner", "inner2"],
      }),
      makeConfig({
        objectType: "doc",
        relation: "inner",
        directlyAssignable: [{ type: "user" }],
      }),
    );
    store.tuples.push(
      makeTuple({
        objectType: "doc",
        objectId: "1",
        relation: "inner",
        subjectType: "user",
        subjectId: "alice",
      }),
    );
    store.resetCounts();

    // Two objects, so `doc.inner` is resolved as a node twice.
    for (const objectId of ["1", "2"]) {
      await check(
        store,
        {
          objectType: "doc",
          objectId,
          relation: "inner",
          subjectType: "user",
          subjectId: "alice",
        },
        { maxBreadth: 1 },
      );
    }
    // Two separate requests, so two config reads — not four.
    expect(store.callsWith("findRelationConfig", "doc", "inner")).toBe(2);
  });

  test("the gated-out parts are not asked for", async () => {
    // One call either way, so the saving is no longer in the call
    // count — it is in what the call asks for. A part the config
    // rules out must be absent from the query, or the store has no
    // way to narrow the scan.
    const store = new GatedStore();
    store.relationConfigs.push(
      makeConfig({
        objectType: "doc",
        relation: "viewer",
        directlyAssignable: [{ type: "user" }],
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
    ).toBe(false);
    // No `user:*` in the type list, and no userset subjects.
    expect(store.queriesFor("doc", "1", "viewer")).toEqual([
      {
        objectType: "doc",
        objectId: "1",
        relation: "viewer",
        subjectType: "user",
        subjectId: "alice",
        directRefs: [{ type: "user" }],
        wildcardRefs: [],
        usersetRefs: [],
      },
    ]);
  });

  test("a node the config closes entirely reads nothing", async () => {
    // Every part gated out leaves no query worth sending. The node
    // still resolves — through its rewrite, which reads for itself.
    const store = new GatedStore();
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
    store.tuples.push(
      makeTuple({
        objectType: "doc",
        objectId: "1",
        relation: "owner",
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
    expect(store.queriesFor("doc", "1", "viewer")).toEqual([]);
    expect(store.counts.findCheckTuples).toBe(1);
  });

  test("a tuple-read error fails the node", async () => {
    // The counterpart to the config-read failure below: the read
    // that happens after the config resolved.
    const store = new TupleReadErrorStore(["viewer"]);
    store.relationConfigs.push(
      makeConfig({
        objectType: "doc",
        relation: "viewer",
        directlyAssignable: [{ type: "user" }],
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
    ).rejects.toBeInstanceOf(StoreReadFailure);
  });

  test("a config-read error fails the node", async () => {
    // The reads are gated on the config, so a failed config read
    // means they are never issued at all — but the error the
    // caller sees is the same one as when they raced it.
    const store = new DelayedConfigErrorStore();
    // The subject gate runs before the config read and would
    // otherwise refuse first, hiding the failure under test. This
    // store overrides `findRelationConfig` only, and
    // `MockTupleStore.hasTypeDefinition` reads `relationConfigs`
    // directly — so the type is defined while every config read
    // still throws, which is exactly the state the test wants.
    store.relationConfigs.push(
      makeConfig({
        objectType: "doc",
        relation: "viewer",
        directlyAssignable: [{ type: "user" }],
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
        directlyAssignable: [
          { type: "user" },
          { type: "team", relation: "member" },
        ],
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
    // Only the root node's read; each of the 3 userset branches
    // would have added one more.
    expect(store.counts.findCheckTuples).toBe(1);
  });

  test("sibling grant wins over a direct-condition error", async () => {
    const store = new MockTupleStore();
    store.relationConfigs.push(
      makeConfig({
        objectType: "doc",
        relation: "viewer",
        directlyAssignable: [
          { type: "user" },
          { type: "team", relation: "member" },
          { type: "user", condition: "missing" },
        ],
      }),
      makeConfig({
        objectType: "team",
        relation: "member",
        directlyAssignable: [{ type: "user" }],
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
        directlyAssignable: [
          { type: "user" },
          { type: "user", condition: "missing" },
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
        directlyAssignable: [
          { type: "user" },
          { type: "team", relation: "member" },
          { type: "user", condition: "flagged" },
        ],
      }),
      makeConfig({
        objectType: "team",
        relation: "member",
        directlyAssignable: [{ type: "user" }],
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
    // The root node plus one per launched userset branch. Was 4
    // direct probes and 4 userset scans when a node read three
    // times; the branches still all launch, they just read once.
    expect(store.counts.findCheckTuples).toBe(4);
  });

  test("surfaced error follows completion order across branches", async () => {
    // Two erroring branches, no grant: the faster error wins, as
    // in OpenFGA's union (error identity is completion-ordered).
    // Here the direct branch's condition lookup is slowed, so the
    // sibling's config-read failure surfaces deterministically.
    class SlowConditionStore extends ConfigErrorStore {
      override async findConditionDefinition(name: string) {
        await delay(20);
        return super.findConditionDefinition(name);
      }
    }
    const store = new SlowConditionStore(["broken"]);
    store.relationConfigs.push(
      makeConfig({
        objectType: "doc",
        relation: "viewer",
        directlyAssignable: [
          { type: "user" },
          { type: "user", condition: "missing" },
        ],
        impliedBy: ["broken"],
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
    ).rejects.toBeInstanceOf(StoreReadFailure);
  });

  test("a mid-request config swap is read before its tuples", async () => {
    // This used to deny. While the tuple batch overlapped the
    // config fetch, a node could pair pre-migration tuples with a
    // post-migration config; that was accepted as fail-closed
    // staleness. Gating the reads on the config restores strict
    // config-then-tuples ordering, so the node now sees both
    // halves of the migration and grants — which is also the
    // better answer, since every instantaneous snapshot of the
    // store grants alice.
    //
    // Still not a guarantee, just a narrower window: the config is
    // sampled once per relation per request, so a swap between two
    // relations' samplings is unchanged. OpenFGA cannot express
    // the scenario at all — a request resolves against one
    // immutable model snapshot, which mutable relation configs
    // approximate via the request-scoped config cache.
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
        directlyAssignable: [{ type: "user" }],
        impliedBy: ["editor"],
      }),
      makeConfig({
        objectType: "doc",
        relation: "editor",
        directlyAssignable: [{ type: "user" }],
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
});

describe("contextual-tuple validation concurrency", () => {
  test("validation errors surface in tuple order", async () => {
    const store = new SlowConfigStore();
    store.relationConfigs.push(
      makeConfig({
        objectType: "fast",
        relation: "viewer",
        directlyAssignable: [{ type: "user" }],
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
        directlyAssignable: [{ type: "user" }],
      }),
      makeConfig({
        objectType: "slow",
        relation: "editor",
        directlyAssignable: [{ type: "user" }],
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
