import { check } from "src/core/check.ts";
import {
  InvalidSubjectTypeError,
  RelationConfigNotFoundError,
  UsersetNotAllowedError,
} from "src/core/errors.ts";
import type {
  AddTupleRequest,
  CheckOptions,
  CheckRequest,
  ConditionDefinition,
  RelationConfig,
  RemoveTupleRequest,
} from "src/core/types.ts";
import type { TupleStore } from "src/store/interface.ts";

export interface TsfgaClient {
  check(request: CheckRequest): Promise<boolean>;
  addTuple(request: AddTupleRequest): Promise<void>;
  removeTuple(request: RemoveTupleRequest): Promise<boolean>;
  listObjects(
    objectType: string,
    relation: string,
    subjectType: string,
    subjectId: string,
  ): Promise<string[]>;
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
      const config = await store.findRelationConfig(
        request.objectType,
        request.relation,
      );
      if (!config) {
        throw new RelationConfigNotFoundError(
          request.objectType,
          request.relation,
        );
      }

      if (config.directlyAssignableTypes) {
        const subjectRef =
          request.subjectId === "*"
            ? `${request.subjectType}:*`
            : request.subjectType;
        if (!config.directlyAssignableTypes.includes(subjectRef)) {
          throw new InvalidSubjectTypeError(
            subjectRef,
            request.objectType,
            request.relation,
            config.directlyAssignableTypes,
          );
        }
      }

      if (request.subjectRelation && !config.allowsUsersetSubjects) {
        throw new UsersetNotAllowedError(request.objectType, request.relation);
      }

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
    ): Promise<string[]> {
      const candidateIds = await store.listCandidateObjectIds(objectType);
      const results: string[] = [];
      for (const objectId of candidateIds) {
        const allowed = await check(
          store,
          { objectType, objectId, relation, subjectType, subjectId },
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
export { check } from "src/core/check.ts";
export { evaluateTupleCondition } from "src/core/conditions.ts";
export {
  ConditionEvaluationError,
  ConditionNotFoundError,
  InvalidSubjectTypeError,
  RelationConfigNotFoundError,
  TsfgaError,
  UsersetNotAllowedError,
} from "src/core/errors.ts";
export type {
  AddTupleRequest,
  CheckOptions,
  CheckRequest,
  ConditionDefinition,
  ConditionParameterType,
  RelationConfig,
  RemoveTupleRequest,
  Tuple,
} from "src/core/types.ts";
export type { TupleStore } from "src/store/interface.ts";
export { KyselyTupleStore } from "src/store/kysely/adapter.ts";
