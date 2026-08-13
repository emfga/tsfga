import { check } from "./check.ts";
import { type CheckOutcome, checkMany } from "./check-many.ts";
import {
  compileCondition,
  evaluateTupleCondition,
  resolveMaxConditionEvaluationCost,
} from "./conditions.ts";
import {
  validateConditionWrite,
  validateRelationConfigWrite,
} from "./config-validation.ts";
import {
  DuplicateTupleError,
  ImplicitTupleError,
  InvalidObjectError,
  MissingTupleError,
  RelationConfigNotFoundError,
  TsfgaError,
} from "./errors.ts";
import { listObjects } from "./list-objects.ts";
import type { TupleStore } from "./store-interface.ts";
import {
  admitsSubjectRef,
  DEFAULT_WRITE_CONTEXT_BYTE_LIMIT,
  directSubjectRef,
  isRe2Space,
  isSelfDefining,
  validateIdDomain,
  validateRequestContext,
  validateSubjectIdDomain,
  validateTupleDelete,
  validateTupleWrite,
} from "./tuple-validation.ts";
import type {
  AddTupleRequest,
  CheckOptions,
  CheckRequest,
  ConditionDefinition,
  ListObjectsRequest,
  RelationConfig,
  RemoveTupleRequest,
} from "./types.ts";
import { parseRelationConfigWrite, parseTupleWrite } from "./write-gate.ts";

/**
 * What `listSubjects` takes beyond the object and relation.
 *
 * An optional fourth argument rather than a request object, which
 * is what `check` and `listObjects` take and what this should
 * become. The migration is owed and deliberately not taken here:
 * it touches every call site in the repo and the consumers', for a
 * shape change that adds nothing to this release.
 */
export interface ListSubjectsOptions {
  /**
   * CEL context for the conditions on the rows, exactly as
   * `CheckRequest.context` is for a check. A tuple's own
   * `conditionContext` still wins over it.
   */
  context?: Record<string, unknown>;
}

