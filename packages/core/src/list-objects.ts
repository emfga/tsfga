import {
  createCheckScope,
  onSubjectRow,
  runCheck,
  validateCheckSubject,
  validateContextualTuples,
} from "./check.ts";
import { ContextualTupleStore } from "./contextual-store.ts";
import {
  ConditionEvaluationError,
  DepthExceededError,
  RelationConfigNotFoundError,
  TsfgaError,
} from "./errors.ts";
import type { TupleStore } from "./store-interface.ts";
import type { CheckOptions, ListObjectsRequest } from "./types.ts";

/**
 * List object IDs of a type for which the subject passes a full
 * check.
 *
 * Candidates come from `listCandidateObjectIds` (a pre-filter —
 * every candidate is still checked). All of them are checked in
 * one `CheckScope`, so the relation-config cache and the node memo
 * span the whole call: the shared subtree behind N documents is
 * resolved once rather than N times.
 *
 * Concurrency is bounded by `maxBreadth`. That is the same knob as
 * per-node branch fanout by design, not by accident: upstream
 * sizes its ListObjects worker pool at
 * `1 + resolveNodeBreadthLimit` and hands the same limit down to
 * the reverse-expand query
 * (`pkg/server/commands/list_objects.go`).
 *
 * The target relation is gated up front, before the candidate
 * pool is read, so an undefined relation is refused whether or not
 * any row happens to name an object of that type. Upstream orders
 * the same two gates this way — contextual tuples first, then
 * `GetRelation` on the target
 * (`pkg/server/commands/list_objects.go`) — and the order is
 * observable, so it is kept. The subject is gated third, after
 * both.
 *
 * The subject may be a userset (`request.subjectRelation`), and
 * then the objects returned are the ones that whole userset
 * reaches — not the ones its members reach. See `CheckRequest`.
 *
 * Errors: the first failing candidate *in candidate order* is
 * thrown, not the first to fail in wall-clock order — no candidate
 * after a failure is started, but every candidate before one is
 * awaited, so the error a broken model produces is reproducible.
 *
 * Two error classes are exceptions to that rule, and they are
 * exceptions in different ways.
 *
 * A `ConditionEvaluationError` refuses the call **only** when it
 * was raised on a read naming the request subject, which is what
 * `check.ts`'s `onSubjectRow` predicate records. An error on any
 * other read is **dropped**: the candidate counts as `false` and
 * the call answers with the granted set, which may be empty.
 *
 * The split is the whole point, and it is not a heuristic.
 * Upstream reverse-expands `ListObjects` from the subject, and the
 * first query it issues is for the rows whose subject *is* the
 * request subject on that relation. So a condition on such a row
 * is one upstream always evaluates too: an error there refuses on
 * both engines, and dropping it would answer where upstream
 * refuses. That is `findCheckTuples`' direct row and its
 * `subjectType:*` wildcard row, and those abort here exactly as
 * any other error does.
 *
 * Every other read — a tupleset scan, a userset scan — sits behind
 * at least one hop, and upstream materialises it only if some path
 * from the subject leads there. tsfga checks every candidate
 * forward and cannot know, so it drops it: a tuple hanging off an
 * object the subject reaches nothing through must not cost the
 * whole answer.
 *
 * "Raise it after all if nothing was granted" was the earlier
 * shape of this rule and it is gone, because an empty granted set
 * is not evidence that the erroring row was on the subject's path
 * — a subject who reaches nothing grants nothing for reasons that
 * have nothing to do with the condition. The residue runs the
 * other way: where upstream's reverse expansion *does* reach such
 * a row it refuses the whole call and this returns the partial
 * list. That is a documented divergence in the under-reporting
 * direction; nothing is granted that a full check does not grant.
 * Separating the two would need reverse reachability over the
 * data, which tsfga has at the model level only.
 *
 * The read-scoped rule inside `check.ts` — `raiseUnlessOneHeld`,
 * a read whose row conditions threw raises only if no row's
 * condition held — is untouched by any of this, so per-object
 * `check` still refuses exactly where upstream's `Check` does.
 *
 * `DepthExceededError` is the other exception: a candidate whose
 * resolution exhausts the budget is dropped, exactly as a
 * candidate answering `false` is, and the rest of the call still
 * answers. Upstream's stated policy is the opposite — a
 * depth-exceeded candidate fails the whole ListObjects
 * (`reverse_expand.go`,
 * `ErrAuthorizationModelResolutionTooComplex`) — but upstream
 * reverse-expands over a job queue instead of recursing per hop,
 * so its boundary sits far enough out that it almost never reaches
 * its own abort. Dropping the candidate is therefore closer to
 * upstream on every shape upstream can answer, and further from it
 * only where upstream genuinely aborts. The policy is local to
 * `listObjects`: `check` still raises, in every set position, and
 * so does it for a condition error on a subject-naming row.
 *
 * Every other error — a missing relation config above all — still
 * aborts the call in candidate order. A relation with no config is
 * refused, never turned into an empty list.
 *
 * The returned array is in candidate order. That is a tsfga
 * determinism choice rather than parity — upstream streams objects
 * in completion order from its pool.
 *
 * At most `options.listObjectsMaxResults` objects come back
 * (default 1000, matching `OPENFGA_LIST_OBJECTS_MAX_RESULTS`;
 * `Infinity` opts out). Upstream truncates silently — `ListObjects`
 * has no cursor and no field saying the answer was cut — and so
 * does this. Two things follow, and both are properties upstream
 * shares:
 *
 * - **Which** objects come back above the cap differs between the
 *   engines. Upstream keeps whatever its worker pool completed
 *   first; tsfga keeps the first `listObjectsMaxResults` granting
 *   candidates *in candidate order*. A caller comparing the two
 *   may compare counts, never membership.
 * - Reaching the cap **stops the producers**: once the cap is
 *   reached nothing further is launched, so a candidate past it is
 *   never resolved and can never raise. The cap therefore masks
 *   refusals a smaller pool would have surfaced — a call that
 *   answers is not evidence that every object of the type is
 *   resolvable, only that the ones reported are.
 *
 * Truncation is applied in candidate order, so the answer itself
 * stays deterministic: when the count of granted candidates reaches
 * the cap, every one of the first `listObjectsMaxResults` granting
 * candidates has already been launched (launching is in index
 * order) and is awaited before the call settles. What is *not*
 * deterministic across `maxBreadth` settings is how far past the
 * cap the pool happened to reach, so which of the errors beyond it
 * — if any — was seen. That is the same masking property named
 * above, seen from the error side.
 *
 * The cap bounds the answer, never the gates. A relation with no
 * config is still refused, whatever the cap is set to, and a cap of
 * `1` does not turn a refusal into a one-element list.
 * `listSubjects` has no upstream counterpart and is uncapped.
 *
 * Contextual tuples are applied **once, to the whole call**, not
 * per candidate. `runCheck` gives a request carrying them its own
 * memo, because a result resolved over them is not shareable with
 * one resolved without; here every candidate sees the same overlay,
 * so the scope memo stays shared and the saving this function
 * exists for survives.
 */
