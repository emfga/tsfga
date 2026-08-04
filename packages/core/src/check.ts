import { evaluateTupleCondition } from "./conditions.ts";
import { ContextualTupleStore } from "./contextual-store.ts";
import type { TupleStore } from "./store-interface.ts";
import { validateTupleWrite } from "./tuple-validation.ts";
import type { CheckOptions, CheckRequest, RelationConfig } from "./types.ts";

/**
 * Recursive check algorithm with support for:
 * - Direct tuple check + wildcard
 * - Userset expansion
 * - Relation inheritance (implied_by)
 * - Computed userset
 * - Tuple-to-userset
 * - Exclusion (but not)
 * - Intersection (and)
 */
export async function check(
  store: TupleStore,
  request: CheckRequest,
  options: CheckOptions = {},
  depth: number = 0,
): Promise<boolean> {
  const maxDepth = options.maxDepth ?? 10;

  // Prevent infinite recursion
  if (depth > maxDepth) {
    return false;
  }

  // Wrap store with contextual tuples at depth 0 only.
  // Contextual tuples must pass the same validation as addTuple.
  if (depth === 0 && request.contextualTuples?.length) {
    for (const tuple of request.contextualTuples) {
      await validateTupleWrite(store, tuple);
    }
    store = new ContextualTupleStore(store, request.contextualTuples);
  }

  // Fetch relation config once for use across all steps
  const config = await store.findRelationConfig(
    request.objectType,
    request.relation,
  );

  // If the relation has an intersection, ALL operands must be true
  if (config?.intersection) {
    return checkIntersection(store, request, config, options, depth);
  }

  // Run the base check and exclusion in parallel when excludedBy is set
  if (config?.excludedBy) {
    const [baseResult, isExcluded] = await Promise.all([
      checkBase(store, request, config, options, depth),
      check(
        store,
        { ...request, relation: config.excludedBy },
        options,
        depth + 1,
      ),
    ]);
    return baseResult && !isExcluded;
  }

  return checkBase(store, request, config, options, depth);
}

/**
 * Base check: steps 1-5 without exclusion or intersection handling.
 */
async function checkBase(
  store: TupleStore,
  request: CheckRequest,
  config: RelationConfig | null,
  options: CheckOptions,
  depth: number,
): Promise<boolean> {
  // Batch initial reads: direct, wildcard, and userset tuples
  const [directTuple, wildcardTuple, usersetTuples] = await Promise.all([
    store.findDirectTuple(
      request.objectType,
      request.objectId,
      request.relation,
      request.subjectType,
      request.subjectId,
    ),
    store.findDirectTuple(
      request.objectType,
      request.objectId,
      request.relation,
      request.subjectType,
      "*",
    ),
    store.findUsersetTuples(
      request.objectType,
      request.objectId,
      request.relation,
    ),
  ]);

  // Step 1: Direct tuple fast path
  if (directTuple) {
    if (await evaluateTupleCondition(store, directTuple, request.context)) {
      return true;
    }
  }

  // Step 1b: Wildcard fast path
  if (wildcardTuple) {
    if (await evaluateTupleCondition(store, wildcardTuple, request.context)) {
      return true;
    }
  }

  // Collect all sub-check handlers for concurrent resolution
  const handlers: Array<() => Promise<boolean>> = [];

  // Step 2: Userset expansion handlers
  for (const userset of usersetTuples) {
    if (!userset.subjectRelation) continue;
    const relation = userset.subjectRelation;
    handlers.push(async () => {
      if (!(await evaluateTupleCondition(store, userset, request.context))) {
        return false;
      }
      return check(
        store,
        {
          objectType: userset.subjectType,
          objectId: userset.subjectId,
          relation,
          subjectType: request.subjectType,
          subjectId: request.subjectId,
          context: request.context,
        },
        options,
        depth + 1,
      );
    });
  }

  // Step 3: Relation inheritance (implied_by) handlers
  if (config?.impliedBy) {
    for (const impliedRelation of config.impliedBy) {
      handlers.push(() =>
        check(
          store,
          { ...request, relation: impliedRelation },
          options,
          depth + 1,
        ),
      );
    }
  }

  // Step 4: Computed userset handler
  if (config?.computedUserset) {
    const computedUserset = config.computedUserset;
    handlers.push(() =>
      check(
        store,
        { ...request, relation: computedUserset },
        options,
        depth + 1,
      ),
    );
  }

  // Step 5: Tuple-to-userset composite handler
  if (config?.tupleToUserset) {
    const ttuEntries = config.tupleToUserset;
    handlers.push(async () => {
      // Batch all tupleset lookups
      const linkedResults = await Promise.all(
        ttuEntries.map(({ tupleset }) =>
          store.findTuplesByRelation(
            request.objectType,
            request.objectId,
            tupleset,
          ),
        ),
      );

      // Collect all linked-tuple check handlers
      const ttuHandlers: Array<() => Promise<boolean>> = [];
      for (const [i, { computedUserset }] of ttuEntries.entries()) {
        const linkedTuples = linkedResults[i] ?? [];
        for (const linked of linkedTuples) {
          ttuHandlers.push(() =>
            check(
              store,
              {
                objectType: linked.subjectType,
                objectId: linked.subjectId,
                relation: computedUserset,
                subjectType: request.subjectType,
                subjectId: request.subjectId,
                context: request.context,
              },
              options,
              depth + 1,
            ),
          );
        }
      }

      return resolveUnion(ttuHandlers);
    });
  }

  return resolveUnion(handlers);
}

