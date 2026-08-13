import { CachingTupleStore } from "./caching-store.ts";
import {
  evaluateTupleCondition,
  resolveMaxConditionEvaluationCost,
} from "./conditions.ts";
import { ContextualTupleStore } from "./contextual-store.ts";
import {
  DepthExceededError,
  InvalidSubjectTypeError,
  RelationConfigNotFoundError,
  TsfgaError,
} from "./errors.ts";
import type { TupleStore } from "./store-interface.ts";
import {
  admitsSubjectRef,
  admittedRefsForShape,
  admittedUsersetRefs,
  CHECK_OBJECT_RUNE_LIMIT,
  CHECK_SUBJECT_BYTE_LIMIT,
  directSubjectRef,
  refsAdmit,
  requestSubjectDefect,
  subjectShape,
  validateIdDomain,
  validateObjectRef,
  validateSubjectIdDomain,
  validateTupleWrite,
} from "./tuple-validation.ts";
import {
  createReachability,
  type Reachability,
  type SubjectRef,
} from "./type-graph.ts";
import type {
  AddTupleRequest,
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
 *
 * The subject's *relation* is a level of its own, and it is not
 * optional: `group:eng#member` and `group:eng` are different
 * subjects that answer differently, so leaving it out of the key
 * would hand one subject's answer back for the other's question the
 * moment a scope is shared — which `listObjects` and `checkMany`
 * both do by construction. It keys `null` directly rather than a
 * sentinel string, because a relation name is unconstrained and any
 * stand-in for "none" could be one.
 */
type MemoMap<V> = Map<string, V>;
type NodeMap<V> = Map<
  string | null,
  MemoMap<MemoMap<MemoMap<MemoMap<MemoMap<V>>>>>
>;
type NodeMemo = NodeMap<MemoEntry>;

function nodeGet<V>(map: NodeMap<V>, request: CheckRequest): V | undefined {
  return map
    .get(request.subjectRelation ?? null)
    ?.get(request.subjectType)
    ?.get(request.subjectId)
    ?.get(request.objectType)
    ?.get(request.objectId)
    ?.get(request.relation);
}

function memoLevel<K, V>(map: Map<K, MemoMap<V>>, key: K): MemoMap<V> {
  let level = map.get(key);
  if (!level) {
    level = new Map();
    map.set(key, level);
  }
  return level;
}

function nodeSet<V>(map: NodeMap<V>, request: CheckRequest, value: V): void {
  const bySubjectType = memoLevel(map, request.subjectRelation ?? null);
  const bySubjectId = memoLevel(bySubjectType, request.subjectType);
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
      .get(request.subjectRelation ?? null)
      ?.get(request.subjectType)
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
 * - Throws RelationConfigNotFoundError for a relation the model
 *   does not define, at any node — the requested relation or one
 *   a rewrite reaches. Upstream refuses the same request with an
 *   HTTP 400 validation error rather than answering `false`. The
 *   one exception is a tuple-to-userset's computed relation,
 *   which upstream skips per row rather than refusing.
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
 *   InvalidSubjectTypeError, InvalidConditionalTupleError).
 * - The request's own subject is validated first, before any of it
 *   is resolved: a subject the request cannot be asking about
 *   raises rather than resolving to `false`. See
 *   `validateCheckSubject`.
 *
 * The subject may be a **userset** — `request.subjectRelation` set
 * — which asks whether that whole userset holds the relation
 * rather than expanding it. See `CheckRequest` for the three
 * consequences that follow, and `checkBase` for where the ref is
 * matched.
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
 * Breadth changes the boolean result only where a cycle reaches
 * an intersection operand — INTERSECTION_REDUCER carries a cycled
 * operand's indeterminacy out with its denial, so which operand
 * wins the race can decide the answer one level up. Otherwise it
 * changes only which branch's error surfaces when several fail,
 * which depends on completion order — the same nondeterminism
 * OpenFGA has.
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
  /**
   * Resolved and validated once, then carried, so a whole
   * `listObjects` or `checkMany` cannot disagree with itself about
   * the budget and a bad value is refused before any store read.
   */
  readonly maxConditionEvaluationCost: number;
  readonly memo: NodeMemo;
  readonly inflight: NodeMap<InflightEntry>;
  /**
   * The model-shape prune, memoized for the life of the scope so a
   * whole `listObjects` or `checkMany` pays for each backward walk
   * once. Scope-lived rather than process-lived: a model that
   * changes between requests is then picked up.
   *
   * Deliberately built over the scope's *caching* store and kept
   * even when a request overlays contextual tuples: contextual
   * tuples are validated against the same relation configs, so they
   * cannot introduce an edge the model does not already admit.
   */
  readonly reachability: Reachability;
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

  const maxDepth = options.maxDepth ?? 25;
  // The same predicate, for the same reasons. `NaN` is the one
  // that matters here: `depth >= NaN` is false at every node, so a
  // caller who was trying to set a budget silently removes it, and
  // this file's contract says exhaustion must never resolve
  // `false`. A fraction admits one dispatch more than it states
  // (`depth >= 2.5` first holds at 3), and `0` — like a negative —
  // is a budget no check can ever run inside.
  if (
    !(maxDepth >= 1) ||
    (maxDepth !== Number.POSITIVE_INFINITY && !Number.isInteger(maxDepth))
  ) {
    throw new TsfgaError(
      `maxDepth must be a positive integer or Infinity, got ${maxDepth}`,
    );
  }

  // Cache for relation configs and condition definitions: static
  // per model, but read at every node. A store that already caches
  // is passed through: `checkMany` builds a scope per context group
  // and they share one config cache, which a second wrapper would
  // silently split in two.
  const caching =
    store instanceof CachingTupleStore ? store : new CachingTupleStore(store);

  // Validated in `conditions.ts`, which owns the option, so the
  // predicate lives beside the model it bounds. Called here so a
  // mistyped budget is a construction error like the other two,
  // rather than a surprise at the first conditioned row.
  const maxConditionEvaluationCost = resolveMaxConditionEvaluationCost(options);

  return {
    store: caching,
    maxDepth,
    maxBreadth,
    maxConditionEvaluationCost,
    memo: new Map(),
    inflight: new Map(),
    reachability: createReachability(caching, maxBreadth),
  };
}

