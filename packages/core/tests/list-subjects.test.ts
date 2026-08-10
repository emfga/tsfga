import { describe, expect, test } from "bun:test";
import { createTsfga } from "../src/index.ts";
import type { RelationConfig, Tuple } from "../src/types.ts";
import { MockTupleStore } from "./helpers/mock-store.ts";

function makeTuple(overrides: Partial<Tuple> = {}): Tuple {
  return {
    objectType: "doc",
    objectId: "1",
    relation: "viewer",
    subjectType: "user",
    subjectId: "alice",
    subjectRelation: null,
    conditionName: null,
    conditionContext: null,
    ...overrides,
  };
}

function makeConfig(overrides: Partial<RelationConfig> = {}): RelationConfig {
  return {
    objectType: "doc",
    relation: "viewer",
    directlyAssignable: ["user"],
    impliedBy: null,
    computedUserset: null,
    tupleToUserset: null,
    excludedBy: null,
    intersection: null,
    ...overrides,
  };
}

/**
 * `listSubjects` reads the same rows `check` does, so it must
 * apply the same type restrictions. It was a bare pass-through to
 * the store, which made it the one library path that reported a
 * subject the model does not admit and `check` denies.
 *
 * The route in is ordinary model evolution: `writeRelationConfig`
 * narrows a relation without revalidating the rows already stored.
 * So the rows here are pushed **onto the store**, not through
 * `addTuple` — which refuses exactly these — and that is the whole
 * point. A suite built on the validating write path cannot reach
 * the state under test.
 *
 * Upstream draws the same line: it filters in Expand and
 * ListUsers through `FilterInvalidTuples`, and deliberately does
 * *not* filter `Read`.
 */
describe("listSubjects applies the relation's type restrictions", () => {
  function storeWith(config: RelationConfig, tuples: Tuple[]): MockTupleStore {
    const store = new MockTupleStore();
    store.relationConfigs.push(config);
    store.tuples.push(...tuples);
    return store;
  }

  test("an admitted direct subject is returned", async () => {
    const store = storeWith(makeConfig(), [makeTuple()]);

    expect(await createTsfga(store).listSubjects("doc", "1", "viewer")).toEqual(
      [{ subjectType: "user", subjectId: "alice", subjectRelation: null }],
    );
  });

  test("a subject type the relation does not admit is dropped", async () => {
    const store = storeWith(makeConfig(), [
      makeTuple(),
      makeTuple({ subjectType: "service", subjectId: "bot" }),
    ]);

    const subjects = await createTsfga(store).listSubjects(
      "doc",
      "1",
      "viewer",
    );
    expect(subjects).toEqual([
      { subjectType: "user", subjectId: "alice", subjectRelation: null },
    ]);
    // The same row `check` denies.
    expect(
      await createTsfga(store).check({
        objectType: "doc",
        objectId: "1",
        relation: "viewer",
        subjectType: "service",
        subjectId: "bot",
      }),
    ).toBe(false);
  });

  test("a wildcard row is dropped unless `type:*` is admitted", async () => {
    const store = storeWith(makeConfig(), [
      makeTuple({ subjectId: "*" }),
      makeTuple(),
    ]);

    expect(await createTsfga(store).listSubjects("doc", "1", "viewer")).toEqual(
      [{ subjectType: "user", subjectId: "alice", subjectRelation: null }],
    );
  });

  test("a wildcard row is kept when `type:*` is admitted", async () => {
    const store = storeWith(
      makeConfig({ directlyAssignable: ["user", "user:*"] }),
      [makeTuple({ subjectId: "*" })],
    );

    expect(await createTsfga(store).listSubjects("doc", "1", "viewer")).toEqual(
      [{ subjectType: "user", subjectId: "*", subjectRelation: null }],
    );
  });

  test("a userset row is dropped unless its own ref is admitted", async () => {
    // The gate is not the bare subject type: a relation admitting
    // `team#member` must still drop `team#owner`.
    const store = storeWith(
      makeConfig({ directlyAssignable: ["user", "team#member"] }),
      [
        makeTuple({
          subjectType: "team",
          subjectId: "eng",
          subjectRelation: "owner",
        }),
        makeTuple({
          subjectType: "team",
          subjectId: "eng",
          subjectRelation: "member",
        }),
      ],
    );

    expect(await createTsfga(store).listSubjects("doc", "1", "viewer")).toEqual(
      [{ subjectType: "team", subjectId: "eng", subjectRelation: "member" }],
    );
  });

  test("a purely computed relation reports no direct subject", async () => {
    const store = storeWith(makeConfig({ directlyAssignable: [] }), [
      makeTuple(),
    ]);

    expect(await createTsfga(store).listSubjects("doc", "1", "viewer")).toEqual(
      [],
    );
  });

  test("no config at all stays unrestricted, as `check` does", async () => {
    const store = new MockTupleStore();
    store.tuples.push(makeTuple({ subjectType: "service", subjectId: "bot" }));

    expect(await createTsfga(store).listSubjects("doc", "1", "viewer")).toEqual(
      [{ subjectType: "service", subjectId: "bot", subjectRelation: null }],
    );
  });
});
