import { CachingTupleStore } from "./caching-store.ts";
import { evaluateTupleCondition } from "./conditions.ts";
import { ContextualTupleStore } from "./contextual-store.ts";
import { DepthExceededError, TsfgaError } from "./errors.ts";
import type { TupleStore } from "./store-interface.ts";
import {
  admittedRefsForShape,
  admittedUsersetRefs,
  directSubjectRef,
  refsAdmit,
  subjectShape,
  validateTupleWrite,
} from "./tuple-validation.ts";
import type {
  CheckOptions,
  CheckRequest,
  CheckTuples,
  CheckTuplesQuery,
  RelationConfig,
  Tuple,
  TypeRestriction,
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
 *
 * **The first failing operand decides, whichever kind it is.** The
 * two kinds are not interchangeable — the flag reaches an
 * enclosing exclusion, where a cycle denies and a plain `false`
 * does not — so which operand wins the race is visible in the
 * final answer. That is upstream's behaviour
 * (`internal/graph/check.go`, `intersection`: the outcome loop
 * short-circuits on `CycleDetected || !Allowed` and propagates
 * that outcome's flag), and matching it means racing as it races.
 *
 * Preferring the definitive `false` looks better and is wrong.
 * Upstream's answer tracks which operand is cheaper to resolve: a
 * cheap definitive operand and a cheap cycle give different
 * results, both reproducible. Always choosing the definitive one
 * matches upstream only when it happens to be the cheap one, and
 * diverges — fail-open, granting where OpenFGA denies — when it is
 * not. That was tried, and
 * `tests/conformance/intersection-cycle-precedence.test.ts` is the
 * fixture that caught it against the running container.
 *
 * The cost is that `maxBreadth` can change the boolean answer on a
 * model where a cycle reaches an intersection operand, since
 * breadth is what decides whether the operands race at all.
 * Upstream has the same exposure through its own concurrency
 * limit. Documented in the README rather than smoothed over.
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
type NodeMap<V> = MemoMap<MemoMap<MemoMap<MemoMap<MemoMap<V>>>>>;
type NodeMemo = NodeMap<MemoEntry>;

function nodeGet<V>(map: NodeMap<V>, request: CheckRequest): V | undefined {
  return map
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

function nodeSet<V>(map: NodeMap<V>, request: CheckRequest, value: V): void {
  const bySubjectId = memoLevel(map, request.subjectType);
  const byObjectType = memoLevel(bySubjectId, request.subjectId);
  const byObjectId = memoLevel(byObjectType, request.objectType);
  const byRelation = memoLevel(byObjectId, request.objectId);
  byRelation.set(request.relation, value);
}

/**
 * Drop a node's entry, but only while it is still the stored one —
 * a later resolution may already have replaced it
 * (`caching-store.ts` evicts on the same rule).
 */
function nodeDelete<V>(map: NodeMap<V>, request: CheckRequest, value: V): void {
  if (nodeGet(map, request) === value) {
    map
      .get(request.subjectType)
      ?.get(request.subjectId)
      ?.get(request.objectType)
      ?.get(request.objectId)
      ?.delete(request.relation);
  }
}

/**
 * A node whose resolution has started but not settled, and what
 * its subtree is currently blocked on.
 *
 * The settled memo only helps a route that arrives *after* another
 * route finished. At any breadth above 1 the routes overlap
 * instead, so without this every concurrent route into a shared
 * node re-resolves it and re-issues its reads: the DAG explored as
 * a tree, with breadth as the duplication multiplier.
 */
interface InflightEntry {
  readonly promise: Promise<CheckResult>;
  /** The depth the resolution started at; gates reuse, as in the memo. */
  readonly depth: number;
  readonly waits: WaitNode;
}

/**
 * One node's edge set in the wait graph: the in-flight entries its
 * subtree is currently awaiting.
 *
 * Counted rather than a plain set, because two branches of the same
 * node can await the same entry and the first to finish must not
 * erase the second's edge — a missing edge is a missed deadlock,
 * which is the one failure mode with no recovery.
 */
interface WaitNode {
  readonly waitingOn: Map<InflightEntry, number>;
}

function addWait(node: WaitNode, entry: InflightEntry): void {
  node.waitingOn.set(entry, (node.waitingOn.get(entry) ?? 0) + 1);
}

function removeWait(node: WaitNode, entry: InflightEntry): void {
  const count = node.waitingOn.get(entry) ?? 0;
  if (count > 1) {
    node.waitingOn.set(entry, count - 1);
  } else {
    node.waitingOn.delete(entry);
  }
}

/**
 * Would awaiting `entry` close a cycle in the wait graph — i.e. is
 * `waiter` already reachable from it?
 *
 * This is the whole reason coalescing is safe here when the obvious
 * version is not. Two sibling branches resolving mutually recursive
 * relations each reach the other's node: neither is on the other's
 * *path*, so the cycle guard says nothing, and each would await an
 * entry that can only settle once the other does. Adding an edge
 * only when it keeps the graph acyclic makes that unreachable, and
 * an acyclic wait graph cannot deadlock.
 *
 * The test and the edge insertion happen in one synchronous stretch
 * — nothing awaits between them — so there is no interleaving in
 * which two waiters each see the other's absence.
 */
function wouldDeadlock(entry: InflightEntry, waiter: WaitNode | null): boolean {
  if (!waiter) {
    // A root check registers no wait record: it is nobody's
    // callee, so nothing can be blocked behind it.
    return false;
  }
  const seen = new Set<WaitNode>();
  const stack: WaitNode[] = [entry.waits];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node || seen.has(node)) continue;
    if (node === waiter) return true;
    seen.add(node);
    for (const blocker of node.waitingOn.keys()) {
      stack.push(blocker.waits);
    }
  }
  return false;
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
 * It doubles as the resolution context every node is handed, which
 * is why it is threaded down instead of being unpacked into
 * positional parameters: `checkNode` would otherwise carry a
 * parameter per shared field, and every recursive call site would
 * have to repeat them in the right order.
 *
 * Internal. Not re-exported from `index.ts`.
 */
export interface CheckScope {
  readonly store: TupleStore;
  readonly maxDepth: number;
  readonly maxBreadth: number;
  readonly memo: NodeMemo;
  readonly inflight: NodeMap<InflightEntry>;
}

/**
 * What one call inherits from the call that made it, as opposed to
 * from the request (`CheckScope`) or from the node itself (request,
 * depth, path).
 *
 * It is an object rather than a parameter so that adding a concern
 * threaded through the whole recursion does not add a positional
 * parameter to `checkNode`, `resolveNode`, `checkBase` and
 * `checkIntersection` at once, plus one to every recursive call
 * site.
 */
interface Frame {
  /**
   * The wait record of the nearest enclosing node — null at the
   * root of a check. A blocked child records the block here,
   * because the thing that is actually stuck is the enclosing
   * node's resolution.
   */
  readonly waits: WaitNode | null;
  /** Whether anyone is still interested in this call's answer. */
  readonly branch: Branch;
}

/** The frame a check starts from: nothing is enclosing it. */
function rootFrame(): Frame {
  return { waits: null, branch: new Branch(null) };
}

/**
 * One branch of a set operator, and whether its answer is still
 * wanted.
 *
 * A union that has found its grant stops *launching* queued
 * branches, but the branches already in flight used to keep
 * walking: a subtree resolving reads nobody will ever look at,
 * against a store the caller believes it has finished with. On a
 * pooled connection that also holds the connection past the end of
 * the request that borrowed it.
 *
 * Abandonment is cooperative rather than an `AbortSignal` threaded
 * into `TupleStore`. It costs no change to the store contract and
 * no work for adapter authors; what it cannot do is call back a
 * read already handed to the store. So the read in flight when a
 * branch is abandoned still completes — everything after it does
 * not.
 *
 * Nesting is by parent link: abandoning a branch abandons every
 * branch opened underneath it, without having to find them.
 */
class Branch {
  private flag = false;

  constructor(private readonly parent: Branch | null) {}

  abandon(): void {
    this.flag = true;
  }

  get abandoned(): boolean {
    for (let branch: Branch | null = this; branch; branch = branch.parent) {
      if (branch.flag) return true;
    }
    return false;
  }
}

/**
 * Thrown by an abandoned branch instead of an answer.
 *
 * It is never seen by a caller: a branch is abandoned only by a
 * combinator that has already settled and therefore ignores what
 * its branches do next, and the root branch of a check is never
 * abandoned at all. The one other reader is a coalesced waiter,
 * whose fallback treats every rejection alike.
 *
 * Deliberately not a `TsfgaError`: it is not part of the error
 * surface and must never be mistaken for one.
 */
class BranchAbandoned extends Error {
  constructor() {
    super("check branch abandoned after the result was decided");
    this.name = "BranchAbandoned";
  }
}

/**
 * One branch of a set operator, as handed to the combinator. It
 * receives the branch it runs in so that anything it dispatches can
 * be abandoned with it; handlers that reach no further than a
 * condition evaluation ignore the argument.
 */
type Handler = (branch: Branch) => Promise<CheckResult>;

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
    // per model, but read at every node. A store that already
    // caches is passed through: `checkMany` builds a scope per
    // context group and they share one config cache, which a second
    // wrapper would silently split in two.
    store:
      store instanceof CachingTupleStore ? store : new CachingTupleStore(store),
    maxDepth: options.maxDepth ?? 25,
    maxBreadth,
    memo: new Map(),
    inflight: new Map(),
  };
}

