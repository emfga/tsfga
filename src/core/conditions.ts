import { type ParseResult, parse } from "@marcbachmann/cel-js";
import {
  ConditionEvaluationError,
  ConditionNotFoundError,
} from "src/core/errors.ts";
import type { ConditionParameterType, Tuple } from "src/core/types.ts";
import type { TupleStore } from "src/store/interface.ts";

/** Cache compiled CEL expressions by condition name */
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
  if (value == null) return value;
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
 * Throws ConditionEvaluationError if CEL evaluation fails.
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

  // Coerce values based on declared parameter types
  if (condDef.parameters) {
    for (const [key, paramType] of Object.entries(condDef.parameters)) {
      if (key in context) {
        context[key] = coerceValue(context[key], paramType);
      }
    }
  }

  let compiled = exprCache.get(condDef.name);
  if (!compiled) {
    compiled = parse(condDef.expression);
    exprCache.set(condDef.name, compiled);
  }

  try {
    const result = compiled(context);
    return result === true;
  } catch (error) {
    throw new ConditionEvaluationError(condDef.name, error);
  }
}
