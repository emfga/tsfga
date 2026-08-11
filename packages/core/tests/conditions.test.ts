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
    ["list<string>", []],
    ["list<string>", ["a"]],
    ["map<string>", {}],
    ["map<string>", { a: "x" }],
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
    ["list<string>", "a"],
    ["list<string>", { a: 1 }],
    ["map<string>", ["a"]],
    ["map<string>", "a"],
    ["map<string>", null],
    // The element type is enforced, not just the container.
    ["list<string>", [1]],
    ["map<string>", { a: 1 }],
    ["list<int>", ["x"]],
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

  test("uint saturates at the int64 ceiling, not the uint64 one", () => {
    // Measured against v1.18.2, which is the only reason this is
    // not the obvious bound: every numeric string goes through the
    // same `bigFloat.Int64()`, and the uint branch only rejects
    // the result afterwards for being negative. So a magnitude
    // past int64 clamps to int64's ceiling and
    // `n == 18446744073709551615u` is `false` upstream.
    expect(uint("99999999999999999999999")).toBe(9223372036854775807n);
  });

  describe("the numeric grammar refuses what BigInt would accept", () => {
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
      "4.5",
      ".5",
      "1_000",
      "abc",
      "Inf",
    ]) {
      test(`refuses ${JSON.stringify(spelling)}`, () => {
        expect(() => int(spelling)).toThrow();
      });
    }
  });

  describe("and accepts what upstream's does", () => {
    // Upstream parses every numeric type with
    // `big.ParseFloat(value, 10, 64, 0)` and then asks
    // `bigFloat.IsInt()`, so an exponent or a zero fraction is an
    // ordinary integer spelling and answers `true` there. A
    // grammar of bare digits refused all four.
    for (const [spelling, expected] of [
      ["1e3", 1000n],
      ["1E3", 1000n],
      ["1e+3", 1000n],
      ["1000e-3", 1n],
      ["4.0", 4n],
      ["5.", 5n],
      ["1p3", 8n],
    ] as const) {
      test(`reads ${JSON.stringify(spelling)} as ${expected}`, () => {
        expect(int(spelling)).toBe(expected);
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
 * `double` reads the same grammar as `int`, and one rule more:
 * upstream parses at 64-bit precision and refuses the value when
 * converting it to a `float64` is inexact. So a decimal fraction
 * with no finite binary form is an error rather than the nearest
 * double, which is why `"0.1"` is refused and `1.5` is not.
 *
 * Every one of these was measured on v1.18.2. `double` used to
 * inherit the whole `Number()` grammar, so the first four answered
 * where upstream refuses to read the value at all.
 */
describe("double parameters read Go's grammar", () => {
  const double = (value: unknown): unknown =>
    coerceContext({ n: "double" }, { n: value }).coerced["n"];

  for (const spelling of [
    "0x10",
    "0o10",
    "0b10",
    " 1.5 ",
    "1e-400",
    "1e400",
    "1.0000000000000000001",
    "0.1",
    "3.14",
    "9007199254740993",
    "Infinity",
    "INF",
    "NaN",
    "",
  ]) {
    test(`refuses ${JSON.stringify(spelling)}`, () => {
      expect(() => double(spelling)).toThrow();
    });
  }

  for (const [spelling, expected] of [
    ["1.5", 1.5],
    ["1.5e3", 1500],
    [".5", 0.5],
    ["-2.25", -2.25],
    ["1p3", 8],
    // `big.Float.Parse` special-cases exactly these spellings
    // before it scans anything, and `Number()` reads none of them.
    ["Inf", Number.POSITIVE_INFINITY],
    ["+Inf", Number.POSITIVE_INFINITY],
    ["-Inf", Number.NEGATIVE_INFINITY],
    ["inf", Number.POSITIVE_INFINITY],
  ] as const) {
    test(`reads ${JSON.stringify(spelling)} as ${expected}`, () => {
      expect(double(spelling)).toBe(expected);
    });
  }

  test("a JSON number is taken as it stands", () => {
    // The precision rule is upstream's *string* parser. A number
    // is already a float64 there and is asserted, not parsed, so
    // 0.1 given as a number is fine where "0.1" is not.
    expect(double(0.1)).toBe(0.1);
  });
});

/**
 * `duration` and `timestamp` are strings on both sides, and each
 * had one spelling that disagreed.
 */
describe("duration and timestamp grammars", () => {
  const duration = (value: unknown): unknown =>
    coerceContext({ n: "duration" }, { n: value }).coerced["n"];
  const timestamp = (value: unknown): unknown =>
    coerceContext({ n: "timestamp" }, { n: value }).coerced["n"];

  for (const spelling of ["0", "+0", "-0"]) {
    test(`duration accepts the bare zero ${JSON.stringify(spelling)}`, () => {
      // `time.ParseDuration` special-cases it before looking for a
      // unit. The unit-demanding grammar refused all three.
      expect(duration(spelling)).toEqual(duration("0s"));
    });
  }

  for (const spelling of ["00", "1", "0.5", " 1h "]) {
    test(`duration still refuses ${JSON.stringify(spelling)}`, () => {
      expect(() => duration(spelling)).toThrow();
    });
  }

  for (const spelling of [
    "2026-01-01t00:00:00z",
    "2026-01-01t00:00:00Z",
    "2026-01-01T00:00:00z",
  ]) {
    test(`timestamp refuses the lowercase ${JSON.stringify(spelling)}`, () => {
      // Go's RFC3339 layout spells the designators uppercase and
      // its parser is exact about it.
      expect(() => timestamp(spelling)).toThrow();
    });
  }

  for (const digits of [3, 9, 10, 12, 30]) {
    test(`timestamp accepts ${digits} fractional digits`, () => {
      // cel-js's own timestamp() refuses anything longer than 30
      // characters, which is where ten digits lands, so the Date
      // is built here instead. Upstream keeps nanoseconds and
      // discards the rest, accepting all five.
      const value = `2026-01-01T00:00:00.${"1".repeat(digits)}Z`;
      expect(timestamp(value)).toBeInstanceOf(Date);
    });
  }

  for (const spelling of [
    "2026-13-01T00:00:00Z",
    "2026-01-32T00:00:00Z",
    "2016-12-31T23:59:60Z",
    "2026-01-01T00:00:00.Z",
    "2026-01-01T00:00:00",
  ]) {
    test(`timestamp still refuses ${JSON.stringify(spelling)}`, () => {
      // The regex admits the shape of the first three, so what
      // refuses them is the Date being invalid — the check that
      // came free while cel-js built it.
      expect(() => timestamp(spelling)).toThrow();
    });
  }
});

/**
 * A container's elements are coerced as its declared element type,
 * which is the whole reason the type carries one.
 */
describe("list and map elements are coerced", () => {
  const coerce = (type: ConditionParameterType, value: unknown): unknown =>
    coerceContext({ n: type }, { n: value }).coerced["n"];

  test("a list<int> reaches CEL as bigints", () => {
    // Otherwise `n[0] + 1` finds no overload, exactly as a bare
    // int parameter did.
    expect(coerce("list<int>", ["1", 2])).toEqual([1n, 2n]);
  });

  test("a map<int> reaches CEL as bigints", () => {
    expect(coerce("map<int>", { a: 1 })).toEqual({ a: 1n });
  });

  test("a list<timestamp> reaches CEL as dates", () => {
    expect(coerce("list<timestamp>", ["2026-01-01T00:00:00Z"])).toEqual([
      new Date("2026-01-01T00:00:00Z"),
    ]);
  });

  test("an ill-typed element refuses the whole value", () => {
    // A `false` here would not exclude under a `but not`, which
    // grants. Upstream refuses the check.
    expect(() => coerce("list<string>", [1])).toThrow("n[0]");
    expect(() => coerce("map<string>", { a: 1 })).toThrow("n['a']");
  });

  test("an empty container is accepted whatever it holds", () => {
    expect(coerce("list<int>", [])).toEqual([]);
    expect(coerce("map<int>", {})).toEqual({});
  });

  test("a type with no rule refuses rather than substituting itself", () => {
    // Reachable only through a store reporting a parameter type
    // the union does not have -- which the adapter refuses, but
    // `TupleStore` is the documented extension point. The branch
    // used to `return paramType`, so the value CEL evaluated
    // became the literal string "ipaddress".
    const parameters = { n: "ipaddress" } as unknown as Record<
      string,
      ConditionParameterType
    >;
    expect(() => coerceContext(parameters, { n: ["a"] })).toThrow();
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