/** Run one check in a scope. Internal; see `CheckScope`. */
export async function runCheck(
  scope: CheckScope,
  request: CheckRequest,
): Promise<boolean> {
  let resolution = scope;

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
    // These tuples exist for this request only, so results resolved
    // over them are not shareable — and results already in the
    // scope's memo were resolved over a graph missing them. Neither
    // direction is safe, so this request memoizes on its own.
    resolution = {
      ...scope,
      store: new ContextualTupleStore(scope.store, request.contextualTuples),
      memo: new Map(),
      inflight: new Map(),
    };
  }

  const result = await checkNode(
    resolution,
    request,
    0,
    new Set(),
    rootFrame(),
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
  scope: CheckScope,
  request: CheckRequest,
  depth: number,
  path: ReadonlySet<string>,
  frame: Frame,
): Promise<CheckResult> {
  const { maxDepth, memo } = scope;
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
  let memoized = nodeGet(memo, request);
  if (memoized && depth <= memoized.depth) {
    return memoized.result;
  }

  // Nothing settled: is this node already being resolved by another
  // route? Coalescing onto it is what keeps the DAG from being
  // walked as a tree at breadth > 1, and the same depth gate applies
  // for the same reason.
  //
  // Three outcomes send this call on to resolve the node itself.
  // Each duplicates work in a case that is rare, and none of them
  // can be wrong:
  //
  // - `wouldDeadlock` refuses the wait. The fresh resolution runs
  //   with *this* path, so the cycle guard truncates it and it
  //   terminates; each such fallback resolves with a strictly larger
  //   path, and the path is bounded by a finite relation set.
  // - The entry rejected. An error is not path-independent — a
  //   sibling truncated by a cycle can hide an error on one route
  //   and not on another, and the combinator drops the cycle flag
  //   when it rejects — so an error is no more adoptable than it is
  //   memoizable. It also covers depth exhaustion, where a shallower
  //   waiter must be free to succeed where the entry failed.
  // - The entry settled cycle-flagged, which is path-dependent by
  //   definition. The memo refuses to publish those; this refuses to
  //   consume them, which is the same rule from the other side.
  //   (Upstream's cached resolver draws the same line:
  //   "when the response indicates cycle detected ... we don't save
  //   the result", `internal/graph/cached_resolver.go`.)
  const pending = nodeGet(scope.inflight, request);
  if (
    pending &&
    depth <= pending.depth &&
    !wouldDeadlock(pending, frame.waits)
  ) {
    const waiter = frame.waits;
    if (waiter) addWait(waiter, pending);
    let coalesced: CheckResult | null = null;
    try {
      coalesced = await pending.promise;
    } catch {
      // Resolve it ourselves; see above.
    } finally {
      if (waiter) removeWait(waiter, pending);
    }
    if (coalesced && !coalesced.cycleDetected) {
      return coalesced;
    }
    // Time passed while waiting, and a third route may have settled
    // the node in it. Re-reading also keeps the "greatest depth
    // wins" comparison below honest.
    memoized = nodeGet(memo, request);
    if (memoized && depth <= memoized.depth) {
      return memoized.result;
    }
  }

  const visited = new Set(path);
  visited.add(key);

  // Publish only the first resolution of a node. A later one is a
  // fallback from the list above, so it is running with a path that
  // already truncated something; its answer is this route's answer
  // and nobody else should coalesce onto it.
  //
  // An unpublished resolution is also *transparent* in the wait
  // graph: it keeps the caller's wait record instead of opening one
  // of its own, so a block inside it is attributed to the nearest
  // enclosing published node. Give it its own record and that node
  // looks idle while its subtree is blocked, which is exactly the
  // edge a deadlock hides behind.
  const waits: WaitNode | null = nodeGet(scope.inflight, request)
    ? null
    : { waitingOn: new Map() };
  const resolution = resolveNode(
    scope,
    request,
    depth,
    visited,
    waits ? { waits, branch: frame.branch } : frame,
  );

  if (waits) {
    const entry: InflightEntry = { promise: resolution, depth, waits };
    nodeSet(scope.inflight, request, entry);
    // A node is blocked on the children it resolves itself exactly
    // as much as on the ones it coalesced onto, so both kinds of
    // dependency are edges. Recording only the coalesced ones would
    // leave a node looking idle while it awaits its own subtree,
    // and a later waiter would happily close the loop through it.
    const caller = frame.waits;
    if (caller) addWait(caller, entry);
    const retire = () => {
      nodeDelete(scope.inflight, request, entry);
      if (caller) removeWait(caller, entry);
    };
    // The derived promise consumes the rejection on its own copy;
    // the `await` below still sees it.
    resolution.then(retire, retire);
  }

  const result = await resolution;

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
  if (!result.cycleDetected && (!memoized || depth > memoized.depth)) {
    nodeSet(memo, request, { result, depth });
  }
  return result;
}

