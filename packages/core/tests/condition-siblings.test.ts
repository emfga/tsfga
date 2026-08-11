import { beforeEach, describe, expect, test } from "bun:test";
import { check } from "../src/check.ts";
import { ConditionEvaluationError } from "../src/errors.ts";
import type { RelationConfig, Tuple } from "../src/types.ts";
import { MockTupleStore } from "./helpers/mock-store.ts";

/**
 * A condition that cannot be evaluated is not, on its own, the
 * answer. OpenFGA reads a set of sibling rows through one
 * `ConditionsFilteredTupleKeyIterator`, which stashes the first
 * evaluation error and raises it at the end **only if no row's
 * condition evaluated true**.
 *
 * The eight tupleset shapes and six userset shapes are pinned
 * two-sided in `tests/conformance/condition-error-siblings.test.ts`
 * against the container. What that suite cannot pin is **row
 * order**: nothing in the Kysely adapter orders
 * `findTuplesByRelation`, so the two orders there are two fixtures
 * rather than a guarantee. Here the store hands the rows back in a
 * declared order, so each pair really is the same rows reversed.
 */

const HOLDS = { conditionName: "ip", conditionContext: { ip: "10.0.0.1" } };
const FAILS = { conditionName: "ip", conditionContext: { ip: "10.0.0.2" } };
/** No context at all: `ip` is unbound, so evaluation throws. */
const BROKEN = { conditionName: "ip" };

function makeTuple(overrides: Partial<Tuple>): Tuple {
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

function makeConfig(overrides: Partial<RelationConfig>): RelationConfig {
  return {
    objectType: "doc",
    relation: "viewer",
    directlyAssignable: [],
    impliedBy: null,
    computedUserset: null,
    tupleToUserset: null,
    excludedBy: null,
    intersection: null,
    ...overrides,
  };
}

describe("a condition error beside its siblings", () => {
  let store: MockTupleStore;

  beforeEach(() => {
    store = new MockTupleStore();
    store.conditionDefinitions.push({
      name: "ip",
      expression: 'ip == "10.0.0.1"',
      parameters: { ip: "string" },
    });
  });

  describe("on a tupleset relation", () => {
    /**
     * `doc.viewer: viewer from parent`, where `parent` admits
     * folders under `ip`. `grant` has alice as a viewer; `deny`
     * does not, so a row pointing at it is valid-but-denying.
     */
    beforeEach(() => {
      store.relationConfigs.push(
        makeConfig({
          relation: "parent",
          directlyAssignable: [{ type: "folder", condition: "ip" }],
        }),
        makeConfig({
          relation: "viewer",
          tupleToUserset: [{ tupleset: "parent", computedUserset: "viewer" }],
        }),
        makeConfig({
          objectType: "folder",
          relation: "viewer",
          directlyAssignable: [{ type: "user" }],
        }),
      );
      store.tuples.push(
        makeTuple({
          objectType: "folder",
          objectId: "grant",
          subjectId: "alice",
        }),
      );
    });

    function parent(folder: string, condition: Partial<Tuple>): Tuple {
      return makeTuple({
        relation: "parent",
        subjectType: "folder",
        subjectId: folder,
        ...condition,
      });
    }

    const request = {
      objectType: "doc",
      objectId: "1",
      relation: "viewer",
      subjectType: "user",
      subjectId: "alice",
    };

    const shapes: Array<[string, Tuple[], boolean | "throws"]> = [
      ["broken alone", [parent("grant", BROKEN)], "throws"],
      [
        "a granting sibling rescues it",
        [parent("grant", BROKEN), parent("g2", HOLDS)],
        true,
      ],
      [
        "a denying sibling whose condition held rescues it",
        [parent("grant", BROKEN), parent("deny", HOLDS)],
        false,
      ],
      [
        "a sibling whose condition failed does not rescue it",
        [parent("grant", BROKEN), parent("deny", FAILS)],
        "throws",
      ],
    ];

    for (const [name, rows, expected] of shapes) {
      for (const reversed of [false, true]) {
        const order = reversed ? " (rows reversed)" : "";
        test(`${name}${order}`, async () => {
          store.tuples.push(
            makeTuple({
              objectType: "folder",
              objectId: "g2",
              relation: "viewer",
              subjectId: "alice",
            }),
          );
          store.tuples.push(...(reversed ? [...rows].reverse() : rows));

          if (expected === "throws") {
            await expect(check(store, request)).rejects.toBeInstanceOf(
              ConditionEvaluationError,
            );
          } else {
            expect(await check(store, request)).toBe(expected);
          }
        });
      }
    }
  });

  describe("on a userset scan", () => {
    /**
     * `doc.viewer: [team#member with ip]`. alice is a member of
     * `in`, not of `out`.
     */
    beforeEach(() => {
      store.relationConfigs.push(
        makeConfig({
          relation: "viewer",
          directlyAssignable: [
            { type: "user", condition: "ip" },
            { type: "team", relation: "member", condition: "ip" },
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
          objectType: "team",
          objectId: "in",
          relation: "member",
          subjectId: "alice",
        }),
      );
    });

    function member(team: string, condition: Partial<Tuple>): Tuple {
      return makeTuple({
        subjectType: "team",
        subjectId: team,
        subjectRelation: "member",
        ...condition,
      });
    }

    const request = {
      objectType: "doc",
      objectId: "1",
      relation: "viewer",
      subjectType: "user",
      subjectId: "alice",
    };

    const shapes: Array<[string, Tuple[], boolean | "throws"]> = [
      ["broken alone", [member("in", BROKEN)], "throws"],
      [
        "a granting sibling rescues it",
        [member("out", BROKEN), member("in", HOLDS)],
        true,
      ],
      [
        "a denying sibling whose condition held rescues it",
        [member("out", BROKEN), member("out2", HOLDS)],
        false,
      ],
      [
        "a sibling whose condition failed does not rescue it",
        [member("out", BROKEN), member("out2", FAILS)],
        "throws",
      ],
    ];

    for (const [name, rows, expected] of shapes) {
      for (const reversed of [false, true]) {
        const order = reversed ? " (rows reversed)" : "";
        test(`${name}${order}`, async () => {
          store.tuples.push(...(reversed ? [...rows].reverse() : rows));

          if (expected === "throws") {
            await expect(check(store, request)).rejects.toBeInstanceOf(
              ConditionEvaluationError,
            );
          } else {
            expect(await check(store, request)).toBe(expected);
          }
        });
      }
    }

    /**
     * The scope of the swallow, and the reason it is a flag over
     * the userset rows rather than over the node. Measured on
     * v1.18.2: upstream still refuses here.
     */
    test("a userset row that held does not rescue a direct row", async () => {
      store.tuples.push(makeTuple({ ...BROKEN }), member("out2", HOLDS));

      await expect(check(store, request)).rejects.toBeInstanceOf(
        ConditionEvaluationError,
      );
    });
  });
});