/**
 * Intersection check: ALL operands must be true.
 */
async function checkIntersection(
  store: TupleStore,
  request: CheckRequest,
  config: RelationConfig,
  options: CheckOptions,
  depth: number,
): Promise<boolean> {
  const operands = config.intersection;
  if (!operands) return true;

  const handlers: Array<() => Promise<boolean>> = [];

  for (const operand of operands) {
    if (operand.type === "direct") {
      handlers.push(() => checkBase(store, request, config, options, depth));
    } else if (operand.type === "computedUserset") {
      handlers.push(() =>
        check(
          store,
          { ...request, relation: operand.relation },
          options,
          depth + 1,
        ),
      );
    } else {
      // tupleToUserset operand
      handlers.push(async () => {
        const linkedTuples = await store.findTuplesByRelation(
          request.objectType,
          request.objectId,
          operand.tupleset,
        );
        const ttuHandlers: Array<() => Promise<boolean>> = [];
        for (const linked of linkedTuples) {
          ttuHandlers.push(() =>
            check(
              store,
              {
                objectType: linked.subjectType,
                objectId: linked.subjectId,
                relation: operand.computedUserset,
                subjectType: request.subjectType,
                subjectId: request.subjectId,
                context: request.context,
              },
              options,
              depth + 1,
            ),
          );
        }
        return resolveUnion(ttuHandlers);
      });
    }
  }

  return resolveIntersection(handlers);
}

/**
 * Run handlers concurrently. Resolves true on first true (short-circuit).
 * Resolves false when all return false. Rejects on first error.
 */
async function resolveUnion(
  handlers: Array<() => Promise<boolean>>,
): Promise<boolean> {
  if (handlers.length === 0) {
    return false;
  }

  return new Promise((resolve, reject) => {
    let remaining = handlers.length;
    for (const handler of handlers) {
      handler().then(
        (result) => {
          if (result) {
            resolve(true);
          } else {
            remaining--;
            if (remaining === 0) {
              resolve(false);
            }
          }
        },
        (error) => reject(error),
      );
    }
  });
}

/**
 * Run handlers concurrently. Resolves false on first false (short-circuit).
 * Resolves true when all return true. Rejects on first error.
 */
async function resolveIntersection(
  handlers: Array<() => Promise<boolean>>,
): Promise<boolean> {
  if (handlers.length === 0) {
    return true;
  }

  return new Promise((resolve, reject) => {
    let remaining = handlers.length;
    for (const handler of handlers) {
      handler().then(
        (result) => {
          if (!result) {
            resolve(false);
          } else {
            remaining--;
            if (remaining === 0) {
              resolve(true);
            }
          }
        },
        (error) => reject(error),
      );
    }
  });
}
