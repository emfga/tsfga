import { CachingTupleStore } from "./caching-store.ts";
import { evaluateTupleCondition } from "./conditions.ts";
import { ContextualTupleStore } from "./contextual-store.ts";
import { DepthExceededError, TsfgaError } from "./errors.ts";
import type { TupleStore } from "./store-interface.ts";
import { validateTupleWrite } from "./tuple-validation.ts";
import type {
  CheckOptions,
  CheckRequest,
  RelationConfig,
  Tuple,
} from "./types.ts";

/** Results of the per-node tuple batch: direct, wildcard, userset. */
type NodeReads = readonly [Tuple | null, Tuple | null, Tuple[]];

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
 *
 * Depth accounting: only steps that move to a *different object*
 * — userset expansion and tuple-to-userset expansion — cost
 * depth. Rewrites of the same object (implied_by, computed
 * userset, exclusion, intersection operands) cost none. This
 * mirrors OpenFGA, which increments resolution depth solely in
 * `dispatch` (`internal/graph/check.go`, called only for userset
 * and TTU children) and notes explicitly at `checkComputedUserset`
 * that "we don't want to increase resolution depth". Rewrite
 * recursion is bounded by the cycle path instead: the relation
 * set of one object is finite, so it always terminates.
 * - Within union-style resolution (steps 1-5), a branch that
 *   resolves `true` wins even if a sibling branch threw
 *   DepthExceededError. If no branch resolves `true` and at least
 *   one errored, the error propagates.
 * - Exclusion and intersection fail closed — an errored branch
 *   never counts as satisfied or as not-excluded — but a
 *   definitive deny short-circuits past a sibling error, matching
 *   OpenFGA: an intersection operand resolving `false`, or an
 *   exclusion branch resolving `true`, denies even when the other
 *   branch errored.
 * - Contextual tuples are validated against relation configs
 *   exactly like `addTuple` (RelationConfigNotFoundError,
 *   InvalidSubjectTypeError, UsersetNotAllowedError).
 *
 * Concurrency: branches of one resolution node run concurrently,
 * bounded by `options.maxBreadth` (default 10, matching OpenFGA's
 * default `OPENFGA_RESOLVE_NODE_BREADTH_LIMIT`; pass Infinity for
 * unbounded fanout).
 * Breadth never changes the boolean result or whether a check
 * resolves versus rejects; when several branches fail, which
 * branch's error surfaces depends on completion order — the same
 * nondeterminism OpenFGA has.
 */
export async function check(
  store: TupleStore,
  request: CheckRequest,
  options: CheckOptions = {},
): Promise<boolean> {
  const maxDepth = options.maxDepth ?? 25;
  const maxBreadth = options.maxBreadth ?? 10;
  // The negated comparison also rejects NaN, which `< 1` misses.
  // Fractional values would admit one more branch than stated
  // (`active < 1.5` allows 2 in flight), so only integers — and
  // Infinity, which Number.isInteger rejects — are accepted.
  if (
    !(maxBreadth >= 1) ||
    (maxBreadth !== Number.POSITIVE_INFINITY && !Number.isInteger(maxBreadth))
  ) {
    throw new TsfgaError(
      `maxBreadth must be a positive integer or Infinity, got ${maxBreadth}`,
    );
  }

  // Request-scoped cache for relation configs and condition
  // definitions: static per model, but read at every node.
  const cachingStore = new CachingTupleStore(store);

  // Wrap store with contextual tuples for the whole request.
  // Contextual tuples must pass the same validation as addTuple.
  let effectiveStore: TupleStore = cachingStore;
  if (request.contextualTuples?.length) {
    // Validate all contextual tuples concurrently; surface the
    // first failure in tuple order (not completion order) so the
    // thrown error is deterministic.
    const validations = await Promise.allSettled(
      request.contextualTuples.map((tuple) =>
        validateTupleWrite(cachingStore, tuple),
      ),
    );
    for (const validation of validations) {
      if (validation.status === "rejected") {
        throw validation.reason;
      }
    }
    effectiveStore = new ContextualTupleStore(
      cachingStore,
      request.contextualTuples,
    );
  }

  return checkNode(effectiveStore, request, maxDepth, maxBreadth, 0, new Set());
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
  maxBreadth: number,
  depth: number,
  path: ReadonlySet<string>,
): Promise<boolean> {
  // `depth` counts dispatches already made, so the budget is spent
  // once it reaches maxDepth — OpenFGA errors on
  // `Depth == maxResolutionDepth`, before resolving the node.
  if (depth >= maxDepth) {
    throw new DepthExceededError(`max depth of ${maxDepth} exceeded`);
  }

  const key = `${request.objectType}:${request.objectId}#${request.relation}`;
  if (path.has(key)) {
    throw new DepthExceededError(`cycle detected at ${key}`);
  }
  const visited = new Set(path);
  visited.add(key);

  // Speculatively start the tuple batch so it overlaps the config
  // fetch: one round-trip wave per node instead of two. Some paths
  // never await it (config error, or an intersection without a
  // direct operand); the derived catch keeps such a rejection from
  // going unhandled while awaiting callers still see the error.
  const reads = readNodeTuples(store, request);
  reads.catch(() => {});

  // Fetch relation config once for use across all steps
  const config = await store.findRelationConfig(
    request.objectType,
    request.relation,
  );

  // Base resolution: intersection replaces steps 1-5 when present
  const resolveBase = (): Promise<boolean> =>
    config?.intersection
      ? checkIntersection(
          store,
          request,
          config,
          reads,
          maxDepth,
          maxBreadth,
          depth,
          visited,
        )
      : checkBase(
          store,
          request,
          config,
          reads,
          maxDepth,
          maxBreadth,
          depth,
          visited,
        );

  // Exclusion applies on top of the base result — including on top
  // of intersection results. A definitive deny short-circuits past
  // a sibling error, matching OpenFGA: a base `false` denies even
  // when the exclusion branch errored, and a granted exclusion
  // branch denies even when the base errored. Errors otherwise
  // fail closed: a base grant with an errored exclusion branch
  // propagates the error rather than granting.
  if (config?.excludedBy) {
    const excludedBy = config.excludedBy;
    const [baseResult, exclusionResult] = await Promise.allSettled([
      resolveBase(),
      // Same object, a rewrite of it — no depth cost (upstream
      // builds the subtract branch on the unchanged request).
      checkNode(
        store,
        { ...request, relation: excludedBy },
        maxDepth,
        maxBreadth,
        depth,
        visited,
      ),
    ]);
    if (exclusionResult.status === "fulfilled" && exclusionResult.value) {
      return false;
    }
    if (baseResult.status === "rejected") {
      throw baseResult.reason;
    }
    if (!baseResult.value) {
      return false;
    }
    if (exclusionResult.status === "rejected") {
      throw exclusionResult.reason;
    }
    return true;
  }

  return resolveBase();
}

