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
 * bounded by `options.maxBreadth` (default Infinity — unbounded),
 * mirroring OpenFGA's `OPENFGA_RESOLVE_NODE_BREADTH_LIMIT`.
 * Breadth only reorders work; answers never depend on it.
 */
export async function check(
  store: TupleStore,
  request: CheckRequest,
  options: CheckOptions = {},
): Promise<boolean> {
  const maxDepth = options.maxDepth ?? 25;
  const maxBreadth = options.maxBreadth ?? Number.POSITIVE_INFINITY;
  // The negated comparison also rejects NaN, which `< 1` misses.
  if (!(maxBreadth >= 1)) {
    throw new TsfgaError(`maxBreadth must be at least 1, got ${maxBreadth}`);
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
  if (depth > maxDepth) {
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
      checkNode(
        store,
        { ...request, relation: excludedBy },
        maxDepth,
        maxBreadth,
        depth + 1,
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
        maxBreadth,
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
          maxBreadth,
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
        maxBreadth,
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
  if (!operands) return true;

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
      handlers.push(() =>
        checkNode(
          store,
          { ...request, relation: operand.relation },
          maxDepth,
          maxBreadth,
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
 * exhaustion with no decisive result, the first-recorded error
 * (by completion order, matching OpenFGA) propagates; otherwise
 * the non-short-circuit value resolves.
 */
function resolveShortCircuit(
  handlers: Array<() => Promise<boolean>>,
  maxBreadth: number,
  shortCircuitOn: boolean,
): Promise<boolean> {
  if (handlers.length === 0) {
    return Promise.resolve(!shortCircuitOn);
  }

  return new Promise((resolve, reject) => {
    let next = 0;
    let active = 0;
    let settled = false;
    let firstError: unknown;
    let hasError = false;

    const onHandlerDone = () => {
      active--;
      if (next < handlers.length) {
        launch();
      } else if (active === 0) {
        settled = true;
        if (hasError) {
          reject(firstError);
        } else {
          resolve(!shortCircuitOn);
        }
      }
    };

    const launch = () => {
      while (!settled && active < maxBreadth && next < handlers.length) {
        const handler = handlers[next];
        next++;
        if (!handler) continue;
        active++;
        handler().then(
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
    };

    launch();
  });
}
