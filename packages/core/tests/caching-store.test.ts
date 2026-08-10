import { beforeEach, describe, expect, test } from "bun:test";
import { CachingTupleStore } from "../src/caching-store.ts";
import { check } from "../src/check.ts";
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
    directlyAssignable: ["user", "user:*", "team", "team:*"],
    impliedBy: null,
    computedUserset: null,
    tupleToUserset: null,
    excludedBy: null,
    intersection: null,
    ...overrides,
  };
}

/**
 * MockTupleStore whose findRelationConfig rejects the first
 * `failures` calls, then behaves normally. Shares the source
 * store's data arrays.
 */
class FlakyStore extends MockTupleStore {
  configCalls = 0;
  private failuresRemaining: number;

  constructor(source: MockTupleStore, failures: number) {
    super();
    this.tuples = source.tuples;
    this.relationConfigs = source.relationConfigs;
    this.conditionDefinitions = source.conditionDefinitions;
    this.failuresRemaining = failures;
  }

  override findRelationConfig(
    objectType: string,
    relation: string,
  ): Promise<RelationConfig | null> {
    this.configCalls++;
    if (this.failuresRemaining > 0) {
      this.failuresRemaining--;
      return Promise.reject(new Error("transient store error"));
    }
    return super.findRelationConfig(objectType, relation);
  }
}

describe("CachingTupleStore", () => {
  let store: MockTupleStore;
  let caching: CachingTupleStore;

  beforeEach(() => {
    store = new MockTupleStore();
    caching = new CachingTupleStore(store);
  });

  test("memoizes findRelationConfig per objectType:relation", async () => {
    store.relationConfigs.push(
      makeConfig({ objectType: "doc", relation: "viewer" }),
    );

    const first = await caching.findRelationConfig("doc", "viewer");
    const second = await caching.findRelationConfig("doc", "viewer");

    expect(first).toEqual(second);
    expect(store.counts.findRelationConfig).toBe(1);
  });

  test("caches null relation config results", async () => {
    const first = await caching.findRelationConfig("doc", "missing");
    const second = await caching.findRelationConfig("doc", "missing");

    expect(first).toBeNull();
    expect(second).toBeNull();
    expect(store.counts.findRelationConfig).toBe(1);
  });

  test("distinct keys are fetched separately", async () => {
    await caching.findRelationConfig("doc", "viewer");
    await caching.findRelationConfig("doc", "editor");
    await caching.findRelationConfig("folder", "viewer");

    expect(store.counts.findRelationConfig).toBe(3);
  });

  test("concurrent lookups coalesce on one in-flight query", async () => {
    const [first, second] = await Promise.all([
      caching.findRelationConfig("doc", "viewer"),
      caching.findRelationConfig("doc", "viewer"),
    ]);

    expect(first).toBeNull();
    expect(second).toBeNull();
    expect(store.counts.findRelationConfig).toBe(1);
  });

  test("memoizes findConditionDefinition by name", async () => {
    store.conditionDefinitions.push({
      name: "always",
      expression: "x == 1",
      parameters: { x: "int" },
    });

    const first = await caching.findConditionDefinition("always");
    const second = await caching.findConditionDefinition("always");
    const missing = await caching.findConditionDefinition("nope");
    const missingAgain = await caching.findConditionDefinition("nope");

    expect(first).toEqual(second);
    expect(missing).toBeNull();
    expect(missingAgain).toBeNull();
    expect(store.counts.findConditionDefinition).toBe(2);
  });

  test("names containing ':' do not collide", async () => {
    store.relationConfigs.push(
      makeConfig({ objectType: "doc", relation: "a:viewer" }),
      makeConfig({
        objectType: "doc:a",
        relation: "viewer",
        impliedBy: ["owner"],
      }),
    );

    const first = await caching.findRelationConfig("doc", "a:viewer");
    const second = await caching.findRelationConfig("doc:a", "viewer");

    expect(first?.objectType).toBe("doc");
    expect(first?.impliedBy).toBeNull();
    expect(second?.objectType).toBe("doc:a");
    expect(second?.impliedBy).toEqual(["owner"]);
    expect(store.counts.findRelationConfig).toBe(2);
  });

  test("a rejected lookup is evicted and retried", async () => {
    store.relationConfigs.push(
      makeConfig({ objectType: "doc", relation: "viewer" }),
    );
    const flaky = new FlakyStore(store, 1);
    const flakyCaching = new CachingTupleStore(flaky);

    await expect(
      flakyCaching.findRelationConfig("doc", "viewer"),
    ).rejects.toBeInstanceOf(Error);

    const retried = await flakyCaching.findRelationConfig("doc", "viewer");

    expect(retried?.objectType).toBe("doc");
    expect(flaky.configCalls).toBe(2);
  });

  test("concurrent callers share one rejection, then retry", async () => {
    store.relationConfigs.push(
      makeConfig({ objectType: "doc", relation: "viewer" }),
    );
    const flaky = new FlakyStore(store, 1);
    const flakyCaching = new CachingTupleStore(flaky);

    const results = await Promise.allSettled([
      flakyCaching.findRelationConfig("doc", "viewer"),
      flakyCaching.findRelationConfig("doc", "viewer"),
    ]);

    expect(results[0].status).toBe("rejected");
    expect(results[1].status).toBe("rejected");
    expect(flaky.configCalls).toBe(1);

    const retried = await flakyCaching.findRelationConfig("doc", "viewer");
    expect(retried?.objectType).toBe("doc");
    expect(flaky.configCalls).toBe(2);
  });

  test("writes through the wrapper invalidate the entry", async () => {
    store.relationConfigs.push(
      makeConfig({ objectType: "doc", relation: "viewer" }),
    );

    const before = await caching.findRelationConfig("doc", "viewer");
    expect(before?.impliedBy).toBeNull();

    await caching.upsertRelationConfig(
      makeConfig({
        objectType: "doc",
        relation: "viewer",
        impliedBy: ["owner"],
      }),
    );
    const after = await caching.findRelationConfig("doc", "viewer");
    expect(after?.impliedBy).toEqual(["owner"]);

    await caching.deleteRelationConfig("doc", "viewer");
    const deleted = await caching.findRelationConfig("doc", "viewer");
    expect(deleted).toBeNull();

    expect(store.counts.findRelationConfig).toBe(3);
  });

  test("condition writes through the wrapper invalidate", async () => {
    store.conditionDefinitions.push({
      name: "flagged",
      expression: "x == 1",
      parameters: { x: "int" },
    });

    const before = await caching.findConditionDefinition("flagged");
    expect(before?.expression).toBe("x == 1");

    await caching.upsertConditionDefinition({
      name: "flagged",
      expression: "x == 2",
      parameters: { x: "int" },
    });
    const after = await caching.findConditionDefinition("flagged");
    expect(after?.expression).toBe("x == 2");

    expect(store.counts.findConditionDefinition).toBe(2);
  });

  test("tuple reads pass through uncached", async () => {
    const query = {
      objectType: "doc",
      objectId: "d1",
      relation: "viewer",
      subjectType: "user",
      subjectId: "alice",
      includeDirect: true,
      includeWildcard: true,
      usersetRefs: null,
    };
    await caching.findCheckTuples(query);
    await caching.findCheckTuples(query);

    expect(store.counts.findCheckTuples).toBe(2);
  });
});

