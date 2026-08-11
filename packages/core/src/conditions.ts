import { type ParseResult, parse } from "@marcbachmann/cel-js";
import { ConditionEvaluationError, ConditionNotFoundError } from "./errors.ts";
import type { TupleStore } from "./store-interface.ts";
import type {
  ConditionParameterScalarType,
  ConditionParameterType,
  Tuple,
} from "./types.ts";

/**
 * Cache compiled CEL expressions keyed by the expression source
 * text. Content keying makes staleness impossible: redefining a
 * condition with a new expression parses (and caches) the new
 * source, while identical expressions share one compiled entry —
 * even across condition names and stores.
 */
const exprCache = new Map<string, ParseResult>();

/** Pre-compiled coercion helper for duration strings */
const coerceDuration = parse("duration(val)");

/**
 * Read a context value as its declared parameter type, or say why
 * it cannot be.
 *
 * A port of OpenFGA's `internal/condition/types/converters.go`,
 * because a `typeof` check diverges from it on six of the cases
 * probed against v1.18.2:
 *
 * | value | declared | verdict |
 * |---|---|---|
 * | `42`, `"42"` | int | accepted |
 * | `4.5`, `"abc"`, `true` | int | refused |
 * | `-1`, `"-1"` | uint | refused |
 * | `"7"` | uint | accepted |
 * | `"1.5"`, `1.5` | double | accepted |
 * | `"2026-01-01T00:00:00Z"` | timestamp | accepted |
 * | `1700000000`, `"not a date"` | timestamp | refused |
 * | `"1h"`, `"1.5h"`, `"2h45m"` | duration | accepted |
 * | `"1d"`, `3600` | duration | refused |
 * | `"true"` | bool | refused |
 * | `1` | string | refused |
 * | `[1]` | list&lt;string&gt; | refused |
 *
 * The shape of it: the **numeric** types accept numeric strings,
 * because JSON has no integer type and upstream parses rather than
 * asserts — but the grammar is Go's, so it is neither `Number`'s
 * nor `BigInt`'s. `duration` and `timestamp` accept **only**
 * strings. A container coerces every element as its declared
 * element type. Everything else is exact.
 *
 * Refusing rather than answering `false` is the point. On the
 * subtract side of an `excludedBy` a `false` condition means the
 * exclusion does not fire, so a mistyped context value would
 * *grant*. That is the same hazard this file already documents for
 * *missing* parameters, which was closed while ill-typed ones were
 * left open.
 *
 * Throws a plain `Error`; callers wrap it in whichever of
 * `ConditionEvaluationError` or `InvalidConditionalTupleError`
 * fits their path.
 */

/** Go's `time.ParseDuration` grammar: `-1.5h`, `2h45m`, `300ms`. */
const DURATION =
  /^[+-]?(\d+(\.\d*)?|\.\d+)(ns|us|\u00b5s|\u03bcs|ms|s|m|h)([+-]?(\d+(\.\d*)?|\.\d+)(ns|us|\u00b5s|\u03bcs|ms|s|m|h))*$/;

/**
 * The one unitless duration Go accepts.
 *
 * `time.ParseDuration` special-cases a bare zero before it looks
 * for a unit, so `"0"`, `"+0"` and `"-0"` parse while `"00"` and
 * `"1"` do not.
 */
const DURATION_ZERO = /^[+-]?0$/;

/**
 * RFC 3339, as `time.Parse(time.RFC3339, …)` accepts it.
 *
 * The designators are uppercase because Go's RFC3339 layout spells
 * them that way and its parser is exact about it: upstream refuses
 * `2026-01-01t00:00:00z` in all three combinations of case, where
 * this regex used to admit them and answer.
 *
 * The fractional part is unbounded on purpose. Upstream accepts 3,
 * 9, 12 and 30 digits alike — it keeps nanoseconds and discards the
 * rest — so the digits are not what this has to gate.
 */
const RFC3339 =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/**
 * The range CEL gives a timestamp: year 1 through year 9999.
 *
 * cel-js applies the same bounds inside `timestamp()`; they are
 * restated here because the coercion no longer goes through it.
 */