export async function listObjects(
  store: TupleStore,
  request: ListObjectsRequest,
  options: CheckOptions = {},
): Promise<string[]> {
  const { objectType, relation, subjectType, subjectId, context } = request;
  const subjectRelation = request.subjectRelation;
  // Validated here rather than in `createCheckScope`, where
  // `maxDepth` and `maxBreadth` are: this is the only entry point
  // that reads it, and `CheckOptions` is deliberately validated
  // where the API reading a field lives (see the table on
  // `CheckOptions`). Checked before any store read, so an option
  // the library cannot honour costs no round trip.
  //
  // Same predicate as `maxDepth`: an integer >= 1, or Infinity.
  // Written as a negated comparison so `NaN` is rejected rather
  // than admitted, and a fraction would truncate to a cap one
  // object below what it says.
  const maxResults = options.listObjectsMaxResults ?? 1000;
  if (
    !(maxResults >= 1) ||
    (maxResults !== Number.POSITIVE_INFINITY && !Number.isInteger(maxResults))
  ) {
    throw new TsfgaError(
      "listObjectsMaxResults must be a positive integer or Infinity, " +
        `got ${maxResults}`,
    );
  }
  const contextualTuples = request.contextualTuples ?? [];
  if (contextualTuples.length > 0) {
    await validateContextualTuples(store, contextualTuples);
  }
  const resolutionStore =
    contextualTuples.length > 0
      ? new ContextualTupleStore(store, contextualTuples)
      : store;
  const scope = createCheckScope(resolutionStore, options);
  // Read through the scope's caching store, so the per-candidate
  // checks take this config back out of the cache rather than
  // paying for a second round trip.
  const config = await scope.store.findRelationConfig(objectType, relation);
  if (config === null) {
    throw new RelationConfigNotFoundError(objectType, relation);
  }
  // Last of the three gates, which is upstream's order: contextual
  // tuples, then the target relation, then the subject
  // (`pkg/server/commands/list_objects.go:534-555`). Check orders
  // the subject *first* instead — the two commands genuinely
  // differ, and both orders are observable, so neither is
  // normalised away. Doing it here rather than leaving it to the
  // per-candidate `runCheck` is what makes a malformed subject a
  // refusal even when the candidate pool is empty.
  await validateCheckSubject(scope.store, request);
  const candidateIds = await resolutionStore.listCandidateObjectIds(objectType);

  return resolveCandidates(
    candidateIds,
    scope.maxBreadth,
    maxResults,
    (objectId) =>
      runCheck(scope, {
        objectType,
        objectId,
        relation,
        subjectType,
        subjectId,
        subjectRelation,
        context,
      }).catch((error: unknown) => {
        // A candidate the budget could not resolve is dropped, not
        // propagated -- see the note on this function. Only this
        // error is dropped here: a droppable condition error is
        // classified in `resolveCandidates`, beside the hard
        // failures it has to be ordered against.
        if (error instanceof DepthExceededError) return false;
        throw error;
      }),
  );
}

