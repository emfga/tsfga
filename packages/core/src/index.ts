import { check } from "./check.ts";
import { type CheckOutcome, checkMany } from "./check-many.ts";
import { compileCondition } from "./conditions.ts";
import { listObjects } from "./list-objects.ts";
import type { TupleStore } from "./store-interface.ts";
import {
  admitsSubjectRef,
  directSubjectRef,
  validateTupleWrite,
} from "./tuple-validation.ts";
import type {
  AddTupleRequest,
  CheckOptions,
  CheckRequest,
  ConditionDefinition,
  RelationConfig,
  RemoveTupleRequest,
} from "./types.ts";

export interface TsfgaClient {
  /**
   * Check whether a subject has a relation on an object.
   *
   * @throws DepthExceededError when the recursion budget
   *   (`maxDepth`, default 25) is exhausted. Exhaustion never
   *   resolves to `false` — a truncated exclusion branch must not
   *   grant access. A cycle in the resolution path is not an
   *   error: it resolves `false`, matching OpenFGA.
   * @throws RelationConfigNotFoundError or InvalidSubjectTypeError
   *   when a contextual tuple fails the same validation `addTuple`
   *   applies.
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
   * options throw.
   *
   * The scope is bounded by the call, so it can be used inside a
   * transaction: a tuple written earlier in the same transaction is
   * visible to it, which is why this is a scope and not a cache.
   * Requests sharing a `context` object share the memo — pass one
   * object rather than rebuilding an equal one per request.
   */
  checkMany(requests: readonly CheckRequest[]): Promise<CheckOutcome[]>;
  addTuple(request: AddTupleRequest): Promise<void>;
  removeTuple(request: RemoveTupleRequest): Promise<boolean>;
  /**
   * List object IDs of a type for which the subject passes a full
   * check. Candidates come from `listCandidateObjectIds`
   * (pre-filter); the optional `context` is forwarded to each
   * per-object check for CEL condition evaluation.
   *
   * Candidates are checked concurrently, bounded by `maxBreadth`,
   * and share one relation-config cache and one node memo for the
   * whole call. The result is in candidate order.
   *
   * @throws whatever `check` throws for the first failing
   *   candidate in candidate order — including
   *   `DepthExceededError`, which aborts the whole call rather
   *   than dropping that one object.
   */
  listObjects(
    objectType: string,
    relation: string,
    subjectType: string,
    subjectId: string,
    context?: Record<string, unknown>,
  ): Promise<string[]>;
  /**
   * List direct subjects only — no userset or relation expansion.
   *
   * Filtered by the relation's `directlyAssignable`, **matched
   * exactly, condition included**: a row carrying a condition the
   * relation does not admit is no more reported than one carrying
   * a type it does not admit. So a subject this returns is one
   * `check` could act on, not merely one that is stored.
   * That matters because narrowing a relation does not revalidate
   * the tuples already written, so inadmissible rows are an
   * ordinary state to be in.
   *
   * The consequence, stated plainly: there is then no library path
   * that *finds* such a row in order to delete it. Upstream keeps
   * `Read` unfiltered for exactly that reason and filters only
   * Expand and ListUsers. A maintenance read is owed.
   */
  listSubjects(
    objectType: string,
    objectId: string,
    relation: string,
  ): Promise<
    Array<{
      subjectType: string;
      subjectId: string;
      subjectRelation: string | null;
    }>
  >;
  writeRelationConfig(config: RelationConfig): Promise<void>;
  deleteRelationConfig(objectType: string, relation: string): Promise<boolean>;
  /**
   * Define a named CEL condition.
   *
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
  return {
    check(request: CheckRequest): Promise<boolean> {
      return check(store, request, options);
    },

    checkMany(requests: readonly CheckRequest[]): Promise<CheckOutcome[]> {
      return checkMany(store, requests, options);
    },

    async addTuple(request: AddTupleRequest): Promise<void> {
      await validateTupleWrite(store, request);
      return store.insertTuple(request);
    },

    removeTuple(request: RemoveTupleRequest): Promise<boolean> {
      return store.deleteTuple(request);
    },

    listObjects(
      objectType: string,
      relation: string,
      subjectType: string,
      subjectId: string,
      context?: Record<string, unknown>,
    ): Promise<string[]> {
      return listObjects(
        store,
        objectType,
        relation,
        subjectType,
        subjectId,
        context,
        options,
      );
    },

    async listSubjects(
      objectType: string,
      objectId: string,
      relation: string,
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
      const config = await store.findRelationConfig(objectType, relation);
      const tuples = await store.findTuplesByRelation(
        objectType,
        objectId,
        relation,
      );
      return tuples
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
        )
        .map((tuple) => ({
          subjectType: tuple.subjectType,
          subjectId: tuple.subjectId,
          subjectRelation: tuple.subjectRelation,
        }));
    },

    writeRelationConfig(config: RelationConfig): Promise<void> {
      return store.upsertRelationConfig(config);
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
      // Compiled here, not at the first check that reads it. An
      // expression that does not parse was accepted at three
      // points — this write, every tuple write beneath it, and
      // every check until someone ran one — where OpenFGA refuses
      // the model write that carries it.
      compileCondition(condition.name, condition.expression);
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
export { coerceContext, evaluateTupleCondition } from "./conditions.ts";
export { ContextualTupleStore } from "./contextual-store.ts";
export {
  type ConditionalTupleCause,
  ConditionCompileError,
  ConditionEvaluationError,
  ConditionNotFoundError,
  DepthExceededError,
  formatRestriction,
  InvalidConditionalTupleError,
  InvalidStoredDataError,
  InvalidSubjectTypeError,
  RelationConfigNotFoundError,
  TsfgaError,
} from "./errors.ts";
export type { TupleStore } from "./store-interface.ts";
export {
  admitsSubjectRef,
  admitsSubjectShape,
  directSubjectRef,
  type SubjectShape,
  subjectShape,
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
  RelationConfig,
  RemoveTupleRequest,
  Tuple,
  TypeRestriction,
} from "./types.ts";