const TIMESTAMP_MIN = -62135596800000;
const TIMESTAMP_MAX = 253402300799999;

/**
 * A context value as text, for a refusal message.
 *
 * `JSON.stringify` throws on a `bigint`, and a caller may hand one
 * straight through -- so the obvious spelling turns a refusal that
 * should be a `TsfgaError` into a raw `TypeError` escaping the
 * check.
 */
function describeValue(value: unknown): string {
  if (typeof value === "bigint") return `${value}n`;
  return JSON.stringify(value) ?? typeof value;
}

/**
 * The numeric string grammar, which is Go's and not JavaScript's.
 *
 * Every numeric type — `int`, `uint` and `double` alike — reaches
 * upstream through `big.ParseFloat(value, 10, 64, 0)`. Base 10 is
 * given explicitly, so none of the prefixed literal forms
 * `Number()` accepts are: `0x10`, `0o10`, `0b10` and `1_000` are
 * all refused, as is any surrounding whitespace and the empty
 * string. What it does accept is a decimal mantissa with an
 * optional exponent — `1e3`, `1E3`, `1e+3`, `1000e-3`, `.5` and
 * `5.` all parse — where `Number()` and `BigInt()` between them
 * agree on none of the boundary.
 *
 * `p` is Go's binary exponent: `1p3` is 8.
 */
const GO_NUMERIC =
  /^([+-])?(\d+(?:\.\d*)?|\.\d+)(?:[eE]([+-]?\d+)|[pP]([+-]?\d+))?$/;

/**
 * The infinities, which `big.Float.Parse` special-cases before it
 * scans anything: exactly `Inf` or `inf`, optionally signed.
 * `INF`, `Infinity` and `NaN` are refused, upstream and here.
 */
const GO_INFINITY = /^([+-])?(?:Inf|inf)$/;

/** Go's int64, which is what upstream stores an `int` in. */
const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;

/**
 * How far the exponents are followed exactly.
 *
 * Past this the value is many orders of magnitude outside both
 * `float64` and `int64`, and the only cost of following it would
 * be raising 5 to an attacker-chosen power. Refusing matches the
 * behaviour these spellings already had.
 */
const MAX_EXPONENT_10 = 4000;
const MAX_EXPONENT_2 = 16000;

/** A parsed numeric string: `digits × 10^exp10 × 2^exp2`. */
interface ParsedNumber {
  negative: boolean;
  digits: bigint;
  exp10: number;
  exp2: number;
}

function parseGoNumeric(value: string): ParsedNumber | null {
  const match = GO_NUMERIC.exec(value);
  if (!match) return null;
  const [, sign, mantissa, decimalExponent, binaryExponent] = match;
  if (mantissa === undefined) return null;

  const point = mantissa.indexOf(".");
  const digits =
    point === -1
      ? mantissa
      : mantissa.slice(0, point) + mantissa.slice(point + 1);
  const fraction = point === -1 ? 0 : mantissa.length - point - 1;

  return {
    negative: sign === "-",
    digits: BigInt(digits),
    exp10: Number(decimalExponent ?? 0) - fraction,
    exp2: Number(binaryExponent ?? 0),
  };
}

/**
 * The same value written as `significand × 2^exp2` with an odd
 * significand, or `null` when it cannot be — `0.1` is a decimal
 * fraction with no finite binary form, and no rounding here would
 * make it one.
 *
 * That is the whole of upstream's precision rule. It parses at
 * 64-bit precision and then converts, refusing when the conversion
 * is inexact, so a `double` given `"0.1"` or
 * `"1.0000000000000000001"` is an error rather than the nearest
 * `float64`.
 */
