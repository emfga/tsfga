import {
  InvalidSubjectTypeError,
  RelationConfigNotFoundError,
  UsersetNotAllowedError,
} from "./errors.ts";
import type { TupleStore } from "./store-interface.ts";
import type { AddTupleRequest, RelationConfig } from "./types.ts";

/**
 * How a subject appears in `directlyAssignableTypes`: bare for an
 * ordinary subject, `type:*` for a wildcard one.
 */
export function directSubjectRef(
  subjectType: string,
  subjectId: string,
): string {
  return subjectId === "*" ? `${subjectType}:*` : subjectType;
}

/**
 * Whether the relation can hold a direct tuple for `subjectRef`.
 *
 * A `null` `directlyAssignableTypes` means *unrestricted*, not
 * *none* — the config declines to narrow the relation rather than
 * declaring it purely computed.
 *
 * The check algorithm gates its tuple reads on this same
 * predicate, which is why it lives here next to the write path
 * rather than in `check.ts`. The two must agree exactly: a read
 * gate stricter than the write gate would accept a tuple and then
 * never find it again.
 */
export function admitsDirectSubject(
  config: RelationConfig | null,
  subjectRef: string,
): boolean {
  const allowed = config?.directlyAssignableTypes;
  return !allowed || allowed.includes(subjectRef);
}

/** Whether the relation can hold userset (`object#relation`) rows. */
export function admitsUsersetSubjects(config: RelationConfig | null): boolean {
  // Unlike the type list this is a required boolean, so `false` is
  // always a positive exclusion and there is no null case.
  return config === null || config.allowsUsersetSubjects;
}

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

  const subjectRef = directSubjectRef(request.subjectType, request.subjectId);
  if (!admitsDirectSubject(config, subjectRef)) {
    throw new InvalidSubjectTypeError(
      subjectRef,
      request.objectType,
      request.relation,
      config.directlyAssignableTypes ?? [],
    );
  }

  if (request.subjectRelation && !admitsUsersetSubjects(config)) {
    throw new UsersetNotAllowedError(request.objectType, request.relation);
  }
}