/**
 * Contextual tuples must pass exactly the validation `addTuple`
 * applies, before any of them is read.
 *
 * Validated concurrently but reported in **tuple order**, not
 * completion order, so which error a caller sees does not depend
 * on which store read finished first.
 *
 * Shared with `listObjects`, which applies one overlay to a whole
 * call rather than one per check.
 */
export async function validateContextualTuples(
  store: TupleStore,
  tuples: readonly AddTupleRequest[],
): Promise<void> {
  const validations = await Promise.allSettled(
    tuples.map((tuple) => validateTupleWrite(store, tuple)),
  );
  for (const validation of validations) {
    if (validation.status === "rejected") {
      throw validation.reason;
    }
  }
}

/**
 * The subject fields a request must have for its subject to be
 * validated. Narrower than `CheckRequest` so `listObjects`, which
 * has no `objectId`, can be validated by the same function.
 */
interface SubjectRequest {
  readonly objectType: string;
  readonly relation: string;
  readonly subjectType: string;
  readonly subjectId: string;
  readonly subjectRelation?: string | null;
}

/**
 * Refuse a subject the request cannot be asking about, before any
 * of it is resolved.
 *
 * Upstream validates the `user` field at the command layer
 * (`validation.ValidateUser`) and answers a 400 rather than a
 * boolean, so a caller learns their request was not understood.
 * tsfga spells the subject as three fields instead of one string,
 * which removes most of the ways to malform it and adds one: a
 * caller forwarding an OpenFGA-shaped `user` has only `subjectId`
 * to put it in, and `subjectId: "eng#member"` used to resolve
 * quietly to `false`. A silent deny is the worst answer available
 * — it is indistinguishable from a real one — so the shapes below
 * raise.
 *
 * The subject **type** and, when one is given, the subject
 * **relation** are both required to be defined. Probed against
 * v1.18.2: a check for `group:eng#nonexistent` is refused with
 * `relation 'group#nonexistent' not found`, and one naming a type
 * the model does not define is refused with `type 'x' not found`.
 * The type is asked about first, because upstream reports it first
 * and a userset subject of an undefined type shows the difference.
 *
 * The type question needs `hasTypeDefinition`: a relation-config
 * lookup cannot answer it, since a type with no relations of its
 * own — the shape of nearly every subject type there is — has no
 * config at all and is defined by the restrictions that admit it.
 *
 * `allowed` is empty on the error rather than the relation's
 * restriction list: nothing has read a relation config at this
 * point, and upstream's refusal is likewise about the request
 * rather than about what the relation admits.
 */