/**
 * The body of one node's resolution: steps 1-5, intersection, and
 * exclusion. Split out of `checkNode` so the cycle guard, the memo
 * lookup and the memo write bracket a single call.
 */
async function resolveNode(
  scope: CheckScope,
  request: CheckRequest,
  depth: number,
  visited: ReadonlySet<string>,
  frame: Frame,
): Promise<CheckResult> {
  const store = scope.store;
  // Nothing below this line is worth a round trip if the answer
  // this branch was going to contribute is already discarded.
  if (frame.branch.abandoned) {
    throw new BranchAbandoned();
  }

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
      ? checkIntersection(scope, request, config, reads, depth, visited, frame)
      : checkBase(scope, request, config, reads, depth, visited, frame);

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
        scope,
        { ...request, relation: excludedBy },
        depth,
        visited,
        frame,
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
 * out*. With no config there is nothing to narrow against, so
 * everything is asked for. The gate is the same predicate the
 * write path applies, imported from `tuple-validation.ts` rather
 * than restated, so a tuple that can be written is always a tuple
 * that can be found.
 *
 * This mirrors upstream, which builds `checkDirect`'s three
 * handlers behind `shouldCheckDirectTuple`,
 * `shouldCheckPublicAssignable` and a non-empty
 * `DirectlyRelatedUsersets` (`internal/graph/check.go`) — the
 * third of which is a list of `type#relation` references, not a
 * flag, so a relation admitting `team#member` never expands a
 * `team#owner` row.
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
  // Condition-blind, and it has to be: the gate decides what to
  // ask the store for, and a row's condition is on the row. So it
  // asks for every restriction of the right *shape* and lets
  // `clampToQuery` do the exact match once the rows are in hand.
  // Anything narrower would have to fetch conditioned and bare
  // rows separately.
  const directRefs = admittedRefsForShape(
    config,
    subjectShape(request.subjectType, request.subjectId, null),
  );
  // Checking the wildcard subject itself makes the two probes the
  // same query, and `subjectShape` folds `subjectId === "*"` into
  // the wildcard shape, so the direct slot already carries the
  // right restrictions. Ask once: `checkBase` reads the slots
  // identically, so folding it into `direct` loses nothing and
  // saves a duplicate condition evaluation.
  const wildcardRefs =
    request.subjectId === "*"
      ? []
      : admittedRefsForShape(config, {
          type: request.subjectType,
          wildcard: true,
        });
  const usersetRefs = admittedUsersetRefs(config);

  // A relation that admits none of the three — one that is purely
  // computed, or purely an intersection of rewrites — has nothing
  // to ask for. Skip the round-trip rather than send a query that
  // cannot match; the node still resolves through its rewrites.
  // `null` is *unrestricted*, not empty, so `null?.length === 0`
  // is correctly false and such a relation still reads.
  if (
    directRefs?.length === 0 &&
    wildcardRefs?.length === 0 &&
    usersetRefs?.length === 0
  ) {
    return NO_TUPLES;
  }

  const query: CheckTuplesQuery = {
    objectType: request.objectType,
    objectId: request.objectId,
    relation: request.relation,
    subjectType: request.subjectType,
    subjectId: request.subjectId,
    directRefs,
    wildcardRefs,
    usersetRefs,
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
 * the security boundary: a store that ignored `usersetRefs`
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

  /** The restriction this row would have to be admitted under. */
  const refOf = (tuple: Tuple): TypeRestriction =>
    directSubjectRef(
      tuple.subjectType,
      tuple.subjectId,
      tuple.subjectRelation,
      tuple.conditionName,
    );

  // A probe answers for one subject with no subject relation; the
  // wildcard slot answers for `*` and nothing else.
  //
  // The exact four-field match happens **here**, and the ordering
  // is externally observable rather than a matter of taste: a row
  // the model does not admit has to be dropped before anything
  // evaluates its condition, or a missing context parameter raises
  // where OpenFGA simply answers `false`.
  const isProbe = (
    tuple: Tuple | null,
    subjectId: string,
    refs: readonly TypeRestriction[] | null,
  ): boolean =>
    tuple !== null &&
    onNode(tuple) &&
    tuple.subjectType === query.subjectType &&
    tuple.subjectId === subjectId &&
    tuple.subjectRelation === null &&
    refsAdmit(refs, refOf(tuple));

  // Usersets carry their own subject type — `team:eng#member` on a
  // `user` check — so the subject type is not comparable to the
  // query's. What *is* checkable, and is the whole point of
  // carrying `usersetRefs`, is that the row's `type#relation` and
  // condition are ones the relation admits. This is the clamp that
  // closes T6: a store that hands back a `team#owner` row on a
  // relation admitting only `team#member`, or a conditioned row on
  // a relation admitting only the bare ref, loses it here rather
  // than having it expanded and granted.
  const isUserset = (tuple: Tuple): boolean =>
    onNode(tuple) &&
    tuple.subjectRelation !== null &&
    refsAdmit(query.usersetRefs, refOf(tuple));

  let usersets: readonly Tuple[] = NO_TUPLES.usersets;
  if (query.usersetRefs === null || query.usersetRefs.length > 0) {
    // Reuse the reply's array when it is already clean, which is
    // every well-behaved store on every node.
    usersets = reply.usersets.every(isUserset)
      ? reply.usersets
      : reply.usersets.filter(isUserset);
  }

  return {
    direct: isProbe(reply.direct, query.subjectId, query.directRefs)
      ? reply.direct
      : null,
    wildcard: isProbe(reply.wildcard, "*", query.wildcardRefs)
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
  scope: CheckScope,
  request: CheckRequest,
  config: RelationConfig | null,
  reads: Promise<CheckTuples>,
  depth: number,
  path: ReadonlySet<string>,
  frame: Frame,
): Promise<CheckResult> {
  const { store, maxBreadth } = scope;
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
  const handlers: Handler[] = [];

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
    handlers.push(async (branch) => {
      // The condition can cost a condition-definition fetch, so it
      // is behind the same gate as a node read.
      if (branch.abandoned) throw new BranchAbandoned();
      if (!(await evaluateTupleCondition(store, userset, request.context))) {
        return DENIED;
      }
      return checkNode(
        scope,
        {
          objectType: userset.subjectType,
          objectId: userset.subjectId,
          relation,
          subjectType: request.subjectType,
          subjectId: request.subjectId,
          context: request.context,
        },
        depth + 1,
        path,
        { waits: frame.waits, branch },
      );
    });
  }

  // Step 3: Relation inheritance (implied_by) handlers.
  // Same object, so no depth cost — see the depth-accounting note
  // on `check`.
  if (config?.impliedBy) {
    for (const impliedRelation of config.impliedBy) {
      handlers.push((branch) =>
        checkNode(
          scope,
          { ...request, relation: impliedRelation },
          depth,
          path,
          {
            waits: frame.waits,
            branch,
          },
        ),
      );
    }
  }

  // Step 4: Computed userset handler. Same object, no depth cost.
  if (config?.computedUserset) {
    const computedUserset = config.computedUserset;
    handlers.push((branch) =>
      checkNode(scope, { ...request, relation: computedUserset }, depth, path, {
        waits: frame.waits,
        branch,
      }),
    );
  }

  // Step 5: Tuple-to-userset composite handler. Like step 2 this
  // moves to another object, so each child costs one depth.
  if (config?.tupleToUserset) {
    const ttuEntries = config.tupleToUserset;
    handlers.push(async (branch) => {
      if (branch.abandoned) throw new BranchAbandoned();
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
      const ttuHandlers: Handler[] = [];
      for (const [i, { computedUserset }] of ttuEntries.entries()) {
        const linkedTuples = linkedResults[i] ?? [];
        for (const linked of linkedTuples) {
          ttuHandlers.push((child) =>
            checkNode(
              scope,
              {
                objectType: linked.subjectType,
                objectId: linked.subjectId,
                relation: computedUserset,
                subjectType: request.subjectType,
                subjectId: request.subjectId,
                context: request.context,
              },
              depth + 1,
              path,
              { waits: frame.waits, branch: child },
            ),
          );
        }
      }

      return resolveUnion(ttuHandlers, maxBreadth, branch);
    });
  }

  return resolveUnion(handlers, maxBreadth, frame.branch);
}

/**
 * Intersection check: ALL operands must be true.
 */
async function checkIntersection(
  scope: CheckScope,
  request: CheckRequest,
  config: RelationConfig,
  reads: Promise<CheckTuples>,
  depth: number,
  path: ReadonlySet<string>,
  frame: Frame,
): Promise<CheckResult> {
  const { store, maxBreadth } = scope;
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

  const handlers: Handler[] = [];

  for (const operand of operands) {
    if (operand.type === "direct") {
      handlers.push((branch) =>
        checkBase(scope, request, config, reads, depth, path, {
          waits: frame.waits,
          branch,
        }),
      );
    } else if (operand.type === "computedUserset") {
      // Same object, no depth cost — as with the other rewrites.
      handlers.push((branch) =>
        checkNode(
          scope,
          { ...request, relation: operand.relation },
          depth,
          path,
          {
            waits: frame.waits,
            branch,
          },
        ),
      );
    } else {
      // tupleToUserset operand
      handlers.push(async (branch) => {
        if (branch.abandoned) throw new BranchAbandoned();
        const linkedTuples = await store.findTuplesByRelation(
          request.objectType,
          request.objectId,
          operand.tupleset,
        );
        const ttuHandlers: Handler[] = [];
        for (const linked of linkedTuples) {
          ttuHandlers.push((child) =>
            checkNode(
              scope,
              {
                objectType: linked.subjectType,
                objectId: linked.subjectId,
                relation: operand.computedUserset,
                subjectType: request.subjectType,
                subjectId: request.subjectId,
                context: request.context,
              },
              depth + 1,
              path,
              { waits: frame.waits, branch: child },
            ),
          );
        }
        return resolveUnion(ttuHandlers, maxBreadth, branch);
      });
    }
  }

  return resolveIntersection(handlers, maxBreadth, frame.branch);
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
  handlers: Handler[],
  maxBreadth: number,
  parent: Branch,
): Promise<CheckResult> {
  return resolveShortCircuit(handlers, maxBreadth, UNION_REDUCER, parent);
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
  handlers: Handler[],
  maxBreadth: number,
  parent: Branch,
): Promise<CheckResult> {
  return resolveShortCircuit(
    handlers,
    maxBreadth,
    INTERSECTION_REDUCER,
    parent,
  );
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
 * Every launched handler gets a branch of its own, and settling
 * abandons all of them: a branch whose answer is no longer wanted
 * stops at its next checkpoint instead of walking its subtree and
 * reading a store the caller has already finished with. Abandoning
 * on exhaustion is a no-op — nothing is still running — so the one
 * call covers both exits.
 *
 * Exported for direct unit tests only; not part of the public
 * package API (not re-exported from index.ts).
 */
export function resolveShortCircuit(
  handlers: Handler[],
  maxBreadth: number,
  reducer: Reducer,
  parent: Branch = new Branch(null),
): Promise<CheckResult> {
  return new Promise((resolve, reject) => {
    let next = 0;
    let active = 0;
    let settled = false;
    let firstError: unknown;
    let hasError = false;
    let accumulated = reducer.initial;
    const launched: Branch[] = [];

    const abandonLosers = () => {
      for (const branch of launched) {
        branch.abandon();
      }
    };

    const settleExhausted = () => {
      settled = true;
      abandonLosers();
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
        const branch = new Branch(parent);
        launched.push(branch);
        let outcome: Promise<CheckResult>;
        try {
          outcome = handler(branch);
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
        outcome.then(
          (result) => {
            if (settled) return;
            const decided = reducer.decide(result);
            if (decided) {
              settled = true;
              abandonLosers();
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