describe("check() uses request-scoped config cache", () => {
  let store: MockTupleStore;

  beforeEach(() => {
    store = new MockTupleStore();
  });

  test("N-branch userset fanout fetches each config once", async () => {
    store.relationConfigs.push(
      makeConfig({
        objectType: "doc",
        relation: "viewer",
        directlyAssignable: ["user", "team#member"],
      }),
      makeConfig({
        objectType: "team",
        relation: "member",
        directlyAssignable: ["user"],
      }),
    );
    for (let i = 0; i < 5; i++) {
      store.tuples.push(
        makeTuple({
          objectType: "doc",
          objectId: "d1",
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
      objectId: "d1",
      relation: "viewer",
      subjectType: "user",
      subjectId: "alice",
    });

    expect(result).toBe(false);
    // 6 nodes (1 root + 5 teams) but only 2 distinct configs
    expect(store.counts.findRelationConfig).toBe(2);
  });

  test("sequential checks do not share a cache", async () => {
    store.relationConfigs.push(
      makeConfig({
        objectType: "doc",
        relation: "viewer",
        directlyAssignable: ["user"],
      }),
    );
    store.resetCounts();

    const request = {
      objectType: "doc",
      objectId: "d1",
      relation: "viewer",
      subjectType: "user",
      subjectId: "alice",
    };
    await check(store, request);
    await check(store, request);

    // One fetch per top-level check: the cache dies with the
    // request, so a config write between checks is observed.
    expect(store.counts.findRelationConfig).toBe(2);
  });

  test("contextual-tuple validation shares the cache", async () => {
    store.relationConfigs.push(
      makeConfig({
        objectType: "doc",
        relation: "viewer",
        directlyAssignable: ["user"],
      }),
    );
    store.resetCounts();

    const result = await check(store, {
      objectType: "doc",
      objectId: "d1",
      relation: "viewer",
      subjectType: "user",
      subjectId: "alice",
      contextualTuples: [
        {
          objectType: "doc",
          objectId: "d1",
          relation: "viewer",
          subjectType: "user",
          subjectId: "alice",
        },
      ],
    });

    expect(result).toBe(true);
    // Validation fetched doc.viewer; the check node reuses it.
    expect(store.counts.findRelationConfig).toBe(1);
  });

  test("condition shared by many tuples is fetched once", async () => {
    store.relationConfigs.push(
      makeConfig({
        objectType: "doc",
        relation: "viewer",
        directlyAssignable: ["user", "team#member"],
      }),
      makeConfig({
        objectType: "team",
        relation: "member",
        directlyAssignable: ["user"],
      }),
    );
    store.conditionDefinitions.push({
      name: "flagged",
      expression: "x == 1",
      parameters: { x: "int" },
    });
    for (let i = 0; i < 5; i++) {
      store.tuples.push(
        makeTuple({
          objectType: "doc",
          objectId: "d1",
          relation: "viewer",
          subjectType: "team",
          subjectId: `t${i}`,
          subjectRelation: "member",
          conditionName: "flagged",
        }),
      );
    }
    store.resetCounts();

    const result = await check(store, {
      objectType: "doc",
      objectId: "d1",
      relation: "viewer",
      subjectType: "user",
      subjectId: "alice",
      context: { x: 1 },
    });

    expect(result).toBe(false);
    // 5 conditional userset tuples, 1 definition fetch
    expect(store.counts.findConditionDefinition).toBe(1);
  });
});
