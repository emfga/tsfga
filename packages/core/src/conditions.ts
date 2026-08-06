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
 * Coerce a context value to its declared CEL type.
 * Timestamps and durations arrive as strings from JSON storage
 * and must be converted to proper cel-js objects.
 */
function coerceValue(
  value: unknown,
  paramType: ConditionParameterType,
): unknown {
  if (value === null || value === undefined) return value;
  if (paramType === "timestamp" && typeof value === "string") {
    return coerceTimestamp({ val: value });
  }
  if (paramType === "duration" && typeof value === "string") {
    return coerceDuration({ val: value });
  }
  return value;
}

/**
 * Evaluate a tuple's condition. Returns true if:
 * - The tuple has no condition (unconditional access)
 * - The condition evaluates to true
 * Returns false if the condition evaluates to false.
 * Throws ConditionNotFoundError if conditionName references a missing definition.
 * Throws ConditionEvaluationError if a declared parameter is
 * absent from the merged context or CEL evaluation fails —
 * matching OpenFGA's check path, where missing parameters are an
 * evaluation error, not an unmet condition.
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
  const context = { ...requestContext, ...tuple.conditionContext };

  // Every declared parameter must be present in the merged
  // context. OpenFGA's check path rejects evaluation with missing
  // parameters as an evaluation error rather than treating the
  // condition as unmet — an unmet condition would fail open
  // through an exclusion branch ("not excluded" grants).
  const missing: string[] = [];

  // Coerce values based on declared parameter types
  if (condDef.parameters) {
    for (const [key, paramType] of Object.entries(condDef.parameters)) {
      if (key in context) {
        context[key] = coerceValue(context[key], paramType);
      } else {
        missing.push(key);
      }
    }
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
