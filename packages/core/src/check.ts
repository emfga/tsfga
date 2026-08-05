import { evaluateTupleCondition } from "./conditions.ts";
import { ContextualTupleStore } from "./contextual-store.ts";
import { DepthExceededError } from "./errors.ts";
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
 *
 * Error semantics:
 * - Throws DepthExceededError when the recursion budget
 *   (`options.maxDepth`, default 25) is exhausted or a cycle is
 *   detected in the resolution path. Exhaustion is never converted
 *   to `false`: inside an exclusion or intersection branch that
 *   would fail open.
 * - Within union-style resolution (steps 1-5), a branch that
 *   resolves `true` wins even if a sibling branch threw
 *   DepthExceededError. If no branch resolves `true` and at least
 *   one errored, the error propagates.
 * - Contextual tuples are validated against relation configs
 *   exactly like `addTuple` (RelationConfigNotFoundError,
 *   InvalidSubjectTypeError, UsersetNotAllowedError).
 */
export async function check(
  store: TupleStore,
  request: CheckRequest,
  options: CheckOptions = {},
): Promise<boolean> {
  const maxDepth = options.maxDepth ?? 25;

  // Wrap store with contextual tuples for the whole request.
  // Contextual tuples must pass the same validation as addTuple.
  let effectiveStore = store;
  if (request.contextualTuples?.length) {
    for (const tuple of request.contextualTuples) {
      await validateTupleWrite(store, tuple);
    }
    effectiveStore = new ContextualTupleStore(store, request.contextualTuples);
  }

  return checkNode(effectiveStore, request, maxDepth, 0, new Set());
}

/**
 * Resolve one node of the check graph. Tracks the current
 * resolution path in `path` (keys of `objectType:objectId#relation`
 * — the subject is constant per request) so cycles throw
 * DepthExceededError instead of silently resolving.
 */
async function checkNode(
  store: TupleStore,
  request: CheckRequest,
  maxDepth: number,
  depth: number,
  path: ReadonlySet<string>,
): Promise<boolean> {
  if (depth > maxDepth) {
    throw new DepthExceededError(`max depth of ${maxDepth} exceeded`);
  }

  const key = `${request.objectType}:${request.objectId}#${request.relation}`;
  if (path.has(key)) {
    throw new DepthExceededError(`cycle detected at ${key}`);
  }
  const visited = new Set(path);
  visited.add(key);

  // Fetch relation config once for use across all steps
  const config = await store.findRelationConfig(
    request.objectType,
    request.relation,
  );

  // Base resolution: intersection replaces steps 1-5 when present
  const resolveBase = (): Promise<boolean> =>
    config?.intersection
      ? checkIntersection(store, request, config, maxDepth, depth, visited)
      : checkBase(store, request, config, maxDepth, depth, visited);

  // Exclusion applies on top of the base result — including on top
  // of intersection results. Errors in either branch fail closed:
  // a definite base `false` denies regardless of the exclusion
  // branch, but a base grant with an errored exclusion branch must
  // propagate the error rather than grant.
  if (config?.excludedBy) {
    const excludedBy = config.excludedBy;
    const [baseResult, exclusionResult] = await Promise.allSettled([
      resolveBase(),
      checkNode(
        store,
        { ...request, relation: excludedBy },
        maxDepth,
        depth + 1,
        visited,
      ),
    ]);
    if (baseResult.status === "rejected") {
      throw baseResult.reason;
    }
    if (!baseResult.value) {
      return false;
    }
    if (exclusionResult.status === "rejected") {
      throw exclusionResult.reason;
    }
    return !exclusionResult.value;
  }

  return resolveBase();
}

/**
 * Base check: steps 1-5 without exclusion or intersection handling.
 */
async function checkBase(
  store: TupleStore,
  request: CheckRequest,
  config: RelationConfig | null,
  maxDepth: number,
  depth: number,
  path: ReadonlySet<string>,
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
      return checkNode(
        store,
        {
          objectType: userset.subjectType,
          objectId: userset.subjectId,
          relation,
          subjectType: request.subjectType,
          subjectId: request.subjectId,
          context: request.context,
        },
        maxDepth,
        depth + 1,
        path,
      );
    });
  }

  // Step 3: Relation inheritance (implied_by) handlers
  if (config?.impliedBy) {
    for (const impliedRelation of config.impliedBy) {
      handlers.push(() =>
        checkNode(
          store,
          { ...request, relation: impliedRelation },
          maxDepth,
          depth + 1,
          path,
        ),
      );
    }
  }

  // Step 4: Computed userset handler
  if (config?.computedUserset) {
    const computedUserset = config.computedUserset;
    handlers.push(() =>
      checkNode(
        store,
        { ...request, relation: computedUserset },
        maxDepth,
        depth + 1,
        path,
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
            checkNode(
              store,
              {
                objectType: linked.subjectType,
                objectId: linked.subjectId,
                relation: computedUserset,
                subjectType: request.subjectType,
                subjectId: request.subjectId,
                context: request.context,
              },
              maxDepth,
              depth + 1,
              path,
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
  maxDepth: number,
  depth: number,
  path: ReadonlySet<string>,
): Promise<boolean> {
  const operands = config.intersection;
  if (!operands) return true;

  const handlers: Array<() => Promise<boolean>> = [];

  for (const operand of operands) {
    if (operand.type === "direct") {
      handlers.push(() =>
        checkBase(store, request, config, maxDepth, depth, path),
      );
    } else if (operand.type === "computedUserset") {
      handlers.push(() =>
        checkNode(
          store,
          { ...request, relation: operand.relation },
          maxDepth,
          depth + 1,
          path,
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
            checkNode(
              store,
              {
                objectType: linked.subjectType,
                objectId: linked.subjectId,
                relation: operand.computedUserset,
                subjectType: request.subjectType,
                subjectId: request.subjectId,
                context: request.context,
              },
              maxDepth,
              depth + 1,
              path,
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
 * Run handlers concurrently. Resolves true on first true
 * (short-circuit). A `true` result wins even when sibling branches
 * rejected (e.g. with DepthExceededError). When no handler resolves
 * true, rejects with the first error if any handler rejected;
 * resolves false otherwise.
 */
async function resolveUnion(
  handlers: Array<() => Promise<boolean>>,
): Promise<boolean> {
  if (handlers.length === 0) {
    return false;
  }

  return new Promise((resolve, reject) => {
    let remaining = handlers.length;
    let firstError: unknown;
    let hasError = false;

    const settleIfDone = () => {
      remaining--;
      if (remaining === 0) {
        if (hasError) {
          reject(firstError);
        } else {
          resolve(false);
        }
      }
    };

    for (const handler of handlers) {
      handler().then(
        (result) => {
          if (result) {
            resolve(true);
          } else {
            settleIfDone();
          }
        },
        (error) => {
          if (!hasError) {
            hasError = true;
            firstError = error;
          }
          settleIfDone();
        },
      );
    }
  });
}

/**
 * Run handlers concurrently. Resolves false on first false
 * (short-circuit). Resolves true when all return true. Rejects on
 * first error (fail closed: an errored operand never counts as
 * satisfied).
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
