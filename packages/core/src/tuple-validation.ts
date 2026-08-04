import {
  InvalidSubjectTypeError,
  RelationConfigNotFoundError,
  UsersetNotAllowedError,
} from "./errors.ts";
import type { TupleStore } from "./store-interface.ts";
import type { AddTupleRequest } from "./types.ts";

/**
 * Validate that a tuple is writable under the relation's config.
 * Used by both `addTuple` and contextual-tuple validation so the
 * two paths cannot drift apart.
 *
 * @throws RelationConfigNotFoundError when no relation config
 *   exists for the tuple's object type + relation.
 * @throws InvalidSubjectTypeError when the subject type (or
 *   `type:*` for wildcard subjects) is not directly assignable.
 * @throws UsersetNotAllowedError when the tuple has a
 *   `subjectRelation` but the relation forbids userset subjects.
 */
export async function validateTupleWrite(
  store: TupleStore,
  request: AddTupleRequest,
): Promise<void> {
  const config = await store.findRelationConfig(
    request.objectType,
    request.relation,
  );
  if (!config) {
    throw new RelationConfigNotFoundError(request.objectType, request.relation);
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
}
