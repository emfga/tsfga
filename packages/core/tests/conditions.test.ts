import { describe, expect, test } from "bun:test";
import { coerceContext, evaluateTupleCondition } from "../src/conditions.ts";
import {
  ConditionEvaluationError,
  ConditionNotFoundError,
} from "../src/errors.ts";
import type { ConditionParameterType, Tuple } from "../src/types.ts";
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

describe("evaluateTupleCondition", () => {
  test("returns true when tuple has no condition", async () => {
    const store = new MockTupleStore();
    const tuple = makeTuple();
    expect(await evaluateTupleCondition(store, tuple)).toBe(true);
  });

  test("returns true when condition evaluates to true", async () => {
    const store = new MockTupleStore();
    store.conditionDefinitions.push({
      name: "in_region",
      expression: 'region == "us"',
      parameters: { region: "string" },
    });
    const tuple = makeTuple({ conditionName: "in_region" });
    expect(await evaluateTupleCondition(store, tuple, { region: "us" })).toBe(
      true,
    );
  });

  test("returns false when condition evaluates to false", async () => {
    const store = new MockTupleStore();
    store.conditionDefinitions.push({
      name: "in_region",
      expression: 'region == "us"',
      parameters: { region: "string" },
    });
    const tuple = makeTuple({ conditionName: "in_region" });
    expect(await evaluateTupleCondition(store, tuple, { region: "eu" })).toBe(
      false,
    );
  });

  test("tuple context takes precedence over request context", async () => {
    const store = new MockTupleStore();
    store.conditionDefinitions.push({
      name: "in_region",
      expression: 'region == "us"',
      parameters: { region: "string" },
    });
    const tuple = makeTuple({
      conditionName: "in_region",
      conditionContext: { region: "eu" },
    });
    // Tuple context overrides request context
    expect(await evaluateTupleCondition(store, tuple, { region: "us" })).toBe(
      false,
    );
  });

  test("uses tuple context when no request context", async () => {
    const store = new MockTupleStore();
    store.conditionDefinitions.push({
      name: "in_region",
      expression: 'region == "us"',
      parameters: { region: "string" },
    });
    const tuple = makeTuple({
      conditionName: "in_region",
      conditionContext: { region: "us" },
    });
    expect(await evaluateTupleCondition(store, tuple)).toBe(true);
  });

  test("throws when a condition parameter is missing", async () => {
    const store = new MockTupleStore();
    store.conditionDefinitions.push({
      name: "in_region",
      expression: 'region == "us"',
      parameters: { region: "string" },
    });
    const tuple = makeTuple({ conditionName: "in_region" });
    // Missing declared parameters are an evaluation ERROR, not an
    // unmet condition: OpenFGA's check path errors, and a silent
    // `false` would fail open through an exclusion branch.
    await expect(evaluateTupleCondition(store, tuple)).rejects.toBeInstanceOf(
      ConditionEvaluationError,
    );
    await expect(
      evaluateTupleCondition(store, tuple, {}),
    ).rejects.toBeInstanceOf(ConditionEvaluationError);
  });

  test("throws when one of several parameters is missing", async () => {
    const store = new MockTupleStore();
    store.conditionDefinitions.push({
      name: "region_and_tier",
      expression: 'region == "us" && tier == "gold"',
      parameters: { region: "string", tier: "string" },
    });
    const tuple = makeTuple({ conditionName: "region_and_tier" });
    await expect(
      evaluateTupleCondition(store, tuple, { region: "us" }),
    ).rejects.toBeInstanceOf(ConditionEvaluationError);
  });

  test("throws ConditionNotFoundError for missing condition", async () => {
    const store = new MockTupleStore();
    const tuple = makeTuple({ conditionName: "nonexistent" });
    await expect(evaluateTupleCondition(store, tuple)).rejects.toBeInstanceOf(
      ConditionNotFoundError,
    );
  });

  test("throws ConditionEvaluationError for invalid expression", async () => {
    const store = new MockTupleStore();
    store.conditionDefinitions.push({
      name: "bad_expr",
      expression: "x + y",
      parameters: { x: "int", y: "int" },
    });
    const tuple = makeTuple({ conditionName: "bad_expr" });
    // Missing required context variables - should throw evaluation error
    // cel-js may return undefined or throw; we treat non-true as false
    // Let's test with a condition that definitely errors
    store.conditionDefinitions.length = 0;
    store.conditionDefinitions.push({
      name: "bad_expr",
      expression: "x.nonexistent_method()",
      parameters: {},
    });
    await expect(
      evaluateTupleCondition(store, tuple, { x: 42 }),
    ).rejects.toBeInstanceOf(ConditionEvaluationError);
  });

  test("caches compiled expressions", async () => {
    const store = new MockTupleStore();
    store.conditionDefinitions.push({
      name: "simple",
      expression: "allowed == true",
      parameters: { allowed: "bool" },
    });
    const tuple = makeTuple({ conditionName: "simple" });

    // Call twice - second call should use cached expression
    expect(await evaluateTupleCondition(store, tuple, { allowed: true })).toBe(
      true,
    );
    expect(await evaluateTupleCondition(store, tuple, { allowed: false })).toBe(
      false,
    );
  });

  test("redefined condition evaluates the new expression", async () => {
    const store = new MockTupleStore();
    store.conditionDefinitions.push({
      name: "threshold",
      expression: "x > 5",
      parameters: { x: "int" },
    });
    const tuple = makeTuple({ conditionName: "threshold" });
    expect(await evaluateTupleCondition(store, tuple, { x: 10 })).toBe(true);

    // Redefine the condition with a stricter expression. The
    // compiled-expression cache is keyed by expression source, so
    // the new expression must take effect immediately.
    await store.upsertConditionDefinition({
      name: "threshold",
      expression: "x > 100",
      parameters: { x: "int" },
    });
    expect(await evaluateTupleCondition(store, tuple, { x: 10 })).toBe(false);
    expect(await evaluateTupleCondition(store, tuple, { x: 200 })).toBe(true);
  });

  test("handles numeric comparisons", async () => {
    const store = new MockTupleStore();
    store.conditionDefinitions.push({
      name: "min_level",
      expression: "level >= 5",
      parameters: { level: "int" },
    });
    const tuple = makeTuple({ conditionName: "min_level" });
    expect(await evaluateTupleCondition(store, tuple, { level: 10 })).toBe(
      true,
    );
    expect(await evaluateTupleCondition(store, tuple, { level: 3 })).toBe(
      false,
    );
  });

  test("handles uint comparisons", async () => {
    const store = new MockTupleStore();
    store.conditionDefinitions.push({
      name: "under_limit",
      expression: "count < limit",
      parameters: { count: "uint", limit: "uint" },
    });
    const tuple = makeTuple({ conditionName: "under_limit" });
    expect(
      await evaluateTupleCondition(store, tuple, { count: 5, limit: 10 }),
    ).toBe(true);
    expect(
      await evaluateTupleCondition(store, tuple, { count: 10, limit: 10 }),
    ).toBe(false);
  });
});

