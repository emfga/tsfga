import { describe, expect, test } from "bun:test";
import { check, createCheckScope } from "../src/check.ts";
import { checkMany } from "../src/check-many.ts";
import { createTsfga, DEFAULT_WRITE_CONTEXT_BYTE_LIMIT } from "../src/index.ts";
import { listObjects } from "../src/list-objects.ts";
import type { CheckOptions, RelationConfig, Tuple } from "../src/types.ts";
import { MockTupleStore } from "./helpers/mock-store.ts";

/**
 * `CheckOptions`, threaded through every entry point.
 *
 * Four knobs, four entry points (`check`, `checkMany`,
 * `listObjects`, and the client `createTsfga` builds over all
 * three). The question each test asks is the same: does the option
 * reach the place it names, and is the default the one upstream
 * ships?
 */

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

function makeConfig(overrides: Partial<RelationConfig>): RelationConfig {
  return {
    objectType: "",
    relation: "",
    directlyAssignable: [],
    impliedBy: null,
    computedUserset: null,
    tupleToUserset: null,
    excludedBy: null,
    intersection: null,
    ...overrides,
  };
}

/**
 * A chain of `length` groups, each a member of the next, with alice
 * at the bottom. `group:g0#member` is one dispatch per link, so a
 * check at the top costs `length` depth.
 */
function chainStore(length: number): MockTupleStore {
  const store = new MockTupleStore();
  store.relationConfigs.push(
    makeConfig({
      objectType: "group",
      relation: "member",
      directlyAssignable: [
        { type: "user" },
        { type: "group", relation: "member" },
      ],
    }),
  );
  store.tuples.push(
    makeTuple({
      objectType: "group",
      objectId: "g0",
      relation: "member",
      subjectType: "user",
      subjectId: "alice",
    }),
  );
  for (let i = 1; i <= length; i++) {
    store.tuples.push(
      makeTuple({
        objectType: "group",
        objectId: `g${i}`,
        relation: "member",
        subjectType: "group",
        subjectId: `g${i - 1}`,
        subjectRelation: "member",
      }),
    );
  }
  return store;
}

function chainRequest(top: number) {
  return {
    objectType: "group",
    objectId: `g${top}`,
    relation: "member",
    subjectType: "user",
    subjectId: "alice",
  };
}

describe("maxDepth", () => {
  test("the default is 25, matching OPENFGA_RESOLVE_NODE_LIMIT", async () => {
    // 24 dispatches fit; 25 do not. `check` counts dispatches only,
    // so the top node itself is free.
    expect(await check(chainStore(24), chainRequest(24))).toBe(true);
    expect(check(chainStore(25), chainRequest(25))).rejects.toBeInstanceOf(
      Error,
    );
  });

  test("a raised budget resolves a chain the default refuses", async () => {
    expect(
      await check(chainStore(30), chainRequest(30), { maxDepth: 40 }),
    ).toBe(true);
  });

  test("createTsfga threads it into check, checkMany and listObjects", async () => {
    const store = chainStore(30);
    const client = createTsfga(store, { maxDepth: 40 });
    expect(await client.check(chainRequest(30))).toBe(true);
    expect((await client.checkMany([chainRequest(30)]))[0]?.allowed).toBe(true);
    expect(
      await client.listObjects({
        objectType: "group",
        relation: "member",
        subjectType: "user",
        subjectId: "alice",
      }),
    ).toContain("g30");
  });

  test("a lowered budget is honoured by all three", async () => {
    const store = chainStore(30);
    const client = createTsfga(store, { maxDepth: 3 });
    expect(client.check(chainRequest(30))).rejects.toBeInstanceOf(Error);
    // A batch reports the error against its own check.
    expect((await client.checkMany([chainRequest(30)]))[0]?.error).toBeTruthy();
    // `listObjects` drops the candidate instead — its documented
    // divergence from `check`, not an option that failed to arrive.
    expect(
      await client.listObjects({
        objectType: "group",
        relation: "member",
        subjectType: "user",
        subjectId: "alice",
      }),
    ).not.toContain("g30");
  });

  test("a nonsense maxDepth is accepted silently", async () => {
    // `maxBreadth` and `maxConcurrentChecks` both reject a value
    // that is not a positive integer or Infinity. `maxDepth` takes
    // whatever it is given: NaN compares false against every
    // budget check, so the recursion is bounded by the cycle guard
    // alone.
    for (const maxDepth of [Number.NaN, -1, 2.5, 0]) {
      const options: CheckOptions = { maxDepth };
      expect(() => createCheckScope(new MockTupleStore(), options)).toThrow();
    }
  });
});

