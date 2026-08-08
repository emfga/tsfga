import { CachingTupleStore } from "./caching-store.ts";
import { evaluateTupleCondition } from "./conditions.ts";
import { ContextualTupleStore } from "./contextual-store.ts";
import { DepthExceededError, TsfgaError } from "./errors.ts";
import type { TupleStore } from "./store-interface.ts";
import {
  admitsDirectSubject,
  admitsUsersetSubjects,
  directSubjectRef,
  validateTupleWrite,
} from "./tuple-validation.ts";
import type {
  CheckOptions,
  CheckRequest,
  CheckTuples,
  CheckTuplesQuery,
  RelationConfig,
  Tuple,
} from "./types.ts";

/**
 * Internal result of resolving one node.
 *
 * `cycleDetected` marks a `false` that is an *absence of an
 * answer* rather than a denial: the resolution path looped back
 * on itself and the subtree was truncated. It matters because the
 * set operators treat it differently from a plain `false` — most
 * sharply on the subtract side of an exclusion, where a cycle
 * denies rather than failing to exclude.
 *
 * It stays internal. Upstream's equivalent lives in
 * `ResolveCheckResponseMetadata`, reaches the command layer's
 * `CheckResult`, and is not a field of the wire `CheckResponse` —
 * so it is not exposed on tsfga's `check()` return either.
 *
 * Never mutated; the shared constants below are safe to alias.
 */
export interface CheckResult {
  allowed: boolean;
  cycleDetected: boolean;
}

const DENIED: CheckResult = { allowed: false, cycleDetected: false };
const GRANTED: CheckResult = { allowed: true, cycleDetected: false };
const CYCLE: CheckResult = { allowed: false, cycleDetected: true };

/**
 * How a set operator folds its branches. Union and intersection
 * are not quite duals once cycles are in play, so each supplies
 * its own rule rather than sharing a `shortCircuitOn` flag.
 */
export interface Reducer {
  /** Seed, and the result if every branch ran without deciding. */
  readonly initial: CheckResult;
  /** Non-null ends the node immediately with that result. */
  decide(result: CheckResult): CheckResult | null;
  /** Fold a non-deciding branch into the running result. */
  accumulate(acc: CheckResult, result: CheckResult): CheckResult;
}

/**
 * Union: the first grant wins and is returned verbatim, so a
 * truncated sibling is forgotten. Otherwise a cycle anywhere makes
 * the whole `false` indeterminate. An errored branch neither
 * decides nor contributes a flag, but does beat a cycle-`false` on
 * exhaustion — `true` > error > cycle > `false`.
 */
export const UNION_REDUCER: Reducer = {
  initial: DENIED,
  decide: (result) => (result.allowed ? result : null),
  accumulate: (acc, result) => (result.cycleDetected ? CYCLE : acc),
};

/**
 * Intersection: a cycle is as fatal as a plain `false`, since an
 * operand that could not be resolved cannot be shown to hold. The
 * deciding operand's flag rides out with the denial.
 */
export const INTERSECTION_REDUCER: Reducer = {
  initial: GRANTED,
  decide: (result) =>
    result.cycleDetected || !result.allowed
      ? { allowed: false, cycleDetected: result.cycleDetected }
      : null,
  accumulate: (acc) => acc,
};

/** A settled node result, plus the depth it was resolved at. */
interface MemoEntry {
  result: CheckResult;
  depth: number;
}

/**
 * Request-scoped memo of settled node results, so a node reached
 * by several routes is resolved once instead of once per route.
 * The check graph is a DAG; without this it is explored as a tree.
 *
 * Nested rather than keyed on a joined string: ids are not
 * charset-restricted, so `:` and `#` can occur inside one and a
 * flat key could collide across different nodes
 * (`caching-store.ts` sets the precedent). Note that the *path*
 * key a few lines below does join — two guards in the same
 * function keyed differently is a trap, so: the path key
 * deliberately omits the subject, because the subject is constant
 * for a whole request.
 *
 * The memo includes the subject anyway. It is redundant today for
 * the same reason, but nothing in the types enforces it, and a
 * future code path that varied the subject would make the path
 * key merely over-eager while making the memo *wrong*.
 */
type MemoMap<V> = Map<string, V>;
type NodeMemo = MemoMap<MemoMap<MemoMap<MemoMap<MemoMap<MemoEntry>>>>>;