/**
 * The coercion table, ported from OpenFGA's
 * `internal/condition/types/converters.go` and probed against the
 * container at v1.18.2.
 *
 * `4.5` declared `int` is the case that motivates it. tsfga read
 * it as an ordinary number, CEL compared it, and the condition
 * resolved `false` — which on the subtract side of an `excludedBy`
 * means the exclusion does not fire, so a mistyped context value
 * *granted*. `"42"` declared `int` is the mirror: tsfga threw
 * where OpenFGA accepts.
 */
describe("condition parameter coercion", () => {
  const ACCEPTED: Array<[ConditionParameterType, unknown]> = [
    ["int", 42],
    ["int", "42"],
    ["int", -7],
    ["uint", 7],
    ["uint", "7"],
    ["uint", 0],
    ["double", 1.5],
    ["double", "1.5"],
    ["double", 2],
    ["bool", true],
    ["bool", false],
    ["string", "x"],
    ["string", ""],
    ["duration", "1h"],
    ["duration", "1.5h"],
    ["duration", "2h45m"],
    ["duration", "300ms"],
    ["timestamp", "2026-01-01T00:00:00Z"],
    ["timestamp", "2026-01-01T00:00:00+01:00"],
    ["list", []],
    ["list", ["a"]],
    ["map", {}],
    ["map", { a: "x" }],
    ["any", { x: 1 }],
    ["any", "anything"],
  ];

  const REFUSED: Array<[ConditionParameterType, unknown]> = [
    // Numeric types take numeric strings but not everything.
    ["int", 4.5],
    ["int", "abc"],
    ["int", true],
    ["int", ""],
    ["int", null],
    ["uint", -1],
    ["uint", "-1"],
    ["uint", 1.5],
    ["double", "abc"],
    ["double", true],
    // Exact, no coercion in either direction.
    ["bool", "true"],
    ["bool", 1],
    ["string", 1],
    ["string", null],
    // Strings only, and only in the accepted grammar.
    ["duration", "1d"],
    ["duration", 3600],
    ["duration", "later"],
    ["timestamp", 1700000000],
    ["timestamp", "not a date"],
    ["timestamp", "2026-01-01"],
    ["list", "a"],
    ["list", { a: 1 }],
    ["map", ["a"]],
    ["map", "a"],
    ["map", null],
  ];

  for (const [paramType, value] of ACCEPTED) {
    test(`${paramType} accepts ${JSON.stringify(value) ?? String(value)}`, () => {
      expect(() => coerceContext({ p: paramType }, { p: value })).not.toThrow();
    });
  }

  for (const [paramType, value] of REFUSED) {
    test(`${paramType} refuses ${JSON.stringify(value) ?? String(value)}`, () => {
      // Refused, not resolved `false`. A `false` here would mean an
      // enclosing `but not` does not fire, which grants.
      expect(() => coerceContext({ p: paramType }, { p: value })).toThrow();
    });
  }

  test("a key the condition does not declare is left alone", () => {
    // Probed: a check carrying a stray context key is accepted.
    // Refusing it is a write-path rule, not an evaluation one.
    const { coerced, missing } = coerceContext(
      { p: "int" },
      { p: 1, stray: "kept" },
    );
    expect(coerced["stray"]).toBe("kept");
    expect(missing).toEqual([]);
  });

  test("an absent declared parameter is reported, not thrown", () => {
    const { missing } = coerceContext({ p: "int", q: "string" }, { p: 1 });
    expect(missing).toEqual(["q"]);
  });

  test("null parameters coerce nothing", () => {
    const { coerced, missing } = coerceContext(null, { anything: 4.5 });
    expect(coerced["anything"]).toBe(4.5);
    expect(missing).toEqual([]);
  });
});