function toDyadic(
  parsed: ParsedNumber,
): { significand: bigint; exp2: number } | null {
  if (parsed.digits === 0n) return { significand: 0n, exp2: 0 };
  if (Math.abs(parsed.exp10) > MAX_EXPONENT_10) return null;
  if (Math.abs(parsed.exp2) > MAX_EXPONENT_2) return null;

  // 10^n is 2^n·5^n, so the power of ten splits into a power of
  // two the binary exponent absorbs and a power of five that must
  // divide the digits exactly or the value is not dyadic.
  let significand = parsed.digits;
  let exp2 = parsed.exp2 + parsed.exp10;
  if (parsed.exp10 > 0) {
    significand *= 5n ** BigInt(parsed.exp10);
  } else if (parsed.exp10 < 0) {
    const fifths = 5n ** BigInt(-parsed.exp10);
    if (significand % fifths !== 0n) return null;
    significand /= fifths;
  }

  while (significand % 2n === 0n) {
    significand >>= 1n;
    exp2 += 1;
  }
  return { significand, exp2 };
}

/** How many bits the significand needs. */
function bitLength(value: bigint): number {
  return value === 0n ? 0 : value.toString(2).length;
}

/**
 * An integer context value as a `bigint`, or `null`.
 *
 * `bigint` rather than `number` because cel-js maps a JS `number`
 * onto CEL's `double`, so every arithmetic operator against an
 * `int` literal failed to find an overload, and any magnitude past
 * 2^53 compared wrong without erroring. The value usually arrives
 * as a string, so it is parsed directly: routing it through
 * `Number` first loses the precision before a `BigInt` could
 * preserve it.
 *
 * A string is an integer when its dyadic form has no negative
 * exponent left, which is how `"4.0"` and `"1e3"` are integers and
 * `"4.5"` and `".5"` are not — upstream asks `bigFloat.IsInt()`
 * and draws the line in the same place.
 */
function asBigInt(value: unknown, allowNegative: boolean): bigint | null {
  // Deliberate: upstream's type assertion refuses `true` for an
  // int, where a bare `Number(true)` would happily produce `1`.
  if (typeof value === "boolean") return null;
  if (typeof value === "bigint") {
    return allowNegative || value >= 0n ? value : null;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || !Number.isInteger(value)) return null;
    const parsed = BigInt(value);
    return allowNegative || parsed >= 0n ? parsed : null;
  }
  if (typeof value !== "string") return null;

  const parsed = parseGoNumeric(value);
  if (!parsed) return null;
  const dyadic = toDyadic(parsed);
  if (!dyadic || dyadic.exp2 < 0) return null;

  const magnitude = dyadic.significand << BigInt(dyadic.exp2);
  const signed = parsed.negative ? -magnitude : magnitude;
  return allowNegative || signed >= 0n ? signed : null;
}

/**
 * Saturate to the range the declared type can hold.
 *
 * Upstream converts through `bigFloat.Int64()`, which clamps
 * rather than failing, and then answers on the clamped value. An
 * exact `BigInt` would answer the opposite boolean for a magnitude
 * outside the range, so the clamp is part of matching it.
 *
 * A `uint` clamps at the **int64** ceiling, not the uint64 one:
 * upstream reads every numeric string through the same
 * `bigFloat.Int64()` and only then rejects a negative, so
 * `n == 9223372036854775807u` holds for a value far past it and
 * `n == 18446744073709551615u` does not.
 */
function saturate(value: bigint, min: bigint): bigint {
  if (value < min) return min;
  if (value > INT64_MAX) return INT64_MAX;
  return value;
}

/**
 * A double context value as a `number`, or `null`.
 *
 * A JSON number is taken as it stands — it is already a `float64`
 * and upstream asserts rather than parses it. A string goes
 * through Go's grammar and Go's precision rule, so the ways
 * `Number()` is laxer than `big.ParseFloat` are all closed: the
 * prefixed literal forms, surrounding whitespace, an inexact
 * decimal, and a magnitude that overflows or underflows the type.
 * The infinities go the other way — upstream reads `Inf` and
 * `Number()` does not.
 */
function asNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;

  const infinite = GO_INFINITY.exec(value);
  if (infinite) {
    return infinite[1] === "-"
      ? Number.NEGATIVE_INFINITY
      : Number.POSITIVE_INFINITY;
  }

  const parsed = parseGoNumeric(value);
  if (!parsed) return null;
  const dyadic = toDyadic(parsed);
  if (!dyadic) return null;
  if (dyadic.significand === 0n) return parsed.negative ? -0 : 0;

  // The exponent range of a float64: the largest is just under
  // 2^1024 and the smallest subnormal is 2^-1074.
  const exponent = dyadic.exp2 + bitLength(dyadic.significand) - 1;
  if (bitLength(dyadic.significand) > 53) return null;
  if (exponent > 1023 || dyadic.exp2 < -1074) return null;

  const magnitude = Number(dyadic.significand) * 2 ** dyadic.exp2;
  return parsed.negative ? -magnitude : magnitude;
}

/**
 * A timestamp string as a `Date`, or `null`.
 *
 * Built here rather than through cel-js's `timestamp()`, which
 * refuses any spelling longer than 30 characters — ten fractional
 * digits are enough — where upstream keeps nanoseconds and
 * discards the rest of whatever it is given. The bounds and the
 * `Date` itself are what cel-js would have produced.
 */
function asTimestamp(value: string): Date | null {
  const date = new Date(value);
  const time = date.getTime();
  if (Number.isNaN(time)) return null;
  if (time < TIMESTAMP_MIN || time > TIMESTAMP_MAX) return null;
  return date;
}

const SCALAR_PARAMETER_TYPES: ReadonlySet<string> = new Set([
  "string",
  "int",
  "uint",
  "bool",
  "double",
  "duration",
  "timestamp",
  "any",
]);

function isScalarParameterType(
  value: string,
): value is ConditionParameterScalarType {
  return SCALAR_PARAMETER_TYPES.has(value);
}

const CONTAINER_PARAMETER_TYPE = /^(list|map)<(.+)>$/;

/**
 * A declared `list<…>` or `map<…>` taken apart, or `null` for a
 * type that holds nothing.
 */
function containerOf(
  paramType: ConditionParameterType,
): { kind: "list" | "map"; element: ConditionParameterScalarType } | null {
  const match = CONTAINER_PARAMETER_TYPE.exec(paramType);
  if (!match) return null;
  const [, kind, element] = match;
  if (element === undefined || !isScalarParameterType(element)) return null;
  return { kind: kind === "map" ? "map" : "list", element };
}

function coerceValue(
  parameter: string,
  value: unknown,
  paramType: ConditionParameterType,
): unknown {
  // Explicitly typed so TypeScript treats it as never-returning
  // and narrows after each call.
  const refuse: (expected: string) => never = (expected) => {
    throw new Error(
      `parameter '${parameter}' expected ${expected}, but found ` +
        `${describeValue(value)}`,
    );
  };

  // Containers first, because their element type decides the rest
  // and the scalar switch has nothing to say about them. Every
  // element is coerced as its declared type, which is what makes
  // `list<string>` given `[1]` an error rather than a list CEL
  // will happily compare a number out of.
  const container = containerOf(paramType);
  if (container) {
    if (container.kind === "list") {
      if (!Array.isArray(value)) refuse("a list");
      return value.map((item, index) =>
        coerceValue(`${parameter}[${index}]`, item, container.element),
      );
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      refuse("a map");
    }
    const coerced: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      coerced[key] = coerceValue(
        `${parameter}['${key}']`,
        item,
        container.element,
      );
    }
    return coerced;
  }

  switch (paramType) {
    case "any":
      return value;

    case "bool":
      if (typeof value !== "boolean") refuse("a bool");
      return value;

    case "string":
      if (typeof value !== "string") refuse("a string");
      return value;

    case "int":
    case "uint": {
      const signed = paramType === "int";
      const parsed = asBigInt(value, signed);
      if (parsed === null) {
        // A negative given for a uint is worth saying plainly; it
        // is the one rejection a caller is likely to have meant.
        if (paramType === "uint" && asBigInt(value, true) !== null) {
          refuse("a uint value, but found a negative");
        }
        refuse(`an ${paramType} value`);
      }
      return saturate(parsed, signed ? INT64_MIN : 0n);
    }

    case "double": {
      const numeric = asNumber(value);
      if (numeric === null) refuse("a double value");
      return numeric;
    }

    case "duration": {
      // String only. `3600` is refused rather than read as
      // seconds — upstream asserts the string before parsing.
      if (typeof value !== "string") refuse("a duration string");
      // Go's parser takes a bare zero and nothing else unitless,
      // and cel-js's `duration()` takes no such thing, so the one
      // spelling it declines is written out.
      if (DURATION_ZERO.test(value)) return coerceDuration({ val: "0s" });
      if (!DURATION.test(value)) refuse("a valid duration string");
      return coerceDuration({ val: value });
    }

    case "timestamp": {
      if (typeof value !== "string") refuse("an RFC 3339 timestamp string");
      if (!RFC3339.test(value)) refuse("a valid RFC 3339 timestamp string");
      const timestamp = asTimestamp(value);
      if (timestamp === null) refuse("a valid RFC 3339 timestamp string");
      return timestamp;
    }

    default:
      // A parameter type with no rule of its own must not reach
      // CEL. This branch returned `paramType` — substituting the
      // type's own name for the caller's value, silently — which
      // is the shape a new union member would have fallen into.
      refuse("a value of a declared parameter type");
  }
}