function memoGet(memo: NodeMemo, request: CheckRequest): MemoEntry | undefined {
  return memo
    .get(request.subjectType)
    ?.get(request.subjectId)
    ?.get(request.objectType)
    ?.get(request.objectId)
    ?.get(request.relation);
}

function memoLevel<V>(map: MemoMap<MemoMap<V>>, key: string): MemoMap<V> {
  let level = map.get(key);
  if (!level) {
    level = new Map();
    map.set(key, level);
  }
  return level;
}

function memoSet(
  memo: NodeMemo,
  request: CheckRequest,
  entry: MemoEntry,
): void {
  const bySubjectId = memoLevel(memo, request.subjectType);
  const byObjectType = memoLevel(bySubjectId, request.subjectId);
  const byObjectId = memoLevel(byObjectType, request.objectType);
  const byRelation = memoLevel(byObjectId, request.objectId);
  byRelation.set(request.relation, entry);
}

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
 *   (`options.maxDepth`, default 25) is exhausted. Exhaustion is
 *   never converted to `false`: inside an exclusion or
 *   intersection branch that would fail open.
 * - A cycle in the resolution path is *not* an error. The looping
 *   subtree resolves `false` carrying an internal indeterminacy
 *   flag, matching OpenFGA, which errors only on depth exhaustion
 *   and returns `Allowed:false` with `CycleDetected:true` for a
 *   cycle. The flag is not merely a `false`: on the subtract side
 *   of an exclusion it denies, so `base:true butnot sub:cycle` is
 *   `false` rather than a grant.
 * - Within union-style resolution (steps 1-5), a branch that
 *   resolves `true` wins even if a sibling branch threw
 *   DepthExceededError or was truncated by a cycle. If no branch
 *   resolves `true` and at least one errored, the error
 *   propagates.
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
// `async` is load-bearing: `createCheckScope` validates
// `maxBreadth` and throws, and an option error must reach the
// caller as a rejection like every other check failure, not as a
// synchronous throw past their `.catch`.
export async function check(
  store: TupleStore,
  request: CheckRequest,
  options: CheckOptions = {},
): Promise<boolean> {
  return runCheck(createCheckScope(store, options), request);
}

/**
 * The state one or more checks share: resolved limits, a caching
 * store, and the node memo. A single check owns a scope of its
 * own; `listObjects` builds one and runs every candidate in it,
 * which is what makes the config cache and the memo span the whole
 * call instead of being rebuilt per candidate.
 *
 * A scope is only sound across requests that resolve over the same
 * graph. The memo keys on subject and node but *not* on the CEL
 * `context`, and the caching store keys on nothing at all, so
 * every request sharing a scope must carry the same `context`.
 * Contextual tuples are the other half of that constraint and
 * `runCheck` handles them itself, below.
 *
 * Internal. Not re-exported from `index.ts`.
 */
export interface CheckScope {
  readonly store: TupleStore;
  readonly maxDepth: number;
  readonly maxBreadth: number;
  readonly memo: NodeMemo;
}

export function createCheckScope(
  store: TupleStore,
  options: CheckOptions = {},
): CheckScope {
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

  return {
    // Cache for relation configs and condition definitions: static
    // per model, but read at every node.
    store: new CachingTupleStore(store),
    maxDepth: options.maxDepth ?? 25,
    maxBreadth,
    memo: new Map(),
  };
}

/** Run one check in a scope. Internal; see `CheckScope`. */
export async function runCheck(
  scope: CheckScope,
  request: CheckRequest,
): Promise<boolean> {
  let store = scope.store;
  let memo = scope.memo;

  // Wrap store with contextual tuples for the whole request.
  // Contextual tuples must pass the same validation as addTuple.
  if (request.contextualTuples?.length) {
    // Validate all contextual tuples concurrently; surface the
    // first failure in tuple order (not completion order) so the
    // thrown error is deterministic.
    const validations = await Promise.allSettled(
      request.contextualTuples.map((tuple) =>
        validateTupleWrite(scope.store, tuple),
      ),
    );
    for (const validation of validations) {
      if (validation.status === "rejected") {
        throw validation.reason;
      }
    }
    store = new ContextualTupleStore(scope.store, request.contextualTuples);
    // These tuples exist for this request only, so results resolved
    // over them are not shareable — and results already in the
    // scope's memo were resolved over a graph missing them. Neither
    // direction is safe, so this request memoizes on its own.
    memo = new Map();
  }

  const result = await checkNode(
    store,
    request,
    scope.maxDepth,
    scope.maxBreadth,
    0,
    new Set(),
    memo,
  );
  // The indeterminacy flag is internal; a cycle at the root is an
  // ordinary deny to the caller, as it is on OpenFGA's wire.
  return result.allowed;
}