/**
 * Issue the three per-node tuple reads (direct probe, wildcard
 * probe, userset scan) as one batch. Started at node entry so
 * they overlap the relation-config fetch.
 */
function readNodeTuples(
  store: TupleStore,
  request: CheckRequest,
): Promise<NodeReads> {
  return Promise.all([
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
}

/**
 * Base check: steps 1-5 without exclusion or intersection handling.
 */
async function checkBase(
  store: TupleStore,
  request: CheckRequest,
  config: RelationConfig | null,
  reads: Promise<NodeReads>,
  maxDepth: number,
  maxBreadth: number,
  depth: number,
  path: ReadonlySet<string>,
): Promise<boolean> {
  const [directTuple, wildcardTuple, usersetTuples] = await reads;

  // Steps 1/1b: an unconditioned direct or wildcard hit answers
  // immediately, before any sub-check is launched
  if (directTuple && !directTuple.conditionName) {
    return true;
  }
  if (wildcardTuple && !wildcardTuple.conditionName) {
    return true;
  }

  // Collect all sub-check handlers for concurrent resolution
  const handlers: Array<() => Promise<boolean>> = [];

  // Conditioned direct/wildcard hits race as union branches so
  // their condition evaluation (a possible condition-definition
  // fetch) does not block the fanout below. Union semantics
  // apply: a sibling `true` beats a condition error.
  if (directTuple) {
    handlers.push(() =>
      evaluateTupleCondition(store, directTuple, request.context),
    );
  }
  if (wildcardTuple) {
    handlers.push(() =>
      evaluateTupleCondition(store, wildcardTuple, request.context),
    );
  }

  // Step 2: Userset expansion handlers. This moves to another
  // object, so it is a dispatch and costs one depth.
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
        maxBreadth,
        depth + 1,
        path,
      );
    });
  }

  // Step 3: Relation inheritance (implied_by) handlers.
  // Same object, so no depth cost — see the depth-accounting note
  // on `check`.
  if (config?.impliedBy) {
    for (const impliedRelation of config.impliedBy) {
      handlers.push(() =>
        checkNode(
          store,
          { ...request, relation: impliedRelation },
          maxDepth,
          maxBreadth,
          depth,
          path,
        ),
      );
    }
  }

  // Step 4: Computed userset handler. Same object, no depth cost.
  if (config?.computedUserset) {
    const computedUserset = config.computedUserset;
    handlers.push(() =>
      checkNode(
        store,
        { ...request, relation: computedUserset },
        maxDepth,
        maxBreadth,
        depth,
        path,
      ),
    );
  }

  // Step 5: Tuple-to-userset composite handler. Like step 2 this
  // moves to another object, so each child costs one depth.
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
              maxBreadth,
              depth + 1,
              path,
            ),
          );
        }
      }

      return resolveUnion(ttuHandlers, maxBreadth);
    });
  }

  return resolveUnion(handlers, maxBreadth);
}

/**
 * Intersection check: ALL operands must be true.
 */