describe("maxBreadth", () => {
  /** A relation whose usersets fan out `width` ways, none granting. */
  function fanStore(width: number): MockTupleStore {
    const store = new MockTupleStore();
    store.relationConfigs.push(
      makeConfig({
        objectType: "doc",
        relation: "viewer",
        directlyAssignable: [{ type: "team", relation: "member" }],
      }),
      makeConfig({
        objectType: "team",
        relation: "member",
        directlyAssignable: [{ type: "user" }],
      }),
    );
    for (let i = 0; i < width; i++) {
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
    return store;
  }

  /** Peak concurrent `findCheckTuples` calls against `team`. */
  async function peakFanout(options: CheckOptions): Promise<number> {
    const store = fanStore(40);
    let active = 0;
    let peak = 0;
    const honest = store.findCheckTuples.bind(store);
    store.findCheckTuples = async (query) => {
      if (query.objectType !== "team") return honest(query);
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active--;
      return honest(query);
    };
    await check(
      store,
      {
        objectType: "doc",
        objectId: "1",
        relation: "viewer",
        subjectType: "user",
        subjectId: "alice",
      },
      options,
    );
    return peak;
  }

  test("the default is 10, matching OPENFGA_RESOLVE_NODE_BREADTH_LIMIT", async () => {
    expect(await peakFanout({})).toBe(10);
  });

  test("a set value is honoured", async () => {
    expect(await peakFanout({ maxBreadth: 3 })).toBe(3);
    expect(await peakFanout({ maxBreadth: 40 })).toBe(40);
  });

  test("an invalid value is refused by check, checkMany and listObjects", async () => {
    const store = fanStore(1);
    const client = createTsfga(store, { maxBreadth: 0 });
    expect(
      client.check({
        objectType: "doc",
        objectId: "1",
        relation: "viewer",
        subjectType: "user",
        subjectId: "alice",
      }),
    ).rejects.toBeInstanceOf(Error);
    expect(client.checkMany([])).rejects.toBeInstanceOf(Error);
    expect(
      client.listObjects({
        objectType: "doc",
        relation: "viewer",
        subjectType: "user",
        subjectId: "alice",
      }),
    ).rejects.toBeInstanceOf(Error);
  });
});

describe("maxConcurrentChecks", () => {
  /** `count` documents, none granting, one check each. */
  function batchStore(count: number): MockTupleStore {
    const store = new MockTupleStore();
    store.relationConfigs.push(
      makeConfig({
        objectType: "doc",
        relation: "viewer",
        directlyAssignable: [{ type: "user" }],
      }),
    );
    for (let i = 0; i < count; i++) {
      store.tuples.push(
        makeTuple({
          objectType: "doc",
          objectId: `d${i}`,
          relation: "viewer",
          subjectType: "user",
          subjectId: "bob",
        }),
      );
    }
    return store;
  }

  async function peakChecks(
    count: number,
    options: CheckOptions,
  ): Promise<number> {
    const store = batchStore(count);
    let active = 0;
    let peak = 0;
    const honest = store.findCheckTuples.bind(store);
    store.findCheckTuples = async (query) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active--;
      return honest(query);
    };
    const requests = Array.from({ length: count }, (_, i) => ({
      objectType: "doc",
      objectId: `d${i}`,
      relation: "viewer",
      subjectType: "user",
      subjectId: "alice",
    }));
    await checkMany(store, requests, options);
    return peak;
  }

  test("the default is 50", async () => {
    expect(await peakChecks(120, {})).toBe(50);
  });

  test("a set value is honoured", async () => {
    expect(await peakChecks(120, { maxConcurrentChecks: 4 })).toBe(4);
  });

  test("it bounds whole checks, not one node's branches", async () => {
    // The two knobs are separate: 1 check at a time, each free to
    // fan out to 10.
    expect(
      await peakChecks(20, { maxConcurrentChecks: 1, maxBreadth: 10 }),
    ).toBe(1);
  });

  test("an empty batch still validates the options", async () => {
    expect(
      checkMany(new MockTupleStore(), [], { maxConcurrentChecks: 0 }),
    ).rejects.toBeInstanceOf(Error);
  });

  test("listObjects does not take it — its pool is maxBreadth", async () => {
    // Upstream sizes the ListObjects pool at
    // `1 + resolveNodeBreadthLimit`, so this is parity rather than
    // an oversight. Pinned because the option is on the same
    // `CheckOptions` object and reads as though it applied.
    const store = batchStore(30);
    let active = 0;
    let peak = 0;
    const honest = store.findCheckTuples.bind(store);
    store.findCheckTuples = async (query) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active--;
      return honest(query);
    };
    await listObjects(
      store,
      {
        objectType: "doc",
        relation: "viewer",
        subjectType: "user",
        subjectId: "alice",
      },
      { maxConcurrentChecks: 1, maxBreadth: 6 },
    );
    expect(peak).toBe(6);
  });
});

describe("writeContextByteLimit", () => {
  function conditionStore(): MockTupleStore {
    const store = new MockTupleStore();
    store.relationConfigs.push(
      makeConfig({
        objectType: "doc",
        relation: "viewer",
        directlyAssignable: [{ type: "user", condition: "big" }],
      }),
    );
    store.conditionDefinitions.push({
      name: "big",
      expression: "blob != ''",
      parameters: { blob: "string" },
    });
    return store;
  }

  const bigContext = { blob: "x".repeat(2000) };

  test("the default is 32 KiB", () => {
    expect(DEFAULT_WRITE_CONTEXT_BYTE_LIMIT).toBe(32 * 1024);
  });

  test("addTuple honours a lowered limit", async () => {
    const client = createTsfga(conditionStore(), {
      writeContextByteLimit: 100,
    });
    expect(
      client.addTuple({
        objectType: "doc",
        objectId: "1",
        relation: "viewer",
        subjectType: "user",
        subjectId: "alice",
        conditionName: "big",
        conditionContext: bigContext,
      }),
    ).rejects.toBeInstanceOf(Error);
  });

  test("a contextual tuple is not measured against it", async () => {
    // Upstream enforces the limit in the Write command and nowhere
    // else, so a check's contextual tuple carrying a large context
    // is accepted. Pinned here because the option lives on the same
    // object as the check knobs.
    const client = createTsfga(conditionStore(), {
      writeContextByteLimit: 100,
    });
    expect(
      await client.check({
        objectType: "doc",
        objectId: "1",
        relation: "viewer",
        subjectType: "user",
        subjectId: "alice",
        contextualTuples: [
          {
            objectType: "doc",
            objectId: "1",
            relation: "viewer",
            subjectType: "user",
            subjectId: "alice",
            conditionName: "big",
            conditionContext: bigContext,
          },
        ],
      }),
    ).toBe(true);
  });
});