/**
 * Resolve one node of the check graph, with cycle detection and
 * memoization. Tracks the current resolution path in `path` (keys
 * of `objectType:objectId#relation` — the subject is constant per
 * request) so a revisit truncates the subtree instead of recursing
 * forever.
 */
async function checkNode(
  store: TupleStore,
  request: CheckRequest,
  maxDepth: number,
  maxBreadth: number,
  depth: number,
  path: ReadonlySet<string>,
  memo: NodeMemo,
): Promise<CheckResult> {
  // `depth` counts dispatches already made, so the budget is spent
  // once it reaches maxDepth — OpenFGA errors on
  // `Depth == maxResolutionDepth`, before resolving the node.
  if (depth >= maxDepth) {
    throw new DepthExceededError(`max depth of ${maxDepth} exceeded`);
  }

  const key = `${request.objectType}:${request.objectId}#${request.relation}`;
  if (path.has(key)) {
    // Not an error: an indeterminate `false` that the set
    // operators above interpret for themselves.
    return CYCLE;
  }

  // Consulted *after* the cycle guard: a node already on this path
  // is a cycle no matter what some other branch concluded about it.
  //
  // Reuse is gated on depth. An entry recorded at depth D resolved
  // without exhausting the budget, so it needed at most
  // `maxDepth - D` levels; at any depth <= D there is at least that
  // much headroom left, so the same subtree resolves the same way.
  // Deeper is not safe: reusing it there could answer where a fresh
  // resolution would have thrown DepthExceededError. Recording the
  // greatest depth seen therefore widens the range of reuse.
  const memoized = memoGet(memo, request);
  if (memoized && depth <= memoized.depth) {
    return memoized.result;
  }

  const visited = new Set(path);
  visited.add(key);

  const result = await resolveNode(
    store,
    request,
    maxDepth,
    maxBreadth,
    depth,
    visited,
    memo,
  );

  // Only path-independent results are publishable.
  //
  // An indeterminate result is exactly the path-dependent case: the
  // subtree was truncated because it looped back onto *this* path,
  // and a different route to the same node would not have been. So
  // the flag, which every operator propagates for the branch it
  // returned, is the whole test — nothing else has to be inspected.
  //
  // What survives is sound by induction. A grant is a proof found,
  // and a proof does not stop existing on another route. A `false`
  // with no flag means every branch was refuted with no branch
  // truncated and none errored — errors reject rather than resolve,
  // and the two operators that swallow a sibling error do so only
  // behind a definitive deny (an intersection operand that is
  // false, an exclusion base that is false), which is itself
  // path-independent.
  //
  // A throw is simply never recorded, which is also how a
  // depth-exhausted subtree stays out: nothing is written, so the
  // same node resolves normally if it is reached again shallower.
  // Nothing in-flight is ever published, so unlike the store cache
  // there is no promise to evict and no rejection to swallow.
  if (!result.cycleDetected && (!memoized || depth > memoized.depth)) {
    memoSet(memo, request, { result, depth });
  }
  return result;
}

/**
 * The body of one node's resolution: steps 1-5, intersection, and
 * exclusion. Split out of `checkNode` so the cycle guard, the memo
 * lookup and the memo write bracket a single call.
 */
