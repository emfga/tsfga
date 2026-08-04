import { check } from "./check.ts";
import type { TupleStore } from "./store-interface.ts";
import { validateTupleWrite } from "./tuple-validation.ts";
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
   *   (`maxDepth`, default 10) is exhausted or a cycle is detected
   *   in the resolution path. Exhaustion never resolves to `false`
   *   — a truncated exclusion branch must not grant access.
   * @throws RelationConfigNotFoundError, InvalidSubjectTypeError,
   *   or UsersetNotAllowedError when a contextual tuple fails the
   *   same validation `addTuple` applies.
   */
  check(request: CheckRequest): Promise<boolean>;
  addTuple(request: AddTupleRequest): Promise<void>;
  removeTuple(request: RemoveTupleRequest): Promise<boolean>;
  /**
   * List object IDs of a type for which the subject passes a full
   * check. Candidates come from `listCandidateObjectIds`
   * (pre-filter); the optional `context` is forwarded to each
   * per-object check for CEL condition evaluation.
   */
  listObjects(
    objectType: string,
    relation: string,
    subjectType: string,
    subjectId: string,
    context?: Record<string, unknown>,
  ): Promise<string[]>;
  /** List direct subjects only — no userset/relation expansion. */
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

    async addTuple(request: AddTupleRequest): Promise<void> {
      await validateTupleWrite(store, request);
      return store.insertTuple(request);
    },

    removeTuple(request: RemoveTupleRequest): Promise<boolean> {
      return store.deleteTuple(request);
    },

    async listObjects(
      objectType: string,
      relation: string,
      subjectType: string,
      subjectId: string,
      context?: Record<string, unknown>,
    ): Promise<string[]> {
      const candidateIds = await store.listCandidateObjectIds(objectType);
      const results: string[] = [];
      for (const objectId of candidateIds) {
        const allowed = await check(
          store,
          { objectType, objectId, relation, subjectType, subjectId, context },
          options,
        );
        if (allowed) {
          results.push(objectId);
        }
      }
      return results;
    },

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
    > {
      return store.listDirectSubjects(objectType, objectId, relation);
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

    writeConditionDefinition(condition: ConditionDefinition): Promise<void> {
      return store.upsertConditionDefinition(condition);
    },

    deleteConditionDefinition(name: string): Promise<boolean> {
      return store.deleteConditionDefinition(name);
    },
  };
}

// Re-exports
export { check } from "./check.ts";
export { evaluateTupleCondition } from "./conditions.ts";
export { ContextualTupleStore } from "./contextual-store.ts";
export {
  ConditionEvaluationError,
  ConditionNotFoundError,
  DepthExceededError,
  InvalidStoredDataError,
  InvalidSubjectTypeError,
  RelationConfigNotFoundError,
  TsfgaError,
  UsersetNotAllowedError,
} from "./errors.ts";
export type { TupleStore } from "./store-interface.ts";
export { validateTupleWrite } from "./tuple-validation.ts";
export type {
  AddTupleRequest,
  CheckOptions,
  CheckRequest,
  ConditionDefinition,
  ConditionParameterType,
  IntersectionOperand,
  RelationConfig,
  RemoveTupleRequest,
  Tuple,
} from "./types.ts";