export async function validateCheckSubject(
  store: TupleStore,
  request: SubjectRequest,
): Promise<void> {
  const subjectRelation = request.subjectRelation ?? null;
  const shape = subjectShape(
    request.subjectType,
    request.subjectId,
    subjectRelation,
  );
  // Explicitly typed so TypeScript treats it as never-returning.
  const refuse: (detail: string) => never = (detail) => {
    throw new InvalidSubjectTypeError(
      shape,
      request.objectType,
      request.relation,
      [],
      "malformed subject",
      detail,
    );
  };

  // Upstream's `userIDRegex` is `^[^:#\s\x00\p{Cc}]+$`, and the
  // whole of it applies: an empty id, a space, a control character
  // and the two separators are each a 400 rather than a boolean,
  // through the `CheckRequestTupleKey.User` proto pattern
  // (`^[^\s]{2,512}$`, which also carries the length bound) and
  // `IsValidUser` behind it.
  //
  // Only `:` and `#` were refused here at first, on the reading
  // that they are the characters that turn a mis-shaped request
  // into a plausible-looking denial. So do the others: a
  // trailing space or a stray `U+0001` in an id read from an
  // untrusted source matched no row, and a caller got `false` from
  // tsfga where upstream told them the request was not a question.
  // The predicate is the write path's, shared rather than
  // re-spelled, so the two gates cannot drift.
  const subjectDefect = requestSubjectDefect(
    request.subjectType,
    request.subjectId,
    subjectRelation,
    CHECK_SUBJECT_BYTE_LIMIT,
  );
  if (subjectDefect !== null) refuse(subjectDefect);

  if (subjectRelation !== null) {
    if (subjectRelation === "") {
      refuse("a subject relation may not be empty");
    }
    // `team:*#member` is not a userset, not a wildcard and not a
    // concrete subject — the check-path half of the same rule the
    // write path applies in `validateTupleWrite`.
    if (request.subjectId === "*") {
      refuse("a wildcard subject has no subject relation");
    }
  }

  // The last string rule, and the only one that is not upstream's:
  // an id upstream accepts and this store cannot hold. Ahead of
  // the model questions below and behind every request rule above,
  // which is where it sits on the write path too --
  // `validateIdDomain` says why.
  validateSubjectIdDomain(store, request.subjectType, request.subjectId);

  // The type itself must be one the model defines. Upstream reports
  // it here and nowhere else: `ValidateUser` runs `IsValidUser`
  // first (every refusal above), then `TypeNotFoundError` on the
  // `user` field's type, and only then resolves a userset's
  // relation — an order that is observable, since a userset subject
  // of an undefined type is refused for its *type*.
  //
  // Without it an undefined type was simply a type no row mentions,
  // so every read missed and the answer was a plain `false` — a
  // misspelled type reading exactly like a real denial. The
  // ordinary "this relation does not admit that type" refusal is a
  // different thing and keeps its own, causeless, error.
  if (!(await store.hasTypeDefinition(request.subjectType))) {
    throw new InvalidSubjectTypeError(
      shape,
      request.objectType,
      request.relation,
      [],
      "undefined subject type",
      `the model defines no type '${request.subjectType}'`,
    );
  }

  if (subjectRelation === null) return;

  const config = await store.findRelationConfig(
    request.subjectType,
    subjectRelation,
  );
  if (config === null) {
    throw new RelationConfigNotFoundError(request.subjectType, subjectRelation);
  }
}