async function resolveNode(
  store: TupleStore,
  request: CheckRequest,
  maxDepth: number,
  maxBreadth: number,
  depth: number,
  visited: ReadonlySet<string>,
  memo: NodeMemo,
): Promise<CheckResult> {
  // Fetch relation config once for use across all steps — and
  // before the tuple reads, which are gated on it.
  //
  // The reads used to be started speculatively alongside this
  // fetch, to keep a node to one round-trip wave. Ordering them
  // costs far less than it looks: configs are cached for the whole
  // request and the cache coalesces concurrent misses, so a real
  // round-trip happens once per relation, not once per node. Every
  // node after the first for a given relation still issues one
  // wave, now a smaller one.
  const config = await store.findRelationConfig(
    request.objectType,
    request.relation,
  );

  // Some paths never await the batch (config error, or an
  // intersection without a direct operand); the derived catch
  // keeps such a rejection from going unhandled while awaiting
  // callers still see the error.
  const reads = readNodeTuples(store, request, config);
  reads.catch(() => {});

  // Base resolution: intersection replaces steps 1-5 when present
  const resolveBase = (): Promise<CheckResult> =>
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
          memo,
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
          memo,
        );

  // Exclusion applies on top of the base result — including on top
  // of intersection results. A definitive deny short-circuits past
  // a sibling error, matching OpenFGA: a base `false` denies even
  // when the exclusion branch errored, and a granted exclusion
  // branch denies even when the base errored. Errors otherwise
  // fail closed: a base grant with an errored exclusion branch
  // propagates the error rather than granting.
  //
  // The two sides read a cycle differently, and the asymmetry is
  // the whole reason indeterminacy is tracked rather than folded
  // into `false`. On the base side a cycle behaves like `false` —
  // nothing was established, so nothing is granted. On the
  // subtract side it behaves like `true` — the exclusion could not
  // be ruled out, so access is denied. Treating a cycle as a plain
  // `false` would grant `base:true butnot sub:cycle`, a fail-open.
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
        memo,
      ),
    ]);
    if (
      exclusionResult.status === "fulfilled" &&
      (exclusionResult.value.cycleDetected || exclusionResult.value.allowed)
    ) {
      return {
        allowed: false,
        cycleDetected: exclusionResult.value.cycleDetected,
      };
    }
    if (
      baseResult.status === "fulfilled" &&
      (baseResult.value.cycleDetected || !baseResult.value.allowed)
    ) {
      return { allowed: false, cycleDetected: baseResult.value.cycleDetected };
    }
    if (baseResult.status === "rejected") {
      throw baseResult.reason;
    }
    if (exclusionResult.status === "rejected") {
      throw exclusionResult.reason;
    }
    return GRANTED;
  }

  return resolveBase();
}

/**
 * Ask the store for the node's tuples — direct probe, wildcard
 * probe, userset scan — in one request, excluding any part the
 * relation config says cannot match.
 *
 * A part is excluded only when the config *positively rules it
 * out*. No config, or a config that declines to narrow the
 * relation (`directlyAssignableTypes: null`), asks for
 * everything. The gate is the same predicate the write path
 * applies, imported from `tuple-validation.ts` rather than
 * restated, so a tuple that can be written is always a tuple that
 * can be found.
 *
 * This mirrors upstream, which builds `checkDirect`'s three
 * handlers behind `shouldCheckDirectTuple`,
 * `shouldCheckPublicAssignable` and a non-empty
 * `DirectlyRelatedUsersets` (`internal/graph/check.go`). It is
 * narrower than upstream in one way, noted in the README: a
 * purely computed relation issues no reads at all there, whereas
 * tsfga encodes "purely computed" as the same `null` that means
 * "unrestricted", so it cannot tell the two apart.
 *
 * The gates are sent to the store so it can narrow its query, and
 * re-applied to its reply by `clampToQuery` so that narrowing
 * stays an optimization rather than a correctness dependency.
 */
async function readNodeTuples(
  store: TupleStore,
  request: CheckRequest,
  config: RelationConfig | null,
): Promise<CheckTuples> {
  const subjectRef = directSubjectRef(request.subjectType, request.subjectId);
  const wildcardRef = `${request.subjectType}:*`;

  const includeDirect = admitsDirectSubject(config, subjectRef);
  // Checking the wildcard subject itself makes the two probes the
  // same query, and `directSubjectRef` makes their gates agree
  // too. Ask once: `checkBase` reads the slots identically, so
  // folding it into `direct` loses nothing and saves a duplicate
  // condition evaluation.
  const includeWildcard =
    request.subjectId === "*"
      ? false
      : admitsDirectSubject(config, wildcardRef);
  const includeUsersets = admitsUsersetSubjects(config);

  // A relation that admits none of the three — say one that is
  // purely an intersection of rewrites — has nothing to ask for.
  // Skip the round-trip rather than send a query that cannot
  // match; the node still resolves through its rewrites.
  if (!includeDirect && !includeWildcard && !includeUsersets) {
    return NO_TUPLES;
  }

  const query: CheckTuplesQuery = {
    objectType: request.objectType,
    objectId: request.objectId,
    relation: request.relation,
    subjectType: request.subjectType,
    subjectId: request.subjectId,
    includeDirect,
    includeWildcard,
    includeUsersets,
  };
  return clampToQuery(await store.findCheckTuples(query), query);
}