async function checkIntersection(
  store: TupleStore,
  request: CheckRequest,
  config: RelationConfig,
  reads: Promise<NodeReads>,
  maxDepth: number,
  maxBreadth: number,
  depth: number,
  path: ReadonlySet<string>,
): Promise<boolean> {
  const operands = config.intersection;
  // An intersection with no operands would resolve vacuously true,
  // granting access to every subject on a malformed config.
  // OpenFGA's typesystem rejects set operations with too few
  // children as an invalid model; fail closed with an error.
  if (!operands || operands.length === 0) {
    throw new TsfgaError(
      `intersection for ${request.objectType}.${request.relation} ` +
        "has no operands",
    );
  }

  const handlers: Array<() => Promise<boolean>> = [];

  for (const operand of operands) {
    if (operand.type === "direct") {
      handlers.push(() =>
        checkBase(
          store,
          request,
          config,
          reads,
          maxDepth,
          maxBreadth,
          depth,
          path,
        ),
      );
    } else if (operand.type === "computedUserset") {
      // Same object, no depth cost — as with the other rewrites.
      handlers.push(() =>
        checkNode(
          store,
          { ...request, relation: operand.relation },
          maxDepth,
          maxBreadth,
          depth,
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
              maxBreadth,
              depth + 1,
              path,
            ),
          );
        }
        return resolveUnion(ttuHandlers, maxBreadth);
      });
    }
  }

  return resolveIntersection(handlers, maxBreadth);
}

/**
 * Run handlers with at most `maxBreadth` in flight, short-circuit
 * on first true. A `true` result wins even when sibling branches
 * rejected (e.g. with DepthExceededError). When no handler resolves
 * true, rejects with the first error if any handler rejected;
 * resolves false otherwise. Handlers still queued when the union
 * settles are never started.
 */
function resolveUnion(
  handlers: Array<() => Promise<boolean>>,
  maxBreadth: number,
): Promise<boolean> {
  return resolveShortCircuit(handlers, maxBreadth, true);
}

/**
 * Run handlers with at most `maxBreadth` in flight, short-circuit
 * on first false — a definitive false wins even when a sibling
 * operand errored, matching OpenFGA's intersection. Resolves true
 * when all return true. When no operand resolves false and at
 * least one errored, rejects with the first error (fail closed:
 * an errored operand never counts as satisfied). Handlers still
 * queued when the intersection settles are never started.
 */
function resolveIntersection(
  handlers: Array<() => Promise<boolean>>,
  maxBreadth: number,
): Promise<boolean> {
  return resolveShortCircuit(handlers, maxBreadth, false);
}

/**
 * Bounded pull-model combinator shared by union and intersection —
 * duals of each other: union short-circuits on `true` and resolves
 * `false` on exhaustion; intersection short-circuits on `false`
 * and resolves `true` on exhaustion. Mirrors OpenFGA's reducers,
 * which take the breadth limit as their concurrency bound.
 *
 * Handlers launch in array order while fewer than `maxBreadth` are
 * in flight; each settlement pulls the next queued handler. Once
 * the result is decided nothing new starts, in-flight losers are
 * ignored on completion, and their rejections are consumed by the
 * callbacks attached at launch — no unhandled rejections. On
 * exhaustion with no decisive result, one recorded error (the
 * first by completion order) propagates; otherwise the
 * non-short-circuit value resolves. Which branch's error surfaces
 * when several fail is scheduling-dependent, as it is in OpenFGA
 * (whose union keeps the last-completed error instead).
 *
 * Exported for direct unit tests only; not part of the public
 * package API (not re-exported from index.ts).
 */
export function resolveShortCircuit(
  handlers: Array<() => Promise<boolean>>,
  maxBreadth: number,
  shortCircuitOn: boolean,
): Promise<boolean> {
  return new Promise((resolve, reject) => {
    let next = 0;
    let active = 0;
    let settled = false;
    let firstError: unknown;
    let hasError = false;

    const settleExhausted = () => {
      settled = true;
      if (hasError) {
        reject(firstError);
      } else {
        resolve(!shortCircuitOn);
      }
    };

    const onHandlerDone = () => {
      active--;
      if (next < handlers.length) {
        launch();
      } else if (active === 0) {
        settleExhausted();
      }
    };

    const launch = () => {
      while (!settled && active < maxBreadth && next < handlers.length) {
        const handler = handlers[next];
        next++;
        if (!handler) continue;
        active++;
        let branch: Promise<boolean>;
        try {
          branch = handler();
        } catch (error) {
          // A synchronously-throwing handler counts as a rejected
          // branch; without this its slot would leak and the
          // combinator could stall with nothing in flight.
          active--;
          if (!hasError) {
            hasError = true;
            firstError = error;
          }
          continue;
        }
        branch.then(
          (result) => {
            if (settled) return;
            if (result === shortCircuitOn) {
              settled = true;
              resolve(shortCircuitOn);
              return;
            }
            onHandlerDone();
          },
          (error) => {
            if (settled) return;
            if (!hasError) {
              hasError = true;
              firstError = error;
            }
            onHandlerDone();
          },
        );
      }
      // Empty input, holes, and synchronous throws can exhaust the
      // array with nothing in flight; settle here so the returned
      // promise can never stall.
      if (!settled && active === 0 && next >= handlers.length) {
        settleExhausted();
      }
    };

    launch();
  });
}
