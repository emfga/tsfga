import { type CheckScope, createCheckScope, runCheck } from "./check.ts";
import { TsfgaError } from "./errors.ts";
import type { TupleStore } from "./store-interface.ts";
import type { CheckOptions, CheckRequest } from "./types.ts";

/**
 * One check's answer inside a batch.
 *
 * A failing check does not fail the batch: the error is reported
 * against the check that produced it and the rest still answer.
 * That is upstream's shape — `BatchCheckOutcome{Allowed, Err}`,
 * whose worker records the error and returns nil so the pool is
 * never cancelled (`pkg/server/commands/batch_check_command.go`).
 *
 * `allowed` is always `false` when `error` is set. An unresolved
 * check is not a grant.
 */
export interface CheckOutcome {
  readonly allowed: boolean;
  /** Whatever `check` would have thrown, or undefined on success. */
  readonly error?: unknown;
}

/** Stands in for `undefined` as a context-group key. */
const NO_CONTEXT = Symbol("no context");

/**
 * Check several requests, sharing one resolution scope.
 *
 * A `check()` call builds its scope — the relation-config cache and
 * the node memo — from scratch, so two checks about the same object
 * in the same request share nothing and each pays for the full
 * walk. A consumer measured one page render making four checks
 * about one object, asking 29 distinct questions between them and
 * paying for all four walks: 862 store statements against 21-31 for
 * the same work in one scope.
 *
 * A scope is the right unit for this and a cache is not. Tuple
 * reads have to stay inside the caller's transaction, so a grant
 * written earlier in the same request must be visible to a later
 * check; a batch-scoped memo cannot outlive the transaction it was
 * built in, and a process-wide cache of tuples would.
 *
 * Requests are answered in request order. Upstream returns an
 * unordered map keyed by a caller-supplied correlation id; the
 * position in the array is tsfga's correlation id, which is
 * stricter and needs nothing from the caller.
 *
 * Identical requests in one batch cost one resolution, because the
 * shared scope coalesces them at their root node — the same
 * de-duplication upstream does explicitly before dispatching a
 * batch, arrived at from the algorithm rather than from a key.
 * Requests carrying contextual tuples are the exception: those
 * resolve over a graph of their own and share nothing, which is the
 * conservative direction.
 *
 * Concurrency is bounded by `maxConcurrentChecks` (default 50,
 * matching `OPENFGA_MAX_CONCURRENT_CHECKS_PER_BATCH_CHECK`), which
 * is a separate knob from `maxBreadth`: this bounds whole checks,
 * that bounds the branches of one node. There is no cap on the size
 * of a batch — upstream's `OPENFGA_MAX_CHECKS_PER_BATCH_CHECK` is a
 * server-side request guard, and a library holds nobody's socket.
 *
 * @throws TsfgaError only for invalid options. A check that fails
 *   is reported in its own outcome, never thrown.
 */
export async function checkMany(
  store: TupleStore,
  requests: readonly CheckRequest[],
  options: CheckOptions = {},
): Promise<CheckOutcome[]> {
  const maxConcurrentChecks = options.maxConcurrentChecks ?? 50;
  // Same rule as maxBreadth: the negated comparison rejects NaN,
  // and a fraction would admit one worker more than it says.
  if (
    !(maxConcurrentChecks >= 1) ||
    (maxConcurrentChecks !== Number.POSITIVE_INFINITY &&
      !Number.isInteger(maxConcurrentChecks))
  ) {
    throw new TsfgaError(
      "maxConcurrentChecks must be a positive integer or Infinity, " +
        `got ${maxConcurrentChecks}`,
    );
  }

  // One scope per distinct CEL context. The memo keys on subject
  // and node but not on the context, and the config cache keys on
  // nothing, so requests may only share a scope if they resolve
  // over the same context.
  //
  // Grouped by *reference identity*, not by structural equality:
  // sound with no assumptions about what a context may contain
  // (a `Date`, a class instance, a cyclic object — none of which a
  // canonical serialisation handles). The cost is that a caller who
  // rebuilds an equal context per request gets no sharing, which is
  // why the docs say to pass one object.
  //
  // Built eagerly, before any request is looked at, so the rest of
  // the option validation reaches the caller even when the batch is
  // empty. The config cache is context-independent, so the groups
  // share the one this creates: `createCheckScope` will not re-wrap
  // a store that is already caching.
  const first = createCheckScope(store, options);
  const scopes = new Map<unknown, CheckScope>();
  const scopeFor = (request: CheckRequest): CheckScope => {
    const key = request.context ?? NO_CONTEXT;
    let scope = scopes.get(key);
    if (!scope) {
      scope =
        scopes.size === 0 ? first : createCheckScope(first.store, options);
      scopes.set(key, scope);
    }
    return scope;
  };

  const outcomes = new Array<CheckOutcome>(requests.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (let index = next++; index < requests.length; index = next++) {
      const request = requests[index];
      if (!request) {
        // Only reachable from JS passing a sparse array, which the
        // type forbids. Still answer the slot: a hole in a
        // `CheckOutcome[]` is a worse thing to hand back than an
        // outcome saying there was nothing to check.
        outcomes[index] = {
          allowed: false,
          error: new TsfgaError(`no check request at index ${index}`),
        };
        continue;
      }
      try {
        outcomes[index] = {
          allowed: await runCheck(scopeFor(request), request),
        };
      } catch (error) {
        outcomes[index] = { allowed: false, error };
      }
    }
  };

  await Promise.all(
    Array.from(
      { length: Math.min(maxConcurrentChecks, requests.length) },
      worker,
    ),
  );
  return outcomes;
}