/**
 * Stand-in for a node whose reads the config rules out entirely.
 * Never mutated, so aliasing it across nodes is safe.
 */
const NO_TUPLES: CheckTuples = { direct: null, wildcard: null, usersets: [] };

/**
 * Discard anything in a store's reply that the query did not ask
 * for, or that is filed under the wrong slot.
 *
 * Before the three reads were merged, the relation config's type
 * restrictions were enforced by *not making the call* — a tuple
 * the model forbids was unreachable because no code path looked
 * for it. Merging moved that enforcement into a flag on a request,
 * and a flag is only as good as the store honouring it. That
 * would make every adapter, including third-party ones, part of
 * the security boundary: a store that ignored `includeUsersets`
 * would hand back a userset row on a relation that forbids
 * usersets, and `checkBase` would expand it and grant. Silently.
 *
 * So the flags stay a hint and the guarantee moves back here.
 * Clamping is cheap, it is one place, and it makes the failure
 * direction closed: a store that over-returns loses rows rather
 * than smuggling them past the model. Upstream reaches the same
 * conclusion by a different route, filtering each handler's rows
 * through `validation.FilterInvalidTuples` after having already
 * chosen the handlers by type (`internal/graph/check.go`).
 *
 * A misfiled row is dropped rather than raised. There is no safe
 * reading of it, and a check is the wrong place to discover an
 * adapter bug — denying is the conservative answer, and the
 * adapter's own tests are where this should have been caught.
 */
function clampToQuery(
  reply: CheckTuples,
  query: CheckTuplesQuery,
): CheckTuples {
  const onNode = (tuple: Tuple): boolean =>
    tuple.objectType === query.objectType &&
    tuple.objectId === query.objectId &&
    tuple.relation === query.relation;

  // A probe answers for one subject with no subject relation; the
  // wildcard slot answers for `*` and nothing else.
  const isProbe = (tuple: Tuple | null, subjectId: string): boolean =>
    tuple !== null &&
    onNode(tuple) &&
    tuple.subjectType === query.subjectType &&
    tuple.subjectId === subjectId &&
    tuple.subjectRelation === null;

  // Usersets carry their own subject type — `team:eng#member` on a
  // `user` check — so only the node and the subject relation are
  // checkable here.
  const isUserset = (tuple: Tuple): boolean =>
    onNode(tuple) && tuple.subjectRelation !== null;

  let usersets: readonly Tuple[] = NO_TUPLES.usersets;
  if (query.includeUsersets) {
    // Reuse the reply's array when it is already clean, which is
    // every well-behaved store on every node.
    usersets = reply.usersets.every(isUserset)
      ? reply.usersets
      : reply.usersets.filter(isUserset);
  }

  return {
    direct:
      query.includeDirect && isProbe(reply.direct, query.subjectId)
        ? reply.direct
        : null,
    wildcard:
      query.includeWildcard && isProbe(reply.wildcard, "*")
        ? reply.wildcard
        : null,
    usersets,
  };
}

/**
 * A tuple's condition as a union branch. Condition evaluation can
 * only grant or deny — it never reaches another node, so it can
 * never be indeterminate.
 */
async function evaluateCondition(
  store: TupleStore,
  tuple: Tuple,
  context: Record<string, unknown> | undefined,
): Promise<CheckResult> {
  return (await evaluateTupleCondition(store, tuple, context))
    ? GRANTED
    : DENIED;
}

/**
 * Base check: steps 1-5 without exclusion or intersection handling.
 */