export interface TsfgaClient {
  /**
   * Check whether a subject has a relation on an object.
   *
   * @throws DepthExceededError when the recursion budget
   *   (`maxDepth`, default 25) is exhausted. Exhaustion never
   *   resolves to `false` — a truncated exclusion branch must not
   *   grant access. A cycle in the resolution path is not an
   *   error: it resolves `false`, matching OpenFGA.
   * @throws RelationConfigNotFoundError for a relation the model
   *   does not define — the requested one, or one a rewrite
   *   reaches. A missing config used to read as *unrestricted*, so
   *   a row that outlived its config granted; upstream answers an
   *   HTTP 400 validation error for the same request.
   * @throws RelationConfigNotFoundError, InvalidSubjectTypeError
   *   or InvalidConditionalTupleError when a contextual tuple
   *   fails the same validation `addTuple` applies.
   * @throws InvalidRequestContextError when `context` holds a
   *   Unicode control character in a key or a string value, at any
   *   depth. Raised before any store read, because upstream
   *   validates the request context before it resolves anything.
   */
  check(request: CheckRequest): Promise<boolean>;
  /**
   * Check several requests against one shared resolution scope, so
   * a node reached by more than one of them is resolved once for
   * the whole batch rather than once per call. Use it wherever a
   * request answers several permission questions at a time: the
   * saving is the shared part of the graph, which is usually most
   * of it.
   *
   * Answers come back in request order, one per request. A check
   * that fails reports its error in its own outcome instead of
   * failing the batch, matching OpenFGA's BatchCheck; only invalid
   * options throw. A request context the model refuses
   * (`InvalidRequestContextError`) is one such per-item failure.
   *
   * The scope is bounded by the call, so it can be used inside a
   * transaction: a tuple written earlier in the same transaction is
   * visible to it, which is why this is a scope and not a cache.
   * Requests sharing a `context` object share the memo — pass one
   * object rather than rebuilding an equal one per request.
   */
  checkMany(requests: readonly CheckRequest[]): Promise<CheckOutcome[]>;
  /**
   * Write one tuple.
   *
   * @throws ImplicitTupleError for a tuple that says only what the
   *   model already says.
   * @throws RelationConfigNotFoundError, InvalidSubjectTypeError or
   *   InvalidConditionalTupleError when the tuple is not one the
   *   model admits — including a malformed subject
   *   (`team:*#member`), a condition context holding a control
   *   character, and a context over `writeContextByteLimit`.
   * @throws DuplicateTupleError when the edge is already stored.
   *   The natural key is object, relation and subject; **the
   *   condition is not part of it**, so re-granting an edge under a
   *   different condition is a duplicate, not an edit. Changing a
   *   grant's condition is `removeTuple` then `addTuple`, which is
   *   what OpenFGA requires. Nothing is written in this case: the
   *   stored row keeps the condition it had.
   */
  addTuple(request: AddTupleRequest): Promise<void>;
  /**
   * Delete one tuple.
   *
   * @throws InvalidSubjectTypeError or InvalidObjectError when the
   *   key is malformed. This is upstream's *syntactic* delete
   *   validation and **not** its model validation: an undefined
   *   relation, an undefined type or a subject type the relation
   *   does not admit all fall through, as upstream does, which is
   *   what makes a bad model change recoverable.
   * @throws MissingTupleError when no such tuple exists. Upstream's
   *   `on_missing` defaults to `error`.
   */
  removeTuple(request: RemoveTupleRequest): Promise<void>;
  /**
   * List object IDs of a type for which the subject passes a full
   * check. Candidates come from `listCandidateObjectIds`
   * (pre-filter) together with the objects any contextual tuples
   * name; the optional `context` is forwarded to each per-object
   * check for CEL condition evaluation.
   *
   * Candidates are checked concurrently, bounded by `maxBreadth`,
   * and share one relation-config cache and one node memo for the
   * whole call. The result is in candidate order.
   *
   * @throws whatever `check` throws for the first failing
   *   candidate in candidate order — with **two** exceptions, both
   *   of which drop the candidate and keep the rest of the answer
   *   rather than abandoning the call. `DepthExceededError` is one:
   *   a candidate the budget cannot resolve counts as `false`,
   *   where `check` still raises. A `ConditionEvaluationError` is
   *   the other, and only when it was *not* raised on a read naming
   *   the request subject — the reads upstream's reverse expansion
   *   may never materialise. Both run in the under-reporting
   *   direction: nothing is granted that a full check does not
   *   grant. The rationale for each is on `listObjects` in
   *   `list-objects.ts`.
   * @throws RelationConfigNotFoundError, InvalidSubjectTypeError or
   *   InvalidConditionalTupleError when a contextual tuple fails
   *   the same validation `addTuple` applies. Raised once for the
   *   call, before any candidate is checked.
   */
  listObjects(request: ListObjectsRequest): Promise<string[]>;
  /**
   * List direct subjects only — no userset or relation expansion.
   *
   * Filtered by the relation's `directlyAssignable`, **matched
   * exactly, condition included**, and then by the condition's
   * *value*: a row carrying a condition the relation does not
   * admit is no more reported than one carrying a type it does not
   * admit, and a row whose condition does not hold under
   * `options.context` is not reported either. So a subject this
   * returns is one `check` could act on, not merely one that is
   * stored. That matters because narrowing a relation does not
   * revalidate the tuples already written, so inadmissible rows
   * are an ordinary state to be in.
   *
   * The consequence, stated plainly: there is then no library path
   * that *finds* such a row in order to delete it. Upstream keeps
   * `Read` unfiltered for exactly that reason and filters only
   * Expand and ListUsers. A maintenance read is owed.
   *
   * @throws RelationConfigNotFoundError when the relation has no
   *   config. It used to report every stored row instead, which
   *   made this the one path that admitted what `check` refuses.
   * @throws ConditionNotFoundError, ConditionEvaluationError or
   *   InvalidConditionalTupleError when an admitted row's
   *   condition cannot be evaluated — a missing parameter, a
   *   value of the wrong type, a condition the store does not
   *   define. Upstream refuses the call for the same row, and
   *   reporting the subject unevaluated would be the granting
   *   direction.
   */
  listSubjects(
    objectType: string,
    objectId: string,
    relation: string,
    options?: ListSubjectsOptions,
  ): Promise<
    Array<{
      subjectType: string;
      subjectId: string;
      subjectRelation: string | null;
    }>
  >;
  /**
   * Insert or update a relation config.
   *
   * @throws InvalidRelationConfigError for a config OpenFGA's
   *   typesystem would reject: an `intersection` with fewer than
   *   two operands, a type restriction naming an undefined
   *   condition, or a tuple-to-userset whose tupleset relation
   *   admits a userset or a wildcard. The last two are only
   *   checked when the tupleset relation's config already exists
   *   -- see `config-validation.ts` for why.
   */
  writeRelationConfig(config: RelationConfig): Promise<void>;
  deleteRelationConfig(objectType: string, relation: string): Promise<boolean>;
  /**
   * Define a named CEL condition.
   *
   * @throws InvalidRelationConfigError for a name upstream's model
   *   write refuses — the condition's own (`malformed condition
   *   name`) or any of its parameters' (`malformed condition
   *   parameter name`). Both carry the proto pattern
   *   `^[^:#@\s]{1,50}$`, the one a relation name carries, and both
   *   are checked before the expression is compiled.
   * @throws ConditionCompileError when the expression does not
   *   compile. OpenFGA refuses the model write that carries such
   *   an expression, rather than deferring the failure to the
   *   first check that reads it.
   */
  writeConditionDefinition(condition: ConditionDefinition): Promise<void>;
  deleteConditionDefinition(name: string): Promise<boolean>;
}

