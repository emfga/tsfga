import { type ParseResult, parse } from "@marcbachmann/cel-js";
import { ConditionEvaluationError, ConditionNotFoundError } from "./errors.ts";
import type { TupleStore } from "./store-interface.ts";
import type { ConditionParameterType, Tuple } from "./types.ts";

/**
 * Cache compiled CEL expressions keyed by the expression source
 * text. Content keying makes staleness impossible: redefining a
 * condition with a new expression parses (and caches) the new
 * source, while identical expressions share one compiled entry —
 * even across condition names and stores.
 */
const exprCache = new Map<string, ParseResult>();

/** Pre-compiled coercion helpers for timestamp/duration strings */
const coerceTimestamp = parse("timestamp(val)");
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
 *
 * The shape of it: the **numeric** types accept numeric strings,
 * because JSON has no integer type and upstream parses rather than
 * asserts. `duration` and `timestamp` accept **only** strings.
 * Everything else is exact.
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

/** RFC 3339, as `time.Parse(time.RFC3339, …)` accepts it. */
const RFC3339 =
  /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/;

/**
 * A JSON number or numeric string as a finite number, or `null`.
 *
 * Booleans are excluded deliberately: upstream's type assertion
 * refuses `true` for an int, where a bare `Number(true)` would
 * happily produce `1`.
 */
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
 * A decimal integer, and nothing else.
 *
 * `BigInt`'s own string grammar is as lax as `Number`'s in exactly
 * the ways that matter here: `BigInt("0x10")` is `16n`,
 * `BigInt(" 42 ")` is `42n`, and `BigInt("")` is `0n`. Upstream
 * refuses all three, so the parse cannot be delegated to either
 * built-in. Owned here and generalised to the remaining numeric
 * types in the commit that follows.
 */
const DECIMAL_INTEGER = /^[+-]?[0-9]+$/;

/** Go's int64, which is what upstream stores an `int` in. */
const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;
/** Go's uint64. */
const UINT64_MAX = 2n ** 64n - 1n;

/**
 * Saturate to the range the declared type can hold.
 *
 * Upstream converts through `bigFloat.Int64()`, which clamps
 * rather than failing, and then answers on the clamped value. An
 * exact `BigInt` would answer the opposite boolean for a magnitude
 * outside the range, so the clamp is part of matching it.
 */
function saturate(value: bigint, min: bigint, max: bigint): bigint {
  if (value < min) return min;
  if (value > max) return max;
  return value;
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
 */
function asBigInt(value: unknown, allowNegative: boolean): bigint | null {
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
  if (!DECIMAL_INTEGER.test(value)) return null;
  const parsed = BigInt(value);
  return allowNegative || parsed >= 0n ? parsed : null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  // `Number("")` and `Number(" ")` are `0`; upstream's parser
  // rejects both.
  if (value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
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
      return signed
        ? saturate(parsed, INT64_MIN, INT64_MAX)
        : saturate(parsed, 0n, UINT64_MAX);
    }

    case "double": {
      const numeric = asNumber(value);
      if (numeric === null) refuse("a double value");
      return numeric;
    }

    case "duration":
      // String only. `3600` is refused rather than read as
      // seconds — upstream asserts the string before parsing.
      if (typeof value !== "string") refuse("a duration string");
      if (!DURATION.test(value)) refuse("a valid duration string");
      return coerceDuration({ val: value });

    case "timestamp":
      if (typeof value !== "string") refuse("an RFC 3339 timestamp string");
      if (!RFC3339.test(value)) refuse("a valid RFC 3339 timestamp string");
      return coerceTimestamp({ val: value });

    case "list":
      if (!Array.isArray(value)) refuse("a list");
      return value;

    case "map":
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        refuse("a map");
      }
      return value;

    default:
      // `paramType` is `never` here; a new member of the union
      // must decide its own rule rather than falling through
      // unvalidated.
      return paramType;
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