/**
 * Run `check` over candidates with at most `maxBreadth` in flight,
 * preserving candidate order in the result.
 *
 * Same pull model as the node combinator in `check.ts`: handlers
 * launch in order while there is a free slot, and each settlement
 * pulls the next. It cannot share that combinator because this one
 * collects every result instead of short-circuiting on the first
 * decisive one.
 *
 * On failure it stops launching but still awaits what is already
 * in flight, then rejects with the lowest-index failure seen. That
 * is deterministic: launching is in index order, so when a
 * candidate at index `f` fails, every index below `f` has already
 * been launched and will be awaited — including the true lowest
 * failing index, which is therefore always the one reported,
 * whatever the completion order was.
 *
 * A droppable failure is discarded instead. It never stops the
 * launch loop and never becomes the cut-off: the candidate is
 * simply not granted. So which error a caller sees stays
 * independent of completion order — only hard failures are ever
 * reported, and those are ordered by index.
 *
 * `maxResults` is the second launch cut-off, beside the failure
 * one, and it works the same way: once that many candidates have
 * granted, nothing further is launched, what is in flight is
 * awaited, and the call settles. It is a cut-off rather than a
 * filter over a complete walk on purpose — upstream stops its
 * producers too, so a run that fills the answer early does not pay
 * for the rest of the pool and cannot raise on a candidate it never
 * reached.
 *
 * The two cut-offs compose without an ordering rule because they
 * cannot cross: the failure cut-off only ever moves *down* to an
 * index already launched, and the result cut-off only ever stops
 * indices not yet launched. A hard failure among the launched
 * candidates still rejects, capped or not — the cap truncates an
 * answer, it does not suppress a refusal that was actually
 * reached.
 *
 * Candidates in flight when the cap is reached may push the granted
 * count past it, so the collected result is truncated in candidate
 * order on the way out. That truncation is exact rather than
 * best-effort: when the count reaches the cap, every one of the
 * first `maxResults` granting candidates is necessarily already
 * launched, because launching is in index order and every launched
 * candidate is awaited.
 */
function resolveCandidates(
  candidateIds: readonly string[],
  maxBreadth: number,
  maxResults: number,
  run: (objectId: string) => Promise<boolean>,
): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const allowed = new Array<boolean>(candidateIds.length).fill(false);
    let next = 0;
    let active = 0;
    let settled = false;
    let granted = 0;
    // Also the launch cut-off: nothing at or beyond it is started.
    let failedIndex = candidateIds.length;
    let failure: unknown;
    const record = (index: number, error: unknown) => {
      // Dropped: the candidate simply does not grant.
      if (isDroppable(error)) return;
      if (index < failedIndex) {
        failedIndex = index;
        failure = error;
      }
    };

    // Whether another candidate may be started at all: one is left,
    // no earlier one has failed, and the answer is not yet full.
    const canLaunch = () =>
      next < candidateIds.length && next < failedIndex && granted < maxResults;

    const launch = () => {
      while (!settled && active < maxBreadth && canLaunch()) {
        const index = next;
        next++;
        const objectId = candidateIds[index];
        if (objectId === undefined) continue;
        active++;
        let candidate: Promise<boolean>;
        try {
          candidate = run(objectId);
        } catch (error) {
          // A synchronous throw counts as a failed candidate;
          // without this its slot would leak and the pool could
          // stall with nothing in flight.
          active--;
          record(index, error);
          continue;
        }
        candidate.then(
          (result) => {
            if (settled) return;
            allowed[index] = result;
            if (result) granted++;
            onCandidateDone();
          },
          (error) => {
            if (settled) return;
            record(index, error);
            onCandidateDone();
          },
        );
      }
      // No candidates, holes, and synchronous throws can exhaust
      // the launch loop with nothing in flight; settle here so the
      // returned promise can never stall.
      if (!settled && active === 0) {
        settleExhausted();
      }
    };

    const onCandidateDone = () => {
      active--;
      if (canLaunch()) {
        launch();
      } else if (active === 0) {
        settleExhausted();
      }
    };

    const settleExhausted = () => {
      settled = true;
      if (failedIndex < candidateIds.length) {
        reject(failure);
        return;
      }
      // Truncated in candidate order, not in completion order: the
      // candidates in flight when the cap was reached may have
      // pushed the count past it, and dropping the overflow by
      // arrival time would make the answer depend on the race.
      const objects: string[] = [];
      for (const [index, objectId] of candidateIds.entries()) {
        if (allowed[index] !== true) continue;
        objects.push(objectId);
        if (objects.length >= maxResults) break;
      }
      resolve(objects);
    };

    launch();
  });
}

/**
 * Whether a candidate's failure is dropped instead of aborting the
 * call. See the note on `listObjects`: only a condition error
 * raised on a read that does not name the request subject, because
 * that is the only read upstream's reverse expansion may never
 * reach.
 */
function isDroppable(error: unknown): boolean {
  return error instanceof ConditionEvaluationError && !onSubjectRow(error);
}
