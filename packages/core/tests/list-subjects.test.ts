import { describe, expect, test } from "bun:test";
import {
  admitsSubjectRef,
  createTsfga,
  directSubjectRef,
  RelationConfigNotFoundError,
} from "../src/index.ts";
import type { RelationConfig, Tuple, TypeRestriction } from "../src/types.ts";
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
    directlyAssignable: [{ type: "user" }],
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
    // `service` has to be a type the model *defines* for the check
    // below to measure the drop. An undefined subject type is
    // refused before the relation's restrictions are consulted at
    // all, which would make the assertion pass for the other gate's
    // reason — so it is declared here, on a relation `doc.viewer`
    // has nothing to do with.
    store.relationConfigs.push(
      makeConfig({
        objectType: "fleet",
        relation: "runs",
        directlyAssignable: [{ type: "service" }],
      }),
    );

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
      makeConfig({
        directlyAssignable: [
          { type: "user" },
          { type: "user", wildcard: true },
        ],
      }),
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
      makeConfig({
        directlyAssignable: [
          { type: "user" },
          { type: "team", relation: "member" },
        ],
      }),
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

  test("no config at all raises, as `check` does", async () => {
    // It used to report the row, on the reading that a relation
    // with no config is unrestricted. `check` no longer reads it
    // that way, and the two paths agreeing is the point: a
    // `listSubjects` that reported subjects `check` refuses to act
    // on would be the granting direction of the same divergence.
    const store = new MockTupleStore();
    store.tuples.push(makeTuple({ subjectType: "service", subjectId: "bot" }));

    await expect(
      createTsfga(store).listSubjects("doc", "1", "viewer"),
    ).rejects.toBeInstanceOf(RelationConfigNotFoundError);
  });
});

/**
 * The exported predicate exists so a consumer can narrow their own
 * query the way tsfga narrows its reads. That is only worth
 * anything while the two agree, so the agreement is pinned rather
 * than assumed: a "safer" divergent variant would reintroduce
 * exactly the drift the export is meant to remove.
 */
describe("the exported gate agrees with check()", () => {
  const cases: Array<{
    label: string;
    admits: TypeRestriction[];
    tuple: Partial<Tuple>;
  }> = [
    { label: "admitted type", admits: [{ type: "user" }], tuple: {} },
    {
      label: "unadmitted type",
      admits: [{ type: "user" }],
      tuple: { subjectType: "svc" },
    },
    {
      label: "wildcard admitted",
      admits: [{ type: "user", wildcard: true }],
      tuple: { subjectId: "*" },
    },
    {
      label: "wildcard not admitted",
      admits: [{ type: "user" }],
      tuple: { subjectId: "*" },
    },
    {
      label: "userset admitted",
      admits: [{ type: "team", relation: "member" }],
      tuple: {
        subjectType: "team",
        subjectId: "eng",
        subjectRelation: "member",
      },
    },
    {
      label: "userset relation not admitted",
      admits: [{ type: "team", relation: "member" }],
      tuple: {
        subjectType: "team",
        subjectId: "eng",
        subjectRelation: "owner",
      },
    },
    { label: "admits nothing", admits: [], tuple: {} },
  ];

  for (const { label, admits, tuple } of cases) {
    test(label, async () => {
      const row = makeTuple(tuple);
      const store = new MockTupleStore();
      store.relationConfigs.push(makeConfig({ directlyAssignable: admits }));
      store.tuples.push(row);
      // A userset row only grants if the referenced relation holds,
      // so give it a member for the cases that admit one.
      store.relationConfigs.push(
        makeConfig({
          objectType: "team",
          relation: row.subjectRelation ?? "member",
          directlyAssignable: [{ type: "user" }],
        }),
      );
      store.tuples.push(
        makeTuple({
          objectType: "team",
          objectId: "eng",
          relation: row.subjectRelation ?? "member",
          subjectType: "user",
          subjectId: "alice",
        }),
      );

      const config = await store.findRelationConfig("doc", "viewer");
      if (config === null) throw new Error("the fixture writes this config");
      const admitted = admitsSubjectRef(
        config,
        directSubjectRef(
          row.subjectType,
          row.subjectId,
          row.subjectRelation,
          row.conditionName,
        ),
      );

      const granted = await createTsfga(store).check({
        objectType: "doc",
        objectId: "1",
        relation: "viewer",
        subjectType: "user",
        subjectId: "alice",
      });

      // The predicate is the necessary condition, not the
      // sufficient one: a row it rejects can never grant.
      if (!admitted) {
        expect(granted).toBe(false);
      }
      expect(
        (await createTsfga(store).listSubjects("doc", "1", "viewer")).some(
          (s) =>
            s.subjectType === row.subjectType &&
            s.subjectId === row.subjectId &&
            s.subjectRelation === row.subjectRelation,
        ),
      ).toBe(admitted);
    });
  }
});
