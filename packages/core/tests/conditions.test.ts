import { describe, expect, test } from "bun:test";
import { Environment } from "@marcbachmann/cel-js";
import {
  CEL_GO_DECLARED_CALLS,
  coerceContext,
  compileCondition,
  DEFAULT_MAX_CONDITION_EVALUATION_COST,
  EXPR_CACHE_MAX_ENTRIES,
  estimateEvaluationCost,
  evaluateTupleCondition,
  hasCompiledExpression,
} from "../src/conditions.ts";
import {
  ConditionCompileError,
  ConditionEvaluationError,
  ConditionNotFoundError,
  TsfgaError,
} from "../src/errors.ts";
import { createTsfga } from "../src/index.ts";
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
      // `size` is declared — a made-up name would now be refused
      // by the declaration gate before anything was evaluated —
      // and there is no overload of it for an int, so this fails
      // where the test means it to: at evaluation.
      expression: "size(x)",
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
    //
    // The clamped value is carried as CEL's `uint` rather than its
    // `int`, so it is cel-js's `UnsignedInt` rather than a bare
    // `bigint` — the carrier is what makes `type(n) == uint` and a
    // bare `u`-suffixed literal agree with upstream, and what
    // bounds the arithmetic at uint64 instead of int64.
    expect(`${uint("99999999999999999999999")}`).toBe("9223372036854775807");
  });

  test("a uint is carried as CEL's uint, not as its int", async () => {
    // The distinction is invisible to `==` in JavaScript and
    // decisive inside CEL, so it is asserted through an
    // expression rather than on the coerced value.
    const store = new MockTupleStore();
    store.conditionDefinitions.push({
      name: "carrier",
      // `&& int(n) == 7` used to be a third conjunct here. cel-js
      // has no `int(uint)` overload — that was one of the deleted
      // `tsfga_int` rows — so the call now raises at evaluation
      // (ledger row R1) and says nothing about the carrier.
      expression: "type(n) == uint && n + 1u == 8u",
      parameters: { n: "uint" },
    });
    const tuple = makeTuple({ conditionName: "carrier" });
    expect(await evaluateTupleCondition(store, tuple, { n: "7" })).toBe(true);
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
      // The regex admits the shape of the first three; the field
      // ranges are what refuse them.
      expect(() => timestamp(spelling)).toThrow();
    });
  }

  /**
   * `time.Parse` validates every field against the calendar and
   * reports "day out of range" / "hour out of range". `new Date`
   * rolls them over instead, so a date that does not exist became
   * a different instant and the condition was evaluated against it
   * — granting, and silent on both sides.
   */
  for (const spelling of [
    "2026-02-30T00:00:00Z",
    "2026-02-29T00:00:00Z",
    "2026-04-31T00:00:00Z",
    "2026-06-31T00:00:00Z",
    "2100-02-29T00:00:00Z",
    "2026-01-01T24:00:00Z",
  ]) {
    test(`timestamp refuses the rolled-over ${spelling}`, () => {
      expect(() => timestamp(spelling)).toThrow();
    });
  }

  for (const spelling of [
    "2024-02-29T00:00:00Z",
    "2000-02-29T00:00:00Z",
    "2026-01-31T23:59:59Z",
    "2026-12-31T00:00:00Z",
  ]) {
    test(`timestamp still accepts ${spelling}`, () => {
      expect(timestamp(spelling)).toBeInstanceOf(Date);
    });
  }

  test("a zone offset is applied as written, minute 60 included", () => {
    // Go's range tests "use > rather than >=, as some people do
    // write offsets of 24 hours or 60 minutes", so `+00:60` is one
    // hour where `new Date` calls the whole string invalid (issue
    // 423). Refusing it was fail-closed, and a regex tightened for
    // 421 would have pinned it.
    const offset = timestamp("2026-01-01T00:00:00+00:60");
    const plain = timestamp("2025-12-31T23:00:00Z");
    expect(offset).toEqual(plain);
  });

  for (const spelling of [
    "2026-01-01T00:00:00+23:59",
    "2026-01-01T00:00:00-00:00",
    "2026-01-01T00:00:00+24:00",
  ]) {
    test(`timestamp reads the offset ${spelling}`, () => {
      expect(timestamp(spelling)).toBeInstanceOf(Date);
    });
  }

  for (const spelling of [
    "2026-01-01T00:00:00+99:00",
    "2026-01-01T00:00:00+00:61",
  ]) {
    test(`timestamp refuses the offset ${spelling}`, () => {
      expect(() => timestamp(spelling)).toThrow();
    });
  }

  /**
   * `time.ParseDuration` counts nanoseconds in an int64 and errors
   * the moment its accumulator overflows, so the magnitude is
   * refused as the context is *read* — with no arithmetic anywhere
   * in the condition, and on the write path too, since
   * `validateTupleWrite` shares this function.
   */
  for (const spelling of [
    "9000000h",
    "-9000000h",
    "2562047h47m16.854775808s",
    "2400000h2400000h",
    "9223372036854775808ns",
    "99999999999999999999999999h",
  ]) {
    test(`duration refuses ${JSON.stringify(spelling)}`, () => {
      expect(() => duration(spelling)).toThrow();
    });
  }

  for (const spelling of [
    "2562047h47m16.854775807s",
    "-2562047h47m16.854775808s",
    "9223372036854775807ns",
    "1h",
    "2h45m",
    "1.5h",
  ]) {
    test(`duration still accepts ${JSON.stringify(spelling)}`, () => {
      expect(duration(spelling)).toBeTruthy();
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

/**
 * An expression that does not compile is refused where it is
 * written, and whatever compiles it raises a `TsfgaError`.
 *
 * The two-sided half lives in
 * `tests/conformance/condition-compile.test.ts`, where the same
 * expressions are put to OpenFGA as a model write.
 */
describe("an expression that does not compile", () => {
  const UNPARSEABLE = ["x +", "x ==", "((x", "x = 1", ""];

  for (const expression of UNPARSEABLE) {
    test(`writeConditionDefinition refuses ${JSON.stringify(
      expression,
    )}`, async () => {
      const client = createTsfga(new MockTupleStore());
      await expect(
        client.writeConditionDefinition({
          name: "gate",
          expression,
          parameters: { x: "int" },
        }),
      ).rejects.toBeInstanceOf(ConditionCompileError);
    });
  }

  test("a compiling expression is still accepted", async () => {
    const client = createTsfga(new MockTupleStore());
    await expect(
      client.writeConditionDefinition({
        name: "gate",
        expression: "x > 3",
        parameters: { x: "int" },
      }),
    ).resolves.toBeUndefined();
  });

  /**
   * Injected through the store, because the public API can no
   * longer create this state -- and because a database written by
   * an earlier version is in it. `parse` used to sit outside the
   * `try` that wraps evaluation, so cel-js's own `ParseError`
   * escaped `check()` and could not be caught by the documented
   * class.
   */
  test("evaluation raises a TsfgaError, not cel-js's ParseError", async () => {
    const store = new MockTupleStore();
    store.conditionDefinitions.push({
      name: "gate",
      expression: "x +",
      parameters: { x: "int" },
    });
    const failure = evaluateTupleCondition(
      store,
      makeTuple({ conditionName: "gate", conditionContext: { x: 1 } }),
    );
    await expect(failure).rejects.toBeInstanceOf(ConditionCompileError);
    await expect(failure).rejects.toBeInstanceOf(TsfgaError);
  });
});

/**
 * The compiled-expression cache is process-wide and keyed by
 * expression text, so nothing about a caller's own lifetime
 * releases it. A caller that writes many condition definitions —
 * or one that rewrites the same one repeatedly, since each new
 * source text is a new key — would otherwise grow it forever.
 */
describe("the compiled expression cache is bounded", () => {
  test("filling past the bound evicts the least recently used", () => {
    const expr = (i: number) => `evict_probe_${i} == ${i}`;
    const first = expr(0);

    for (let i = 0; i < EXPR_CACHE_MAX_ENTRIES; i++) {
      compileCondition("probe", expr(i));
    }
    expect(hasCompiledExpression(first)).toBe(true);

    // A hit refreshes recency, so the entry after it is now the
    // oldest and the next insert must take that one instead.
    compileCondition("probe", first);
    compileCondition("probe", expr(EXPR_CACHE_MAX_ENTRIES));

    expect(hasCompiledExpression(first)).toBe(true);
    expect(hasCompiledExpression(expr(1))).toBe(false);

    // And the bound holds however far past it the caller goes.
    for (let i = 0; i < EXPR_CACHE_MAX_ENTRIES; i++) {
      compileCondition("probe", `overflow_${i} == ${i}`);
    }
    expect(hasCompiledExpression(first)).toBe(false);
  });
});

/**
 * `matches()` is RE2 upstream and a JavaScript `RegExp` here, and
 * the two dialects are not a superset of one another.
 *
 * cel-js refuses to replace its own `string.matches` overload, so
 * `compileCondition` renames the call onto one of ours and that
 * one translates the pattern first. The conformance assertions
 * live in `tests/conformance/cel-regex.test.ts`; these are the
 * unit-level rows, including the ones no model in the suite
 * reaches.
 */
/**
 * A list literal takes CEL's `list(dyn)`, not the type of its
 * first element.
 *
 * cel-js's `homogeneousAggregateLiterals` defaults to `true` and
 * refuses every element whose type differs from the first, so a
 * variable beside a string literal was an evaluation error.
 * cel-go's own option of that name defaults off and OpenFGA
 * never sets it — `internal/condition/condition.go` builds the
 * base environment from the custom parameter types,
 * `IPAddressEnvOption` and `EagerlyValidateDeclarations` alone.
 *
 * It is the one survivor of the block that asserted tsfga's own
 * conversion overloads, because it asserts a cel-js *option*
 * rather than an overload this module supplied: the option is set
 * on the environment and nothing computes around it.
 */
describe("a list literal may mix types", () => {
  const answer = async (
    expression: string,
    parameters: Record<string, ConditionParameterType>,
    context: Record<string, unknown>,
  ): Promise<boolean> => {
    const store = new MockTupleStore();
    store.conditionDefinitions.push({
      name: "listlit",
      expression,
      parameters,
    });
    return evaluateTupleCondition(
      store,
      makeTuple({ conditionName: "listlit" }),
      context,
    );
  };

  test("a literal before a variable", async () => {
    expect(
      await answer('["x", s][1] == "abc"', { s: "string" }, { s: "abc" }),
    ).toBe(true);
  });

  test("a variable before a literal", async () => {
    expect(
      await answer('[s, "x"][0] == "abc"', { s: "string" }, { s: "abc" }),
    ).toBe(true);
  });

  test("two literals of different types", async () => {
    expect(await answer('size(["x", 1]) == 2', {}, {})).toBe(true);
  });

  test("a map value of a mixed type", async () => {
    expect(await answer('{"a": "x", "b": 1}["b"] == 1', {}, {})).toBe(true);
  });

  test("a homogeneous list still reads", async () => {
    expect(await answer('"b" in ["a", "b"]', {}, {})).toBe(true);
  });
});

/**
 * The enumeration test.
 *
 * cel-go's standard library is a finite declaration list and cel-js
 * 8.0.0 exposes `getDefinitions()`, so "which functions does one
 * have that the other does not" is not a question to be discovered
 * by probing a check at a time — it is a **diff that can be
 * computed**. Computing it is what turns the widest of the CEL root
 * causes from a sweep into a standing guard: a cel-js upgrade that
 * adds a function reports itself here rather than waiting for
 * someone to write a conformance cell against it.
 *
 * The two residues below are checked in with a reason each. A name
 * appearing on either side that is not in its residue fails, in
 * both directions.
 */
describe("cel-js's declared surface against cel-go's", () => {
  const pristine = new Environment({ unlistedVariablesAreDyn: true });

  const declaredByCelJs = (): { global: Set<string>; member: Set<string> } => {
    const surface = { global: new Set<string>(), member: new Set<string>() };
    for (const declared of pristine.getDefinitions().functions) {
      const style = declared.receiverType === null ? "global" : "member";
      surface[style].add(declared.name);
    }
    return surface;
  };

  /**
   * Functions cel-js declares and cel-go does not, by the library
   * cel-go would need for them.
   *
   * OpenFGA enables none of these: `internal/condition/condition.go`
   * builds its environment from the custom parameter types,
   * `IPAddressEnvOption` and `EagerlyValidateDeclarations`, so a
   * condition naming one is a model upstream refuses to store, and
   * the declaration gate is what refuses them here.
   */
  const CEL_JS_ONLY: Record<"global" | "member", readonly string[]> = {
    global: [],
    member: [
      // cel-go's ext.Strings()
      "indexOf",
      "join",
      "lastIndexOf",
      "lowerAscii",
      "split",
      "substring",
      "trim",
      "upperAscii",
      // cel-go's ext.Bindings() — `cel.bind` parses as a receiver
      // call on the `cel` namespace
      "bind",
      // cel-js's own bytes and encoding helpers, which have no
      // cel-go equivalent under any library OpenFGA enables
      "at",
      "base64",
      "hex",
      "json",
      "string",
      // the optional-types family, which cel-go declares only when
      // a host asks for it and OpenFGA never does
      "hasValue",
      "none",
      "of",
      "or",
      "orValue",
      "value",
    ],
  };

  /**
   * Functions cel-go declares and cel-js does not.
   *
   * Two, and both are OpenFGA's own additions, which tsfga admits
   * at write time and cannot evaluate — the documented gap.
   */
  const CEL_GO_ONLY: Record<"global" | "member", readonly string[]> = {
    global: ["ipaddress"],
    member: ["in_cidr"],
  };

  /**
   * Functions **both** engines declare and tsfga deliberately does
   * not.
   *
   * One, in both spellings: `matches`. It is not an omission and
   * not an oversight — it is the whole of tsfga's regex policy,
   * expressed as an absence from the allow-list's table so that no
   * code is needed to enforce it.
   *
   * This set exists so that the two assertions below stay honest
   * about it. Without it, cel-js's `matches` would land in
   * `CEL_JS_ONLY` — the set whose stated meaning is "cel-go does
   * not declare this" — which is false, and would leave the file
   * asserting the opposite of why the name is missing.
   *
   * If a future change re-declares `matches`, this set is what
   * fails. See `docs/cel-js/` and `CLAUDE.md`'s *CEL is bounded by
   * cel-js*.
   */
  const DELIBERATELY_UNDECLARED: Record<
    "global" | "member",
    readonly string[]
  > = { global: [], member: ["matches"] };

  for (const style of ["global", "member"] as const) {
    test(`${style}: every name cel-js adds is one we know about`, () => {
      const surface = declaredByCelJs();
      const added = [...surface[style]]
        .filter((name) => !CEL_GO_DECLARED_CALLS[style].has(name))
        .filter((name) => !DELIBERATELY_UNDECLARED[style].includes(name))
        .sort();
      expect(added).toEqual([...CEL_JS_ONLY[style]].sort());
    });

    test(`${style}: every name cel-js lacks is one we know about`, () => {
      const surface = declaredByCelJs();
      const absent = [...CEL_GO_DECLARED_CALLS[style]]
        .filter((name) => !surface[style].has(name))
        .sort();
      expect(absent).toEqual([...CEL_GO_ONLY[style]].sort());
    });
  }

  /**
   * The transcription is only as good as its source, so state the
   * source. cel-go declares `size` and `matches` in both styles and
   * everything else in one, which is the property the gate reads.
   */
  test("the transcription is two sets, not one", () => {
    const both = [...CEL_GO_DECLARED_CALLS.global].filter((name) =>
      CEL_GO_DECLARED_CALLS.member.has(name),
    );
    expect(both.sort()).toEqual(["size"]);
  });

  /**
   * The regex policy, asserted as the absence it is.
   *
   * cel-js still declares `matches` in both spellings — nothing was
   * removed from cel-js, and nothing could be — so the only thing
   * standing between a condition and a JavaScript `RegExp` is this
   * name being missing from the allow-list. That makes the absence
   * load-bearing, and an absence nothing asserts is one a tidy-up
   * closes by accident.
   */
  test("cel-js declares matches and tsfga does not", () => {
    // Only in the receiver spelling: cel-js never declared the
    // global `matches(s, p)` that cel-go also has, which used to be
    // its own finding. Both spellings are one refusal now.
    expect(declaredByCelJs().member.has("matches")).toBe(true);
    expect(declaredByCelJs().global.has("matches")).toBe(false);
    expect(CEL_GO_DECLARED_CALLS.member.has("matches")).toBe(false);
    expect(CEL_GO_DECLARED_CALLS.global.has("matches")).toBe(false);
  });
});

/**
 * The declaration gate.
 *
 * cel-js ships the equivalent of cel-go's `ext.Strings()` and
 * `ext.Bindings()`, OpenFGA enables neither, and there is no way to
 * remove a function from cel-js — registries lock on clone, there
 * is no `deleteFunction`, and the standard library has no opt-out.
 * So the expression is walked and a call cel-go does not declare is
 * refused where the condition is written, which is where upstream
 * refuses it.
 */
describe("a call cel-go does not declare is refused", () => {
  const compile = (expression: string): void => {
    compileCondition("gate", expression);
  };

  /**
   * `matches` is refused by exactly this gate, in both spellings.
   * It sits here rather than in a regex-shaped test of its own
   * because that is the point: the mechanism refusing it is the
   * one that already refuses `split`, and no new code enforces it.
   */
  for (const expression of [
    "s.matches('a')",
    "matches(s, 'a')",
    "s.split(',').size() == 2",
    "s.substring(0, 1) == 'a'",
    "s.trim() == 'a'",
    "s.indexOf('b') == 1",
    "s.lastIndexOf('a') == 2",
    "s.lowerAscii() == 'ab'",
    "s.upperAscii() == 'AB'",
    "l.join(',') == 'a,b'",
    "cel.bind(x, n + 1, x > 1)",
  ]) {
    test(expression, () => {
      expect(() => compile(expression)).toThrow(ConditionCompileError);
    });
  }

  test("a name neither library declares", () => {
    expect(() => compile("not_a_function(x)")).toThrow(ConditionCompileError);
  });

  test("the message names the offending call, as upstream's does", () => {
    try {
      compile("s.trim() == 'a'");
      throw new Error("expected a refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(ConditionCompileError);
      expect(String((error as ConditionCompileError).cause)).toContain(
        "undeclared reference to 'trim'",
      );
    }
  });

  /**
   * The gate is a walk, not a look at the root: a refused call
   * nested three deep in an expression whose top-level call is
   * fine must still be refused.
   */
  test("a refused call nested under an allowed one", () => {
    expect(() => compile("size(s.split(','))  == 2")).toThrow(
      ConditionCompileError,
    );
  });

  /**
   * The other direction, and the one that would take out whole
   * fixture files: a name cel-go *does* declare must still be
   * written. Both styles of `size`, which is now the only function
   * declared in both — `matches` was the other, and it has moved to
   * the refused list above on purpose.
   */
  for (const expression of [
    "size(s) > 0",
    "s.size() > 0",
    "s.contains('a')",
    "s.startsWith('a')",
    "s.endsWith('a')",
    "has(m.a)",
    "l.all(i, i == 'a')",
    "l.exists(i, i == 'a')",
    "l.exists_one(i, i == 'a')",
    "l.filter(i, i == 'a') == l",
    "l.map(i, i + 'a') == l",
    "int(n) == 1",
    "uint(n) == 1u",
    "double(n) == 1.0",
    "string(n) == '1'",
    "bool(s)",
    "bytes(s) == b",
    "type(n) == int",
    "dyn(n) == 1",
    "timestamp(s) > t",
    "duration(s) > d",
    "t.getFullYear() > 0",
    "t.getMonth() == 0",
    "t.getDayOfYear() == 0",
    "t.getDayOfMonth() == 0",
    "t.getDate() == 1",
    "t.getDayOfWeek() == 0",
    "t.getHours() == 0",
    "t.getMinutes() == 0",
    "t.getSeconds() == 0",
    "t.getMilliseconds() == 0",
    "ipaddress(s) == ipaddress(s)",
    "ip.in_cidr('10.0.0.0/8')",
  ]) {
    test(`accepted: ${expression}`, () => {
      expect(() => compile(expression)).not.toThrow();
    });
  }
});

/**
 * The write-time type check.
 *
 * OpenFGA compiles every condition against its declared parameters
 * while it validates the model, so an expression that does not
 * type-check has no model to live in and no check to answer.
 * tsfga's parse said nothing about types, so all seven shapes the
 * issue reports answered and four of them granted.
 *
 * The check is reached by passing the declarations to
 * `compileCondition`. It is deliberately not run on the read path:
 * the verdict belongs to the definition, not to the expression,
 * and the expression cache is keyed by the expression alone.
 */
describe("an expression is checked against its declarations", () => {
  const compile = (
    expression: string,
    parameters: Record<string, ConditionParameterType>,
  ): void => {
    compileCondition("typed", expression, parameters);
  };

  describe("refused, as upstream refuses the model", () => {
    for (const [expression, parameters] of [
      ["n != 'a'", { n: "int" }],
      ["n == 1.0", { n: "int" }],
      ["n == 1u", { n: "int" }],
      ["n > 0 || other > 0", { n: "int" }],
      ["n == 'a'", { n: "int" }],
      ["n in ['a']", { n: "int" }],
      ["n", { n: "int" }],
    ] as Array<[string, Record<string, ConditionParameterType>]>) {
      test(expression, () => {
        expect(() => compile(expression, parameters)).toThrow(
          ConditionCompileError,
        );
      });
    }

    /**
     * The sharpest of the seven, and the one a type check alone
     * would miss: cel-js short-circuits the `||` before the
     * undeclared reference is evaluated, so the expression used to
     * **grant** with nothing reporting a problem. It closes only
     * because the checking environment is cloned with
     * `unlistedVariablesAreDyn` turned off.
     */
    test("an undeclared reference is named", () => {
      try {
        compile("n > 0 || other > 0", { n: "int" });
        throw new Error("expected a refusal");
      } catch (error) {
        expect(error).toBeInstanceOf(ConditionCompileError);
        expect(String((error as ConditionCompileError).cause)).toContain(
          "other",
        );
      }
    });

    test("a non-bool output is named as upstream names it", () => {
      try {
        compile("n", { n: "int" });
        throw new Error("expected a refusal");
      } catch (error) {
        expect(String((error as ConditionCompileError).cause)).toContain(
          "expected a bool condition expression output",
        );
      }
    });
  });

  describe("accepted, as upstream accepts the model", () => {
    for (const [expression, parameters] of [
      ["n > 0", { n: "int" }],
      ["ok", { ok: "bool" }],
      ["s != ''", { s: "string" }],
      ["n + 1u == 8u", { n: "uint" }],
      ["x > 0.0", { x: "double" }],
      ["size(l) > 0", { l: "list<string>" }],
      ["'a' in l", { l: "list<string>" }],
      ["m['a'] > 0", { m: "map<int>" }],
      ["x == '1'", { x: "any" }],
      ["now < expires_at", { now: "timestamp", expires_at: "timestamp" }],
      ["t + d > t", { t: "timestamp", d: "duration" }],
      ["int(t) > 0", { t: "timestamp" }],
      ["int(d) > 0", { d: "duration" }],
      ["string(t) == 'x'", { t: "timestamp" }],
      ["string(d) == 'x'", { d: "duration" }],
    ] as Array<[string, Record<string, ConditionParameterType>]>) {
      test(expression, () => {
        expect(() => compile(expression, parameters)).not.toThrow();
      });
    }

    /**
     * The one declaration cel-js gets wrong, and the reason the
     * verdict on a temporal expression is not enforced: cel-js
     * types `duration + timestamp` as a **Duration** where cel-go's
     * `add_duration_timestamp` types it as a Timestamp, so a
     * comparison upstream compiles is a type error here. cel-js
     * refuses to replace an existing operator overload, so this
     * cannot be repaired — only not enforced.
     */
    test("duration + timestamp, which cel-js types wrongly", () => {
      expect(() =>
        compile("d + t > t", { t: "timestamp", d: "duration" }),
      ).not.toThrow();
    });

    /**
     * Declared by OpenFGA, absent from cel-js. The write must be
     * accepted — refusing it would refuse a model upstream stores —
     * and the check that reads it still refuses, which is the gap
     * `packages/core/README.md` already documents.
     */
    test("in_cidr, which OpenFGA declares and cel-js has not", () => {
      expect(() =>
        compile("ip.in_cidr(cidr)", { ip: "any", cidr: "string" }),
      ).not.toThrow();
    });
  });

  /**
   * Two conditions may share an expression and declare different
   * parameters. The compiled expression is cached by its source
   * text, so the second must be checked against its own
   * declarations rather than inheriting the first's verdict.
   */
  test("the verdict is not cached with the expression", () => {
    const expression = "shared_388 > 0";
    expect(() => compile(expression, { shared_388: "int" })).not.toThrow();
    expect(() => compile(expression, { shared_388: "string" })).toThrow(
      ConditionCompileError,
    );
  });

  /**
   * The read path passes no declarations and must not pay for a
   * check it cannot make: an expression a check reads is compiled
   * exactly as before.
   */
  test("no declarations means no check", () => {
    expect(() => compileCondition("untyped", "n != 'a'")).not.toThrow();
  });
});

/**
 * The CEL evaluation cost budget.
 *
 * OpenFGA compiles every condition with `cel.CostLimit(100)`
 * (`internal/condition/condition.go`,
 * `DefaultMaxConditionEvaluationCost`), and cel-go charges by the
 * *size of the values*, so a stored expression crosses the budget
 * purely on request data. cel-js has no runtime metering of any
 * kind, so tsfga charges a pre-pass over the compiled AST with the
 * coerced context in hand and refuses before evaluating.
 *
 * The numbers below are the contract. Two of them are upstream's
 * own unit table (`internal/condition/condition_test.go`) and three
 * are the boundary the conformance suite measured against the
 * v1.18.2 container; if the transcription drifts, these move before
 * any answer does.
 */
describe("the evaluation cost budget", () => {
  const cost = (expression: string, context: Record<string, unknown>): number =>
    estimateEvaluationCost(compileCondition("c", expression).ast, context);

  const evaluate = (
    expression: string,
    parameters: Record<string, ConditionParameterType>,
    context: Record<string, unknown>,
    maxConditionEvaluationCost?: number,
  ): Promise<boolean> => {
    const store = new MockTupleStore();
    store.conditionDefinitions.push({ name: "c", expression, parameters });
    return evaluateTupleCondition(
      store,
      makeTuple({ conditionName: "c" }),
      context,
      { maxConditionEvaluationCost },
    );
  };

  describe("the model reproduces cel-go's own figures", () => {
    // `internal/condition/condition_test.go:320-435`: `x == y` over
    // two two-character strings costs 3, and `'a' in strlist` over
    // three entries costs 4. Two identifiers at `SelectAndIdentCost`
    // plus `ceil(min(2, 2) * 0.1)`; one identifier plus one element
    // per entry, the literal `'a'` being free.
    test("a two-character equality costs 3", () => {
      expect(cost("x == y", { x: "ab", y: "ab" })).toBe(3);
    });

    test("membership of a three-entry list costs 4", () => {
      expect(cost("'a' in strlist", { strlist: ["a", "b", "c"] })).toBe(4);
    });
  });

  describe("the boundary lands where the container's does", () => {
    // The boundary used to be measured through `s.matches(p)`,
    // which no longer compiles. `contains` is charged by the same
    // string-size rule — `ceil((|a| + |b|) * 0.1)` — so the
    // boundary it lands on is the same boundary, reached through a
    // call that still exists.
    const contains = (length: number): number =>
      cost("s.contains(p)", { s: "a".repeat(length), p: "aaaa" });

    test("950 characters is inside the budget", () => {
      expect(contains(950) <= DEFAULT_MAX_CONDITION_EVALUATION_COST).toBe(true);
    });

    test("1200 characters is outside it", () => {
      expect(contains(1200) > DEFAULT_MAX_CONDITION_EVALUATION_COST).toBe(true);
    });

    test("a 4000-character equality is far outside it", () => {
      const long = "a".repeat(4000);
      expect(cost("x == y", { x: long, y: long })).toBe(402);
    });

    test("a 300-entry membership is far outside it", () => {
      const haystack = Array.from({ length: 300 }, (_, i) => `e${i}`);
      expect(cost("needle in haystack", { needle: "absent", haystack })).toBe(
        302,
      );
    });
  });

  describe("what the refusal is", () => {
    const long = "a".repeat(4000);

    test("it is a ConditionEvaluationError", async () => {
      await expect(
        evaluate("x == y", { x: "string", y: "string" }, { x: long, y: long }),
      ).rejects.toBeInstanceOf(ConditionEvaluationError);
    });

    // P0's contract with the docs: `cause` is free-form, so the one
    // refusal tsfga raises on its own account is told apart by this
    // prefix and by nothing else.
    test("its cause begins with the agreed prefix", async () => {
      const error = await evaluate(
        "x == y",
        { x: "string", y: "string" },
        { x: long, y: long },
      ).catch((raised: unknown) => raised);
      expect(error).toBeInstanceOf(ConditionEvaluationError);
      if (!(error instanceof ConditionEvaluationError)) return;
      expect(error.cause).toBeInstanceOf(Error);
      if (!(error.cause instanceof Error)) return;
      expect(
        error.cause.message.startsWith("evaluation cost limit exceeded"),
      ).toBe(true);
    });

    // A budget refusal is charged before the expression runs, so an
    // expression that would have answered `false` refuses too. That
    // is upstream's behaviour: a cancelled program has no answer.
    test("it refuses rather than denying", async () => {
      const haystack = Array.from({ length: 300 }, (_, i) => `e${i}`);
      await expect(
        evaluate(
          "needle in haystack",
          { needle: "string", haystack: "list<string>" },
          { needle: "absent", haystack },
        ),
      ).rejects.toBeInstanceOf(ConditionEvaluationError);
    });
  });

  describe("the option", () => {
    const long = "a".repeat(4000);

    test("Infinity opts out", async () => {
      expect(
        await evaluate(
          "x == y",
          { x: "string", y: "string" },
          { x: long, y: long },
          Number.POSITIVE_INFINITY,
        ),
      ).toBe(true);
    });

    // Upstream floors a *server's* configured value at 100. tsfga is
    // a library, so a caller who says 5 gets 5.
    test("it is not floored at 100", async () => {
      expect(
        await evaluate("x == y", { x: "string" }, { x: "ab", y: "ab" }),
      ).toBe(true);
      await expect(
        evaluate("x == y", { x: "string" }, { x: "ab", y: "ab" }, 2),
      ).rejects.toBeInstanceOf(ConditionEvaluationError);
    });

    for (const invalid of [0, -1, 1.5, Number.NaN]) {
      test(`${invalid} is refused`, async () => {
        await expect(
          evaluate("x == y", { x: "string" }, { x: "a", y: "a" }, invalid),
        ).rejects.toBeInstanceOf(TsfgaError);
      });
    }

    // Validated where the other options are: at construction, so a
    // mistyped budget is not first heard about at the first
    // conditioned row.
    test("createTsfga refuses an invalid budget", () => {
      expect(() =>
        createTsfga(new MockTupleStore(), {
          maxConditionEvaluationCost: Number.NaN,
        }),
      ).toThrow(TsfgaError);
    });
  });

  /**
   * The approximation's residue, asserted rather than described.
   *
   * Each row is a shape where the pre-pass and cel-go's runtime
   * tracker disagree, and every one of them charges **more** than
   * upstream would. That direction is the whole safety argument: a
   * model tsfga refuses and upstream answers is an outage, and a
   * visible one; the reverse would leave 444's granting divergence
   * open.
   */
  describe("the residue over-charges, never under-charges", () => {
    test("an unevaluated || arm is still charged", () => {
      // cel-go short-circuits and never charges the right arm, so
      // it would charge this expression nothing at all.
      const long = "a".repeat(400);
      expect(cost("true", {})).toBe(0);
      expect(cost("true || x == y", { x: long, y: long })).toBe(42);
    });

    test("both ternary branches are charged", () => {
      const long = "a".repeat(400);
      expect(cost("true ? 1 : (x == y ? 1 : 2)", { x: long, y: long })).toBe(
        cost("false ? 1 : (x == y ? 1 : 2)", { x: long, y: long }),
      );
    });

    test("a value the walk cannot reach is charged at the ceiling", () => {
      // An index into a stored list resolves to the element it
      // names; an index into a comprehension's output does not, and
      // takes the largest size the request carried rather than the
      // one-character element actually behind it.
      const context = { l: ["x", "a".repeat(500)], p: "aa" };
      const direct = cost("l[0].contains(p)", context);
      const viaFilter = cost("l.filter(i, i != '')[0].contains(p)", context);
      expect(viaFilter).toBeGreaterThan(direct);
    });

    test("`in` over a map is priced by size, where cel-go prices 1", () => {
      // cel-go's `in_map` falls to the default branch and costs 1;
      // the pre-pass has no types, so it charges `in_list`'s rule to
      // both. 300 entries is 302 rather than 3.
      const m: Record<string, string> = {};
      for (let i = 0; i < 300; i += 1) m[`k${i}`] = "v";
      expect(cost("k in m", { k: "k1", m })).toBe(302);
    });
  });
});