/**
 * Coerce every declared parameter present in `context`, and report
 * the ones that are absent.
 *
 * Only the keys actually present are read. A context key the
 * condition does not declare is *not* an error here — probed
 * against v1.18.2, a check carrying a stray key is accepted. That
 * refusal belongs to the write path.
 *
 * Shared with `validateTupleWrite` so a tuple cannot be writable
 * but unevaluable: if the two used different rules, a value the
 * write path accepted could raise at every check that read it.
 */
export function coerceContext(
  parameters: Record<string, ConditionParameterType> | null,
  context: Record<string, unknown>,
): { coerced: Record<string, unknown>; missing: string[] } {
  const coerced = { ...context };
  const missing: string[] = [];
  if (!parameters) return { coerced, missing };

  for (const [key, paramType] of Object.entries(parameters)) {
    if (key in coerced) {
      coerced[key] = coerceValue(key, coerced[key], paramType);
    } else {
      missing.push(key);
    }
  }
  return { coerced, missing };
}

/**
 * Evaluate a tuple's condition. Returns true if:
 * - The tuple has no condition (unconditional access)
 * - The condition evaluates to true
 * Returns false if the condition evaluates to false.
 * Throws ConditionNotFoundError if conditionName references a missing definition.
 * Throws ConditionEvaluationError if a declared parameter is
 * absent from the merged context, if a present one cannot be read
 * as its declared type, or if CEL evaluation fails — matching
 * OpenFGA's check path, where all three are evaluation errors
 * rather than an unmet condition.
 */
export async function evaluateTupleCondition(
  store: TupleStore,
  tuple: Tuple,
  requestContext?: Record<string, unknown>,
): Promise<boolean> {
  if (!tuple.conditionName) {
    return true;
  }

  const condDef = await store.findConditionDefinition(tuple.conditionName);
  if (!condDef) {
    throw new ConditionNotFoundError(tuple.conditionName);
  }

  // Merge contexts: tuple context wins over request context
  const merged = { ...requestContext, ...tuple.conditionContext };

  // Every declared parameter must be present in the merged
  // context, and every present one must be readable as its
  // declared type. OpenFGA treats both as evaluation errors rather
  // than as an unmet condition — an unmet condition would fail
  // open through an exclusion branch ("not excluded" grants).
  let context: Record<string, unknown>;
  let missing: string[];
  try {
    ({ coerced: context, missing } = coerceContext(condDef.parameters, merged));
  } catch (error) {
    throw new ConditionEvaluationError(condDef.name, error);
  }
  if (missing.length > 0) {
    throw new ConditionEvaluationError(
      condDef.name,
      new Error(`missing context parameters: ${missing.join(", ")}`),
    );
  }

  let compiled = exprCache.get(condDef.expression);
  if (!compiled) {
    compiled = parse(condDef.expression);
    exprCache.set(condDef.expression, compiled);
  }

  try {
    const result = compiled(context);
    return result === true;
  } catch (error) {
    throw new ConditionEvaluationError(condDef.name, error);
  }
}