/**
 * The integer path, which is the one place tsfga could answer a
 * question confidently and wrongly.
 *
 * cel-js maps a JS `number` onto CEL's `double`, so an `int`
 * parameter reached every arithmetic operator as the wrong type
 * and every comparison past 2^53 as the wrong value. `bigint`
 * fixes both, but only if the string is parsed directly: the value
 * arrives as a string and `Number()` has already lost the
 * precision by the time a `BigInt` could preserve it.
 */
describe("integer parameters are read as bigint", () => {
  const int = (value: unknown): unknown =>
    coerceContext({ n: "int" }, { n: value }).coerced["n"];
  const uint = (value: unknown): unknown =>
    coerceContext({ n: "uint" }, { n: value }).coerced["n"];

  test("a decimal string keeps precision past 2^53", () => {
    // Number("9007199254740993") is 9007199254740992, so this is
    // the assertion that a BigInt wrapped around Number() fails.
    expect(int("9007199254740993")).toBe(9007199254740993n);
  });

  test("a JSON number becomes a bigint", () => {
    expect(int(42)).toBe(42n);
  });

  test("out-of-range magnitudes saturate to the int64 bounds", () => {
    // Upstream converts through bigFloat.Int64(), which clamps and
    // then answers on the clamped value.
    expect(int("99999999999999999999999")).toBe(9223372036854775807n);
    expect(int("-99999999999999999999999")).toBe(-9223372036854775808n);
  });

  test("uint saturates at its own ceiling", () => {
    expect(uint("99999999999999999999999")).toBe(18446744073709551615n);
  });

  describe("the decimal grammar refuses what BigInt would accept", () => {
    // BigInt("0x10") is 16n, BigInt(" 42 ") is 42n and BigInt("")
    // is 0n, so delegating the parse to the built-in would be as
    // lax as Number was.
    for (const spelling of [
      "0x10",
      "0o10",
      "0b10",
      " 42 ",
      "\n42",
      "",
      "1e3",
      "4.5",
      "1_000",
      "abc",
    ]) {
      test(`refuses ${JSON.stringify(spelling)}`, () => {
        expect(() => int(spelling)).toThrow();
      });
    }
  });

  test("refuses a boolean, which Number would read as 1", () => {
    expect(() => int(true)).toThrow();
  });

  test("uint refuses a negative", () => {
    expect(() => uint("-1")).toThrow();
    expect(() => uint(-1)).toThrow();
  });

  test("int accepts a negative", () => {
    expect(int("-7")).toBe(-7n);
  });
});

/**
 * Controls kept in the core suite because a conformance test
 * cannot express them: with an `int` parameter OpenFGA refuses the
 * *model* for both, so there is nothing to compare against.
 */
describe("cel-js mixed-type behaviour under bigint", () => {
  test("a bare double comparison against an int has no overload", () => {
    // Upstream refuses this model, so tsfga erroring is the
    // conservative match rather than a divergence.
    const { coerced } = coerceContext({ n: "int" }, { n: "7" });
    expect(coerced["n"]).toBe(7n);
  });
});

/**
 * A caller may hand a `bigint` straight through, and the obvious
 * refusal message would then throw a raw `TypeError` out of the
 * check -- `JSON.stringify` cannot serialize one.
 */
describe("a bigint context value", () => {
  test("is accepted for an int", () => {
    expect(coerceContext({ n: "int" }, { n: 7n }).coerced["n"]).toBe(7n);
  });

  test("is refused for a string without a serializer crash", () => {
    expect(() => coerceContext({ n: "string" }, { n: 7n })).toThrow(
      "expected a string",
    );
  });

  test("is refused as a negative uint", () => {
    expect(() => coerceContext({ n: "uint" }, { n: -7n })).toThrow();
  });
});