async function checkBase(
  store: TupleStore,
  request: CheckRequest,
  config: RelationConfig | null,
  reads: Promise<CheckTuples>,
  maxDepth: number,
  maxBreadth: number,
  depth: number,
  path: ReadonlySet<string>,
  memo: NodeMemo,
): Promise<CheckResult> {
  const {
    direct: directTuple,
    wildcard: wildcardTuple,
    usersets: usersetTuples,
  } = await reads;

  // Steps 1/1b: an unconditioned direct or wildcard hit answers
  // immediately, before any sub-check is launched
  if (directTuple && !directTuple.conditionName) {
    return GRANTED;
  }
  if (wildcardTuple && !wildcardTuple.conditionName) {
    return GRANTED;
  }

  // Collect all sub-check handlers for concurrent resolution
  const handlers: Array<() => Promise<CheckResult>> = [];

  // Conditioned direct/wildcard hits race as union branches so
  // their condition evaluation (a possible condition-definition
  // fetch) does not block the fanout below. Union semantics
  // apply: a sibling `true` beats a condition error.
  if (directTuple) {
    handlers.push(() => evaluateCondition(store, directTuple, request.context));
  }
  if (wildcardTuple) {
    handlers.push(() =>
      evaluateCondition(store, wildcardTuple, request.context),
    );
  }

  // Step 2: Userset expansion handlers. This moves to another
  // object, so it is a dispatch and costs one depth.
  for (const userset of usersetTuples) {
    if (!userset.subjectRelation) continue;
    const relation = userset.subjectRelation;
    handlers.push(async () => {
      if (!(await evaluateTupleCondition(store, userset, request.context))) {
        return DENIED;
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
        memo,
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
          memo,
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
        memo,
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
      const ttuHandlers: Array<() => Promise<CheckResult>> = [];
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
              memo,
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
  reads: Promise<CheckTuples>,
  maxDepth: number,
  maxBreadth: number,
  depth: number,
  path: ReadonlySet<string>,
  memo: NodeMemo,
): Promise<CheckResult> {
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

  const handlers: Array<() => Promise<CheckResult>> = [];

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
          memo,
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
          memo,
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
        const ttuHandlers: Array<() => Promise<CheckResult>> = [];
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
              memo,
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
 * on the first grant. A grant wins even when sibling branches
 * rejected (e.g. with DepthExceededError) or were truncated by a
 * cycle. When no handler grants, rejects with the first error if
 * any handler rejected; otherwise resolves `false`, flagged
 * indeterminate if any branch hit a cycle. Handlers still queued
 * when the union settles are never started.
 */
function resolveUnion(
  handlers: Array<() => Promise<CheckResult>>,
  maxBreadth: number,
): Promise<CheckResult> {
  return resolveShortCircuit(handlers, maxBreadth, UNION_REDUCER);
}

/**
 * Run handlers with at most `maxBreadth` in flight, short-circuit
 * on the first operand that fails to hold — a definitive false, or
 * a cycle-truncated operand, wins even when a sibling operand
 * errored, matching OpenFGA's intersection. Resolves true when all
 * operands hold. When none fails and at least one errored, rejects
 * with the first error (fail closed: an errored operand never
 * counts as satisfied). Handlers still queued when the
 * intersection settles are never started.
 */
function resolveIntersection(
  handlers: Array<() => Promise<CheckResult>>,
  maxBreadth: number,
): Promise<CheckResult> {
  return resolveShortCircuit(handlers, maxBreadth, INTERSECTION_REDUCER);
}

/**
 * Bounded pull-model combinator shared by union and intersection.
 * They are near-duals — union short-circuits on a grant and
 * resolves `false` on exhaustion, intersection short-circuits on a
 * non-grant and resolves `true` — but not exactly, because a
 * cycle-truncated branch decides an intersection and does not
 * decide a union. The `reducer` supplies that difference. Mirrors
 * OpenFGA's reducers, which take the breadth limit as their
 * concurrency bound.
 *
 * Handlers launch in array order while fewer than `maxBreadth` are
 * in flight; each settlement pulls the next queued handler. Once
 * the result is decided nothing new starts, in-flight losers are
 * ignored on completion, and their rejections are consumed by the
 * callbacks attached at launch — no unhandled rejections. On
 * exhaustion with no decisive result, one recorded error (the
 * first by completion order) propagates — errors outrank the
 * accumulated value, so a cycle-flagged `false` never masks a
 * failure. Which branch's error surfaces when several fail is
 * scheduling-dependent, as it is in OpenFGA (whose union keeps the
 * last-completed error instead).
 *
 * Exported for direct unit tests only; not part of the public
 * package API (not re-exported from index.ts).
 */
export function resolveShortCircuit(
  handlers: Array<() => Promise<CheckResult>>,
  maxBreadth: number,
  reducer: Reducer,
): Promise<CheckResult> {
  return new Promise((resolve, reject) => {
    let next = 0;
    let active = 0;
    let settled = false;
    let firstError: unknown;
    let hasError = false;
    let accumulated = reducer.initial;

    const settleExhausted = () => {
      settled = true;
      if (hasError) {
        reject(firstError);
      } else {
        resolve(accumulated);
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
        let branch: Promise<CheckResult>;
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
            const decided = reducer.decide(result);
            if (decided) {
              settled = true;
              resolve(decided);
              return;
            }
            accumulated = reducer.accumulate(accumulated, result);
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
