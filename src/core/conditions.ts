import { type ParseResult, parse } from "@marcbachmann/cel-js";
import {
  ConditionEvaluationError,
  ConditionNotFoundError,
} from "src/core/errors.ts";
import type { Tuple } from "src/core/types.ts";
import type { TupleStore } from "src/store/interface.ts";

/** Cache compiled CEL expressions by condition name */
const exprCache = new Map<string, ParseResult>();

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