/** Run one check in a scope. Internal; see `CheckScope`. */
export async function runCheck(
  scope: CheckScope,
  request: CheckRequest,
): Promise<boolean> {
  let resolution = scope;

  // The object first, and without a store read: upstream's
  // `ValidateUserObjectRelation` settles the request's own strings
  // before it looks anything up, and `ValidateObject` is the half
  // tsfga had only on the write path. An id the wire cannot carry
  // — empty, holding `:`, `#`, a space or a control character, the
  // typed wildcard, or past 256 code points rendered — is a
  // request upstream answers 400 to and tsfga answered `false` to,
  // having read no row because no row could match.
  //
  // `listObjects` does not run this and needs no exemption: it
  // names an object *type* and no id at all.
  validateObjectRef(
    request.objectType,
    request.objectId,
    CHECK_OBJECT_RUNE_LIMIT,
  );
  validateIdDomain(scope.store, "object", request.objectType, request.objectId);

  // Before the contextual tuples, which is upstream's order:
  // `validateCheckRequest` validates the request's own tuple key
  // and only then loops the contextual ones
  // (`pkg/server/commands/check_command.go:186-205`). The read this
  // costs goes through the scope's config cache, so a `checkMany`
  // or `listObjects` pays for it once.
  await validateCheckSubject(scope.store, request);

  // Wrap store with contextual tuples for the whole request.
  // Contextual tuples must pass the same validation as addTuple.
  if (request.contextualTuples?.length) {
    await validateContextualTuples(scope.store, request.contextualTuples);
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

  // A userset subject standing on its own node — is
  // `group:eng#member` a `member` of `group:eng`? — holds by
  // definition, whatever the model says. Upstream answers it in
  // `IsSelfDefining` between the cycle guard and `GetRelation`
  // (`internal/graph/check.go:433-437`), so the answer arrives
  // before the relation is looked up and before the type graph is
  // consulted: measured on v1.18.2, the check is `true` even where
  // the relation admits no userset at all and `PathExists` would
  // have pruned it.
  //
  // Unreachable while the subject relation is absent, which is
  // every request tsfga could express before it was added: a
  // relation name is never `null`.
  if (
    request.subjectRelation !== null &&
    request.subjectRelation !== undefined &&
    request.subjectRelation === request.relation &&
    request.subjectType === request.objectType &&
    request.subjectId === request.objectId
  ) {
    return GRANTED;
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
  // A relation the model does not define cannot be answered, and
  // upstream says so rather than answering `false`: `ResolveCheck`
  // fails with "relation '%s' undefined for object type '%s'" and
  // the server maps the request-level case to HTTP 400
  // `validation_error` (`internal/graph/check.go`).
  //
  // Reading the missing config as *unrestricted* was the fail-open
  // direction. The write path refuses such a tuple, so the only way
  // to have one is for the row to outlive its config — a deleted
  // config, an out-of-band writer, a partially applied fixture —
  // and that row was then narrowed against nothing and granted.
  if (config === null) {
    throw new RelationConfigNotFoundError(request.objectType, request.relation);
  }

  // The model-shape prune. Upstream consults the type graph at
  // **every** node, before resolving the rewrite:
  //
  //   hasPath, err := typesys.PathExists(user, relation, objectType)
  //   if !hasPath { return &ResolveCheckResponse{Allowed: false}, nil }
  //
  // Narrowing at the node it is standing on — this relation's own
  // `directlyAssignable` — is not the same question. `via_ring:
  // [ring#member]` admits the row it is holding; what it cannot
  // say is that `ring#member` takes its entrypoint from a type the
  // subject is not, so no subject of this type reaches the far end
  // whatever the data says. Walking that subtree anyway made
  // whatever it ran into the answer: an unevaluable condition, the
  // depth budget, or a cycle whose indeterminacy then *denied* on
  // the subtract side of a `but not` — the one of the three that is
  // wrong in the granting direction.
  //
  // Two properties of the returned value are load-bearing:
  //
  // - it is the **unflagged** `DENIED`, never `CYCLE`. The prune is
  //   a definitive answer read off the model, not a truncation, and
  //   an exclusion's subtrahend reads the two differently.
  // - it comes **after** the missing-config raise above, so a
  //   relation the model does not define is still refused rather
  //   than pruned to `false`.
  //
  // It sits before `readNodeTuples`, so a pruned node issues no
  // tuple read at all — the point of upstream's placement. The
  // synchronous form is tried first and answers for every node a
  // walk has already settled, which after the first check of a
  // scope is nearly all of them; only a genuinely cold node awaits.
  // That matters beyond speed: an extra await here reorders the
  // node's read against its siblings', and which branch of a union
  // reads first decides which one wins a race.
  //
  // A userset subject asks the question about its own ref:
  // upstream passes the whole `user` string to `PathExists`, which
  // walks from `team#member` rather than from `team` — and skips
  // the wildcard retry, since a userset can never be a wildcard
  // (`pkg/typesystem/typesystem.go:708-729`).
  const subject: SubjectRef =
    request.subjectRelation === null || request.subjectRelation === undefined
      ? { type: request.subjectType }
      : { type: request.subjectType, relation: request.subjectRelation };
  let reachable = scope.reachability.settledReaches(
    subject,
    request.objectType,
    request.relation,
  );
  if (reachable === undefined) {
    reachable = await scope.reachability.reaches(
      subject,
      request.objectType,
      request.relation,
    );
    // A cold walk is an await a sibling branch can win inside, so
    // the abandonment checkpoint is re-taken on the way out.
    if (frame.branch.abandoned) {
      throw new BranchAbandoned();
    }
  }
  if (!reachable) {
    return DENIED;
  }

  // Some paths never await the batch (config error, or an
  // intersection without a direct operand); the derived catch
  // keeps such a rejection from going unhandled while awaiting
  // callers still see the error.
  const reads = readNodeTuples(store, request, config);
  reads.catch(() => {});

  // Base resolution: intersection replaces steps 1-5 when present
  const resolveBase = (): Promise<CheckResult> =>
    config.intersection
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
  if (config.excludedBy) {
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
  config: RelationConfig,
): Promise<CheckTuples> {
  // Condition-blind, and it has to be: the gate decides what to
  // ask the store for, and a row's condition is on the row. So it
  // asks for every restriction of the right *shape* and lets
  // `clampToQuery` do the exact match once the rows are in hand.
  // Anything narrower would have to fetch conditioned and bare
  // rows separately.
  //
  // Both probes are for a subject with no subject relation, so a
  // **userset** subject excludes them outright rather than
  // narrowing them. Upstream reaches the same two exclusions
  // separately: `shouldCheckPublicAssignable` returns false the
  // moment the user is an object-relation, and its direct read is
  // for the exact `type:id#relation` ref, which is a row the
  // userset scan already returns. `checkBase` picks that row out of
  // the scan, so nothing is lost by not asking for it twice —
  // asking would mean a `subjectRelation` on `CheckTuplesQuery`
  // that every store had to honour to be correct, when the clamp
  // can do the same match on rows already in hand.
  const subjectRelation = request.subjectRelation ?? null;
  const directRefs =
    subjectRelation === null
      ? admittedRefsForShape(
          config,
          subjectShape(request.subjectType, request.subjectId, null),
        )
      : [];
  // Checking the wildcard subject itself makes the two probes the
  // same query, and `subjectShape` folds `subjectId === "*"` into
  // the wildcard shape, so the direct slot already carries the
  // right restrictions. Ask once: `checkBase` reads the slots
  // identically, so folding it into `direct` loses nothing and
  // saves a duplicate condition evaluation.
  const wildcardRefs =
    subjectRelation !== null || request.subjectId === "*"
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
  // Every one of the three is a real list now, so `[]` here means
  // the config positively admits nothing rather than that nobody
  // said.
  if (
    directRefs.length === 0 &&
    wildcardRefs.length === 0 &&
    usersetRefs.length === 0
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
const NO_TUPLES: CheckTuples = { direct: null, wildcard: [], usersets: [] };

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

  // A row whose subject relation is absent rather than null means
  // the same thing — no subject relation — and must be read that
  // way. Testing `=== null` alone sorts an `undefined` into
  // neither the probe slots nor, usefully, the userset slot: it
  // passes `!== null`, is filed as a userset, and is then dropped
  // by `checkBase`'s falsy guard, so the same row grants with
  // `null` and denies with `undefined`, silently.
  const relationOf = (tuple: Tuple): string | null =>
    tuple.subjectRelation ?? null;

  /** The restriction this row would have to be admitted under. */
  const refOf = (tuple: Tuple): TypeRestriction =>
    directSubjectRef(
      tuple.subjectType,
      tuple.subjectId,
      relationOf(tuple),
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
    relationOf(tuple) === null &&
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
  //
  // A wildcard is a subject *shape*, not an id, so a wildcard
  // carrying a subject relation — `team:*#member` — is a row no
  // legal model has, and `subjectShape` folds `"*"` into the
  // wildcard shape only when there is no subject relation. Left
  // in, it would be offered to this gate as the ordinary ref
  // `team#member` and `checkBase` would dispatch onto object id
  // `"*"`. The guard sits beside `relationOf(tuple) !== null`, so
  // a legitimate direct `user:*` row is untouched.
  const isUserset = (tuple: Tuple): boolean =>
    onNode(tuple) &&
    relationOf(tuple) !== null &&
    tuple.subjectId !== "*" &&
    refsAdmit(query.usersetRefs, refOf(tuple));

  let usersets: readonly Tuple[] = NO_TUPLES.usersets;
  if (query.usersetRefs === null || query.usersetRefs.length > 0) {
    // Reuse the reply's array when it is already clean, which is
    // every well-behaved store on every node.
    usersets = reply.usersets.every(isUserset)
      ? reply.usersets
      : reply.usersets.filter(isUserset);
  }

  // Every element, not the first one. The wildcard slot became a
  // list so a contextual row can join a stored one instead of
  // replacing it, and the clamp is the reason that shape is not a
  // way in: each row is matched against the same four fields the
  // single slot was, so a row the model does not admit is dropped
  // however it arrived.
  const isWildcard = (tuple: Tuple): boolean =>
    isProbe(tuple, "*", query.wildcardRefs);
  let wildcard: readonly Tuple[] = NO_TUPLES.wildcard;
  if (query.wildcardRefs === null || query.wildcardRefs.length > 0) {
    wildcard = reply.wildcard.every(isWildcard)
      ? reply.wildcard
      : reply.wildcard.filter(isWildcard);
  }

  return {
    direct: isProbe(reply.direct, query.subjectId, query.directRefs)
      ? reply.direct
      : null,
    wildcard,
    usersets,
  };
}

/**
 * A tuple's condition as a union branch. Condition evaluation can
 * only grant or deny — it never reaches another node, so it can
 * never be indeterminate.
 */
async function evaluateCondition(
  scope: CheckScope,
  tuple: Tuple,
  context: Record<string, unknown> | undefined,
): Promise<CheckResult> {
  const held = await evaluateTupleCondition(scope.store, tuple, context, {
    maxConditionEvaluationCost: scope.maxConditionEvaluationCost,
  });
  return held ? GRANTED : DENIED;
}

/**
 * Base check: steps 1-5 without exclusion or intersection handling.
 */
async function checkBase(
  scope: CheckScope,
  request: CheckRequest,
  config: RelationConfig,
  reads: Promise<CheckTuples>,
  depth: number,
  path: ReadonlySet<string>,
  frame: Frame,
): Promise<CheckResult> {
  const { store, maxBreadth } = scope;
  const {
    direct: directTuple,
    wildcard: wildcardTuples,
    usersets: usersetTuples,
  } = await reads;

  // The userset row that *is* the subject, when the subject is a
  // userset: `doc:1#viewer@group:eng#member` answering a check for
  // `group:eng#member`.
  //
  // It is a direct hit, not a hop. Upstream finds the same row
  // through `checkDirectUserTuple` — gated by
  // `shouldCheckDirectTuple`, which builds the source ref out of
  // the user's own type *and relation*, so it is exactly the
  // userset restriction — and answers at this node's depth.
  // Reaching it only through the userset scan's dispatch would
  // still grant, via the self-defining rule one level down, but it
  // would cost a depth the model does not spend and evaluate the
  // row's condition twice.
  const subjectRelation = request.subjectRelation ?? null;
  const selfTuple =
    subjectRelation === null
      ? null
      : (usersetTuples.find(
          (tuple) =>
            tuple.subjectType === request.subjectType &&
            tuple.subjectId === request.subjectId &&
            tuple.subjectRelation === subjectRelation,
        ) ?? null);

  // Steps 1/1b: an unconditioned direct or wildcard hit answers
  // immediately, before any sub-check is launched
  if (directTuple && !directTuple.conditionName) {
    return GRANTED;
  }
  // Any unconditioned wildcard row answers, whichever it is: the
  // rows are a union, so one that grants outright ends the node.
  if (wildcardTuples.some((tuple) => !tuple.conditionName)) {
    return GRANTED;
  }
  if (selfTuple && !selfTuple.conditionName) {
    return GRANTED;
  }

  // Collect all sub-check handlers for concurrent resolution
  const handlers: Handler[] = [];

  // Conditioned direct/wildcard hits race as union branches so
  // their condition evaluation (a possible condition-definition
  // fetch) does not block the fanout below. Union semantics
  // apply: a sibling `true` beats a condition error.
  if (directTuple) {
    handlers.push(() => evaluateCondition(scope, directTuple, request.context));
  }
  // One branch per conditioned wildcard row. They race as siblings
  // of a union, so a stored row whose condition holds still grants
  // when a contextual row on the same key does not — which is the
  // whole point of carrying a list: the contextual row joins the
  // stored one, it does not stand in for it.
  for (const wildcardTuple of wildcardTuples) {
    handlers.push(() =>
      evaluateCondition(scope, wildcardTuple, request.context),
    );
  }
  // Its own branch, outside the userset stash below: upstream reads
  // it separately from the userset scan, so its condition error
  // carries its own decision rather than being weighed against the
  // scan's other rows.
  if (selfTuple) {
    handlers.push(() => evaluateCondition(scope, selfTuple, request.context));
  }

  // Step 2: Userset expansion handlers. This moves to another
  // object, so it is a dispatch and costs one depth.
  //
  // The userset rows are one read upstream, so they share one
  // swallow decision — see `raiseUnlessOneHeld`. The scope is the
  // rows of this read and no wider: measured on v1.18.2, a broken
  // *direct* row beside a userset row whose condition held is still
  // a refusal, because the direct row is read separately and
  // carries its own decision.
  const usersetStash: ErrorStash = { error: null };
  let usersetHeld = false;
  for (const userset of usersetTuples) {
    if (!userset.subjectRelation) continue;
    // Already answered above, at this node's depth. Dispatching it
    // as well would resolve the same row a second time.
    if (userset === selfTuple) continue;
    const relation = userset.subjectRelation;
    handlers.push(async (branch) => {
      // The condition can cost a condition-definition fetch, so it
      // is behind the same gate as a node read.
      if (branch.abandoned) throw new BranchAbandoned();
      let held: boolean;
      try {
        held = await evaluateTupleCondition(store, userset, request.context, {
          maxConditionEvaluationCost: scope.maxConditionEvaluationCost,
        });
      } catch (error) {
        // Held, not raised: whether it becomes the answer depends
        // on what the sibling rows do, which is not known yet.
        //
        // A userset row does not name the request subject — the
        // subject reaches it, if at all, through the object it
        // points at — so `listObjects` may defer it. See
        // `onSubjectRow`. The `selfTuple` row, which *is* the
        // subject, is answered above and never reaches here.
        markScanReadError(error);
        stashError(usersetStash, error);
        return DENIED;
      }
      if (!held) {
        return DENIED;
      }
      usersetHeld = true;
      return checkNode(
        scope,
        {
          objectType: userset.subjectType,
          objectId: userset.subjectId,
          relation,
          subjectType: request.subjectType,
          subjectId: request.subjectId,
          subjectRelation: request.subjectRelation,
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
  if (config.impliedBy) {
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
  if (config.computedUserset) {
    const computedUserset = config.computedUserset;
    handlers.push((branch) =>
      checkNode(scope, { ...request, relation: computedUserset }, depth, path, {
        waits: frame.waits,
        branch,
      }),
    );
  }

  // Step 5: Tuple-to-userset. Like step 2 this moves to another
  // object, so each child costs one depth.
  //
  // **One handler per entry, not one for the array.** Upstream
  // turns every child of a union into its own `CheckHandlerFunc`
  // and `checkTTU` is one such child (`internal/graph/check.go`),
  // so a `viewer from parent or viewer from owner` relation is two
  // union branches. Batching the arms behind a single handler put
  // their tupleset reads in one `Promise.all`: an arm whose
  // tupleset rows carried an unevaluable condition rejected before
  // any arm's dispatches were built, so it sank the arm beside it
  // that granted. Now an arm's raise is just one branch's raise —
  // a sibling grant wins, and the error propagates only when
  // nothing granted.
  //
  // `raiseUnlessOneHeld` stays scoped to one tupleset read inside
  // `resolveTupleset`, which is exactly upstream's
  // `ConditionsFilteredTupleKeyIterator` scope: per `checkTTU`
  // call, not per relation.
  if (config.tupleToUserset) {
    for (const { tupleset, computedUserset } of config.tupleToUserset) {
      handlers.push(async (branch) => {
        if (branch.abandoned) throw new BranchAbandoned();
        // Only the rows this arm's tupleset relation admits whose
        // condition holds.
        const linkedTuples = await resolveTupleset(
          scope,
          request,
          tupleset,
          computedUserset,
        );

        const ttuHandlers: Handler[] = [];
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
                subjectRelation: request.subjectRelation,
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

  // A rejection from any other handler still wins: `resolveUnion`
  // raises it and the stash is never consulted, which is what makes
  // the direct row's own error survive a userset row that held.
  const result = await resolveUnion(handlers, maxBreadth, frame.branch);
  raiseUnlessOneHeld(usersetStash, result.allowed || usersetHeld);
  return result;
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
  const { maxBreadth } = scope;
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
        const linkedTuples = await resolveTupleset(
          scope,
          request,
          operand.tupleset,
          operand.computedUserset,
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
                subjectRelation: request.subjectRelation,
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
 * The tupleset rows a tuple-to-userset may expand through.
 *
 * A tupleset row is a tuple like any other, so two things gate it
 * and neither was applied:
 *
 * - **its condition.** `define parent: [folder with flag]` means
 *   the link exists only while `flag` holds, so dispatching on the
 *   row without evaluating its condition grants through a link the
 *   model has switched off. Probed against v1.18.2: upstream
 *   answers `false` when the condition fails.
 * - **the tupleset relation's own type restriction.** The row is
 *   read by relation alone, so nothing else narrows it to the
 *   subject types that relation admits.
 *
 * Factored out because there are **two** call sites — step 5's
 * plain tuple-to-userset and `checkIntersection`'s
 * `tupleToUserset` operand — and a fix applied to only the first
 * leaves the second granting. The second is the worse of the two:
 * an intersection operand satisfied through a switched-off link,
 * inside the subtrahend of an exclusion, grants rather than denies.
 *
 * A third gate is the `computedUserset`, and it is the one place a
 * relation with no config is *not* an error. Upstream accepts a
 * model whose tupleset admits several types when **at least one**
 * of them defines the computed relation
 * (`isUsersetRewriteValid`), and then drops the rows whose type
 * does not, one by one, as it produces the dispatches
 * (`produceTTUDispatches`). So `parent: [folder, org]` with
 * `viewer from parent` is a legal model in which an `org` row
 * simply contributes nothing. Raising here instead would answer a
 * refusal where upstream answers `false` — the fail-closed
 * mirror-image of the fail-open this gate exists to remove.
 */
async function resolveTupleset(
  scope: CheckScope,
  request: CheckRequest,
  tupleset: string,
  computedUserset: string,
): Promise<Tuple[]> {
  const { store } = scope;
  const [linked, config] = await Promise.all([
    store.findTuplesByRelation(request.objectType, request.objectId, tupleset),
    store.findRelationConfig(request.objectType, tupleset),
  ]);
  // The tupleset relation itself is a relation of *this* object,
  // and upstream requires it to be defined for the model to be
  // written at all. A missing config is a broken model rather than
  // a row to skip, so it raises like any other node's would.
  if (config === null) {
    throw new RelationConfigNotFoundError(request.objectType, tupleset);
  }

  // The store's reply is a hint here too. `clampToQuery` re-applies
  // the exact node match to `findCheckTuples`; this read had only
  // the subject-shape half of the same guarantee, so an adapter
  // whose `WHERE` lost `object_id` or `relation` handed back a row
  // linking a *different* document to a folder and this dispatch
  // granted on it. The three fields are the ones `onNode` spells,
  // and the drop is silent for the reason given there: a check is
  // the wrong place to discover an adapter bug, and denying is the
  // conservative answer.
  //
  // The subject half is the same call. A dispatch target must be
  // an *object*: a userset row would have its subject relation
  // discarded and land on a different relation of the linked
  // object, and a wildcard row names no object at all — the
  // dispatch would ask for object id `"*"`, which an opaque store
  // answers `false` and a store holding its ids in a `uuid` column
  // answers with a driver error. `config-validation.ts` refuses
  // both shapes at model write, but only against the tupleset
  // config that exists when the TTU is written, so widening the
  // tupleset afterwards leaves the row reachable. Dropping is the
  // right answer rather than raising: upstream refuses the model
  // and so never reaches this state, and every store then agrees
  // on `false`.
  //
  // `?? null` and not `=== null`: a store may hand back
  // `undefined`, which `relationOf` in `clampToQuery` normalises
  // for exactly this reason, and `=== null` here would drop every
  // tupleset row from such a store and answer `false` for every
  // tuple-to-userset.
  const onNode = linked.filter(
    (tuple) =>
      tuple.objectType === request.objectType &&
      tuple.objectId === request.objectId &&
      tuple.relation === tupleset &&
      (tuple.subjectRelation ?? null) === null &&
      tuple.subjectId !== "*",
  );

  const admitted = onNode.filter((tuple) =>
    admitsSubjectRef(
      config,
      directSubjectRef(
        tuple.subjectType,
        tuple.subjectId,
        tuple.subjectRelation,
        tuple.conditionName,
      ),
    ),
  );

  // Sequential rather than concurrent: a condition evaluation can
  // throw, and `Promise.all` would surface whichever rejected
  // first rather than the first row in order — the same
  // determinism the union handlers keep.
  const satisfied: Tuple[] = [];
  const stash: ErrorStash = { error: null };
  for (const tuple of admitted) {
    try {
      const held = await evaluateTupleCondition(store, tuple, request.context, {
        maxConditionEvaluationCost: scope.maxConditionEvaluationCost,
      });
      if (held) {
        satisfied.push(tuple);
      }
    } catch (error) {
      // A tupleset row names the linked object, not the request
      // subject, so `listObjects` may defer it — `onSubjectRow`.
      markScanReadError(error);
      stashError(stash, error);
    }
  }
  raiseUnlessOneHeld(stash, satisfied.length > 0);

  // Skipped last, after the conditions have been evaluated, which
  // is upstream's order: the condition filter sits in the iterator
  // and the skip happens as each row is turned into a dispatch, so
  // a row that is about to be skipped still contributes its
  // condition error — and still counts as a row that held.
  const types = [...new Set(satisfied.map((tuple) => tuple.subjectType))];
  const defined = new Set<string>();
  await Promise.all(
    types.map(async (type) => {
      if (await store.findRelationConfig(type, computedUserset)) {
        defined.add(type);
      }
    }),
  );
  return satisfied.filter((tuple) => defined.has(tuple.subjectType));
}

/**
 * The first condition-evaluation error a set of sibling rows
 * produced, held until the set is known to have produced nothing.
 */
interface ErrorStash {
  error: { readonly cause: unknown } | null;
}

/** Keep the first error only, so the raised one is deterministic. */
function stashError(stash: ErrorStash, error: unknown): void {
  if (!stash.error) stash.error = { cause: error };
}

/**
 * Condition errors raised on a read that does **not** name the
 * request subject — a userset scan, a tupleset scan.
 *
 * A `WeakSet` rather than a field because the error classes live in
 * `errors.ts` and this is not a property of the error, it is a
 * property of the read that produced it: the same
 * `ConditionEvaluationError` message can come from either side.
 * Entries die with the error object.
 */
const scanReadConditionErrors = new WeakSet<object>();

/** Record that this error came from a scan read, not a subject row. */
function markScanReadError(error: unknown): void {
  if (typeof error === "object" && error !== null) {
    scanReadConditionErrors.add(error);
  }
}

/**
 * Whether a check error was raised while reading a row that names
 * the **request subject** — `findCheckTuples`' direct row, its
 * `subjectType:*` wildcard row, and the userset row that *is* the
 * subject.
 *
 * `listObjects` needs the distinction and cannot see it: an error
 * carries a condition name and a cause and nothing about the read
 * behind it. Upstream reverse-expands from the subject and its
 * first query is exactly "rows whose subject is this subject on
 * this relation", so it always evaluates those conditions — an
 * error on one of them is one upstream raises too, and the call
 * must abort. An error on any other read is one upstream may never
 * have materialised, and deferring it is the approximation
 * `listObjects` makes.
 *
 * **True is the abort side and true is the default.** Only the scan
 * sites in this module mark themselves, so an error from anywhere
 * else — an adapter, a future read, an error class nobody
 * considered — keeps today's behaviour of aborting the call.
 */
export function onSubjectRow(error: unknown): boolean {
  return !(
    typeof error === "object" &&
    error !== null &&
    scanReadConditionErrors.has(error)
  );
}

/**
 * Raise a stashed condition error unless some sibling row's
 * condition evaluated **true**.
 *
 * OpenFGA reads a set of sibling rows through a
 * `ConditionsFilteredTupleKeyIterator`, which stashes the first
 * evaluation error and returns it at the end of the iterator only
 * if `onceValid` was never set — and `onceValid` is set on the path
 * where the filter returned `(true, nil)`, i.e. where a row's
 * condition **held**.
 *
 * So the predicate is "some condition was satisfied", not "some row
 * was admitted". The looser reading answers `false` for a broken
 * row beside a condition-*false* row, where upstream refuses to
 * answer at all; measured on v1.18.2, both on a tupleset relation
 * and on a userset scan.
 *
 * Ref: https://github.com/openfga/openfga/blob/560d5d3dd46b5adda9ecfb29efeb4f4f70c96327/pkg/storage/tuple_iterators.go
 */
function raiseUnlessOneHeld(stash: ErrorStash, oneHeld: boolean): void {
  if (stash.error && !oneHeld) {
    throw stash.error.cause;
  }
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