export function createTsfga(
  store: TupleStore,
  options?: CheckOptions,
): TsfgaClient {
  const writeContextByteLimit =
    options?.writeContextByteLimit ?? DEFAULT_WRITE_CONTEXT_BYTE_LIMIT;
  // The fourth of the four options, held to the same rule as the
  // three `createCheckScope` and `checkMany` guard: the negated
  // comparison rejects `NaN`, which `< 0` misses, and a fraction
  // would admit one byte more than it says.
  //
  // **Non-negative**, where the other three are positive: `0` is a
  // coherent limit — it refuses every conditioned write — where a
  // `maxDepth` of `0` is a budget no check can run inside. A
  // negative limit refuses every conditioned write too, but says so
  // by accident, and `NaN` accepts every one of them, silently
  // removing the bound from a caller who was setting one.
  //
  // Checked at construction rather than at the write it bounds:
  // the option is inert until an `addTuple` carrying a condition
  // context, so a caller who mistyped it could otherwise hold a
  // client for the whole of a request before hearing about it.
  if (
    !(writeContextByteLimit >= 0) ||
    (writeContextByteLimit !== Number.POSITIVE_INFINITY &&
      !Number.isInteger(writeContextByteLimit))
  ) {
    throw new TsfgaError(
      "writeContextByteLimit must be a non-negative integer or " +
        `Infinity, got ${writeContextByteLimit}`,
    );
  }

  // `listSubjects` evaluates conditions without building a
  // `CheckScope`, so it resolves the budget here. Every other entry
  // point reaches it through the scope. Validated at construction
  // for the same reason the byte limit is: an option nobody reads
  // until the first conditioned row would otherwise be reported far
  // from where it was set.
  const maxConditionEvaluationCost = resolveMaxConditionEvaluationCost(options);

  return {
    async check(request: CheckRequest): Promise<boolean> {
      // Before any store read, as upstream validates it before it
      // resolves anything. `async` so the refusal reaches the
      // caller as a rejected promise rather than a synchronous
      // throw — every other refusal on this method already does.
      validateRequestContext(request.context);
      return check(store, request, options);
    },

    async checkMany(
      requests: readonly CheckRequest[],
    ): Promise<CheckOutcome[]> {
      // Per item, not per batch. A request context upstream refuses
      // is a `validation_error` on that check, and BatchCheck
      // records a failing item's error against the item rather than
      // failing the batch — the same rule `checkMany` already
      // applies to everything `check` throws. Refusing the whole
      // call for one dirty context would be the one error in the
      // batch that behaves differently.
      const outcomes = new Map<number, CheckOutcome>();
      const admitted: CheckRequest[] = [];
      const positions: number[] = [];
      for (const [index, request] of requests.entries()) {
        try {
          validateRequestContext(request?.context);
        } catch (error) {
          outcomes.set(index, { allowed: false, error });
          continue;
        }
        positions.push(index);
        admitted.push(request);
      }
      // Called even when nothing is admitted: the option validation
      // lives there and must still reach the caller.
      const answered = await checkMany(store, admitted, options);
      const merged = new Array<CheckOutcome>(requests.length);
      for (const [slot, index] of positions.entries()) {
        const outcome = answered[slot];
        if (outcome) merged[index] = outcome;
      }
      for (const [index, outcome] of outcomes) merged[index] = outcome;
      return merged;
    },

    async addTuple(request: AddTupleRequest): Promise<void> {
      // Refused here rather than in the shared validation, which
      // contextual tuples also run: upstream refuses this write and
      // accepts the same tuple contextually. Measured on v1.18.2,
      // with a control proving the contextual field was honoured.
      if (isSelfDefining(request)) {
        throw new ImplicitTupleError(
          request.objectType,
          request.objectId,
          request.relation,
          "TUPLE-IMPLICIT",
        );
      }
      await validateTupleWrite(store, request, {
        contextByteLimit: writeContextByteLimit,
      });
      const inserted = await store.insertTuple(parseTupleWrite(request));
      // Upstream's `on_duplicate` defaults to `error`, and the
      // natural key excludes the condition, so re-granting an edge
      // *under a condition* is a duplicate rather than an edit. It
      // used to be an upsert here, which meant a second write
      // narrowed a live grant — or, worse, widened one by dropping
      // the condition it carried — and reported nothing.
      if (!inserted) {
        throw new DuplicateTupleError(
          request.objectType,
          request.objectId,
          request.relation,
          request.subjectType,
          request.subjectId,
          request.subjectRelation ?? null,
          "TUPLE-DUPLICATE",
        );
      }
    },

    async removeTuple(request: RemoveTupleRequest): Promise<void> {
      // Upstream's delete validation, which is *not* its write
      // validation: `IsValidUser` on the rendered subject plus the
      // three proto bounds, and no model validation at all. An
      // undefined relation or type falls through to "does not
      // exist", which is what makes a bad model change
      // recoverable.
      validateTupleDelete(request);
      // The store's id gate, behind upstream's rules and ahead of
      // the row read -- the delete path's copy of the position
      // `validateIdDomain` argues for. It is a call site here
      // rather than a predicate inside `validateTupleDelete`,
      // which is exported and deliberately takes no store: it
      // reads nothing, and a store parameter it consulted for one
      // rule would say otherwise.
      validateSubjectIdDomain(store, request.subjectType, request.subjectId);
      validateIdDomain(store, "object", request.objectType, request.objectId);
      const removed = await store.deleteTuple(request);
      // Upstream's `on_missing` defaults to `error`, so a delete
      // of a row that is not there is refused. The boolean stays
      // on `TupleStore.deleteTuple` -- it is how the client learns
      // whether to throw, exactly as `insertTuple`'s feeds
      // `DuplicateTupleError`.
      if (!removed) {
        throw new MissingTupleError(
          request.objectType,
          request.objectId,
          request.relation,
          request.subjectType,
          request.subjectId,
          request.subjectRelation ?? null,
          "DELETE-TUPLE-MISSING",
        );
      }
    },

    listObjects(request: ListObjectsRequest): Promise<string[]> {
      // No request-context gate here, deliberately. The three
      // commands do not validate the same things:
      // `CheckCommand.validateCheckRequest` runs
      // `validation.ValidateStruct(requestCtx)`
      // (`pkg/server/commands/check_command.go:197`) and
      // `ListObjectsQuery.Execute` never does — it validates the
      // contextual tuples, the target relation and the user, and
      // passes `req.GetContext()` through untouched
      // (`pkg/server/commands/list_objects.go:506-556`). At
      // v1.18.2 `ValidateStruct` appears in that one file and
      // nowhere else in `pkg/server/commands`.
      //
      // The check-path gate was once applied here too, which refused
      // a call upstream answers. The
      // contextual tuples' own condition contexts *are* validated,
      // by `validateTupleWrite` — upstream validates those through
      // `ValidateTupleForWrite`, so the two are not symmetric.
      return listObjects(store, request, options);
    },

    async listSubjects(
      objectType: string,
      objectId: string,
      relation: string,
      subjectOptions?: ListSubjectsOptions,
    ): Promise<
      Array<{
        subjectType: string;
        subjectId: string;
        subjectRelation: string | null;
      }>
    > {
      // Gated here rather than in the adapter. A store-side filter
      // would leave every other `TupleStore` — the wrappers, the
      // mock, any third-party one — reporting subjects the model
      // does not admit, and would put adapter authors inside the
      // security boundary. `clampToQuery` already refused that
      // trade for the check reads; this is the same call.
      //
      // A relation with no config raises here for the same reason
      // `check` raises: it used to read as unrestricted, and a
      // filter that admits everything on the one input nobody
      // meant to give it — a misspelled relation, a config that a
      // row outlived — is the failure this gate exists to prevent.
      // Reporting subjects `check` would refuse to act on would
      // have been the two paths disagreeing in the granting
      // direction, which is worse than either answer alone.
      const context = subjectOptions?.context;
      // The object id is gated, and by a **narrower** rule than
      // `check`'s. Upstream's nearest request is `ListUsers`, whose
      // object is validated through the protobuf pattern only:
      // `^[^\s]{1,256}$` refuses an empty id and one carrying
      // whitespace, and nothing runs `unicode.IsControl` over it.
      // Measured at v1.18.2: `doc:<id>` is a question
      // `ListUsers` answers, with no users, where the same id on a
      // check is a 400. So this must not borrow the check gate —
      // the wider rule would refuse a request upstream answers.
      //
      // No request-context gate either, for 442's reason:
      // `ValidateStruct` lives in `CheckCommand` and nowhere else
      // in `pkg/server/commands`, and `ListUsers` is not a check.
      // The comment here used to cite `CheckCommand` as its
      // authority; it never was one.
      if (objectId.length === 0 || [...objectId].some(isRe2Space)) {
        throw new InvalidObjectError(
          "malformed object id",
          objectType,
          objectId,
          "an object id must be non-empty and hold no whitespace",
        );
      }
      // And then the store's own gate, behind the upstream rule
      // and ahead of the config read, as everywhere else.
      validateIdDomain(store, "object", objectType, objectId);
      const config = await store.findRelationConfig(objectType, relation);
      if (config === null) {
        throw new RelationConfigNotFoundError(objectType, relation);
      }
      const tuples = await store.findTuplesByRelation(
        objectType,
        objectId,
        relation,
      );
      const admitted = tuples
        // The store's reply is a hint here as it is everywhere
        // else. `clampToQuery` re-applies the exact node match to
        // the check reads and `resolveTupleset` to the tupleset
        // read; this one had only the subject-shape half, so an
        // adapter whose `WHERE` lost `object_id` or `relation`
        // reported another object's subjects as this one's. The
        // three fields are the ones `onNode` spells.
        .filter(
          (tuple) =>
            tuple.objectType === objectType &&
            tuple.objectId === objectId &&
            tuple.relation === relation,
        )
        // And the same guard `clampToQuery`'s `isUserset` carries:
        // a wildcard is a subject shape, not an id, so a wildcard
        // carrying a subject relation is a row no legal model has.
        // It is admitted as the ordinary ref `team#member`
        // otherwise, because `subjectShape` folds `"*"` into the
        // wildcard shape only when there is no subject relation.
        // Guarded on the relation so a direct `user:*` row — an
        // ordinary grant — is still reported.
        .filter(
          (tuple) =>
            (tuple.subjectRelation ?? null) === null || tuple.subjectId !== "*",
        )
        .filter((tuple) =>
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

      // The condition's *value*, after its shape. The restriction
      // match says the row carries a condition the relation admits;
      // it says nothing about whether that condition holds for this
      // request, and upstream's ListUsers evaluates it — a row
      // whose condition is false is not reported, and one that
      // cannot be evaluated refuses the whole call rather than
      // being reported unevaluated. Both directions are observable
      // and both were wrong here.
      //
      // Sequential rather than raced: the rows of one object are
      // few, and the first row that cannot be evaluated is then the
      // one the refusal names, in read order.
      const rows: Array<{
        subjectType: string;
        subjectId: string;
        subjectRelation: string | null;
      }> = [];
      for (const tuple of admitted) {
        const held = await evaluateTupleCondition(store, tuple, context, {
          maxConditionEvaluationCost,
        });
        if (!held) continue;
        rows.push({
          subjectType: tuple.subjectType,
          subjectId: tuple.subjectId,
          subjectRelation: tuple.subjectRelation,
        });
      }
      return rows;
    },

    async writeRelationConfig(config: RelationConfig): Promise<void> {
      await validateRelationConfigWrite(store, config);
      await store.upsertRelationConfig(parseRelationConfigWrite(config));
    },

    deleteRelationConfig(
      objectType: string,
      relation: string,
    ): Promise<boolean> {
      return store.deleteRelationConfig(objectType, relation);
    },

    async writeConditionDefinition(
      condition: ConditionDefinition,
    ): Promise<void> {
      // The names first, and before the expression: upstream's
      // model write refuses the condition on its own name or on a
      // parameter key regardless of what the expression says, and
      // an expression that happens not to compile would otherwise
      // decide which of the two errors a caller sees.
      validateConditionWrite(condition);
      // Compiled here, not at the first check that reads it. An
      // expression that does not parse was accepted at three
      // points — this write, every tuple write beneath it, and
      // every check until someone ran one — where OpenFGA refuses
      // the model write that carries it.
      compileCondition(
        condition.name,
        condition.expression,
        condition.parameters,
        "CONDITION-EXPRESSION-COMPILE",
      );
      await store.upsertConditionDefinition(condition);
    },

    deleteConditionDefinition(name: string): Promise<boolean> {
      return store.deleteConditionDefinition(name);
    },
  };
}

// Re-exports
export { check } from "./check.ts";
export { type CheckOutcome, checkMany } from "./check-many.ts";
export {
  type ConditionEvaluationOptions,
  coerceContext,
  evaluateTupleCondition,
} from "./conditions.ts";
export {
  validateConditionWrite,
  validateRelationConfigWrite,
} from "./config-validation.ts";
export { ContextualTupleStore } from "./contextual-store.ts";
export {
  type ConditionalTupleCause,
  ConditionCompileError,
  ConditionEvaluationError,
  ConditionNotFoundError,
  DepthExceededError,
  DuplicateTupleError,
  formatRestriction,
  // Raised when the store's declared `idDomain` cannot hold an id
  // OpenFGA accepts. A capability refusal, not a parity claim --
  // see `capability-refusals.json`.
  IdDomainError,
  // `IdDomainError.position` is a union, exported for the reason
  // the other cause unions here are.
  type IdPosition,
  ImplicitTupleError,
  InvalidConditionalTupleError,
  // Raised by `check` and `checkMany` for an object the request
  // cannot be about, by `addTuple` for one no row may carry, and by
  // `listSubjects` under its narrower `ListUsers` rule.
  InvalidObjectError,
  InvalidRelationConfigError,
  // Raised by `check` and `checkMany` for a request context
  // upstream refuses, before anything is resolved. **Not** by
  // `listObjects` or `listSubjects`: `ValidateStruct` is the check
  // command's alone.
  InvalidRequestContextError,
  InvalidStoredDataError,
  InvalidSubjectTypeError,
  // Raised by `removeTuple` when the row is not there -- upstream's
  // `on_missing` default. The twin of `DuplicateTupleError`.
  MissingTupleError,
  // `InvalidObjectError.cause` is a union for the same reason the
  // others here are: a caller switching on it needs the name.
  type ObjectDefect,
  type RelationConfigDefect,
  RelationConfigNotFoundError,
  // `InvalidRequestContextError.cause` is a union for the same
  // reason the two beside it are.
  type RequestContextDefect,
  // `InvalidSubjectTypeError.cause` is a union rather than one
  // literal, so a caller switching on it needs the name — the same
  // reason `ConditionalTupleCause` and `RelationConfigDefect` are
  // exported beside it.
  type SubjectDefect,
  TsfgaError,
} from "./errors.ts";
export {
  // A store declares which ids it can hold. Both constants are
  // exported because both are answers a store author gives:
  // `OPAQUE_IDS` for a store whose ids are strings, and
  // `CANONICAL_UUID_IDS` for one keeping them in a `uuid` column.
  CANONICAL_UUID_IDS,
  type IdDomain,
  OPAQUE_IDS,
  type TupleStore,
} from "./store-interface.ts";
export {
  admitsSubjectRef,
  admitsSubjectShape,
  DEFAULT_WRITE_CONTEXT_BYTE_LIMIT,
  directSubjectRef,
  isSelfDefining,
  type SubjectShape,
  subjectShape,
  type TupleWriteValidationOptions,
  // A store author reimplementing a gate needs these two the way
  // they need `validateTupleWrite`: they are the id half of it.
  validateIdDomain,
  validateRequestContext,
  validateSubjectIdDomain,
  validateTupleDelete,
  validateTupleWrite,
} from "./tuple-validation.ts";
export type {
  AddTupleRequest,
  CheckOptions,
  CheckRequest,
  CheckTuples,
  CheckTuplesQuery,
  ConditionDefinition,
  ConditionParameterScalarType,
  ConditionParameterType,
  IntersectionOperand,
  ListObjectsRequest,
  RelationConfig,
  RemoveTupleRequest,
  Tuple,
  TypeRestriction,
} from "./types.ts";
export type {
  // The brand *types* are exported and the mints are not. An
  // adapter has to be able to name `GatedTuple` to declare its
  // own method; nobody outside this package needs to be able to
  // produce one.
  GatedRelationConfig,
  GatedTuple,
} from "./write-gate.ts";
export {
  CAPABILITY_RULE_IDS,
  type CapabilityRuleId,
  UPSTREAM_RULE_IDS,
  type UpstreamRuleId,
  // `TsfgaError.ruleId` names one of these. A consumer gets a
  // stable discriminator that does not depend on message prose,
  // and the two arrays say which refusals are parity with OpenFGA
  // and which are tsfga's own.
  type WriteRuleId,
} from "./write-rules.ts";
