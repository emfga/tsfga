import {
  InvalidSubjectTypeError,
  RelationConfigNotFoundError,
} from "./errors.ts";
import type { TupleStore } from "./store-interface.ts";
import type { AddTupleRequest, RelationConfig } from "./types.ts";

/**
 * How a subject appears in `directlyAssignable`.
 *
 * The three forms are OpenFGA's: bare `type` for an ordinary
 * subject, `type:*` for the typed wildcard, `type#relation` for a
 * userset. A userset ref names the relation, so `team#member` and
 * `team#owner` are different restrictions and a relation admitting
 * one does not admit the other.
 *
 * Exported alongside `admitsSubjectRef`, which takes the ref this
 * builds rather than the three parts, so that the two cannot be
 * combined wrongly.
 */
export function directSubjectRef(
  subjectType: string,
  subjectId: string,
  subjectRelation?: string | null,
): string {
  if (subjectRelation !== null && subjectRelation !== undefined) {
    return `${subjectType}#${subjectRelation}`;
  }
  return subjectId === "*" ? `${subjectType}:*` : subjectType;
}

/**
 * Whether the relation admits a direct assignment of `subjectRef`.
 *
 * A `null` config means *unrestricted*: no config was found, so
 * there is nothing to narrow against. That is distinct from a
 * config whose `directlyAssignable` is `[]`, which is a positive
 * statement that the relation admits nothing directly.
 *
 * The check algorithm gates its tuple reads on this same
 * predicate, which is why it lives here next to the write path
 * rather than in `check.ts`. The two must agree exactly: a read
 * gate stricter than the write gate would accept a tuple and then
 * never find it again, and a looser one would grant on a tuple the
 * model does not admit.
 *
 * Exported so a consumer narrowing their own query can apply the
 * gate tsfga applies, instead of reimplementing it and drifting.
 * Two hazards come with that, and they are the reason it is
 * documented rather than merely exposed:
 *
 * - **`null` is permissive.** It has to be, or this would not
 *   match `check()`, and agreement is the whole point. But inside
 *   `check()` a `null` config means the relation is unconstrained;
 *   in a consumer's `WHERE` clause it usually means the relation
 *   name was misspelled, and the filter then silently admits
 *   everything. Look the config up yourself and fail on `null` if
 *   that is what you meant.
 * - **This is not the whole gate.** It filters tuple *shapes*. It
 *   knows nothing of `excludedBy` or `intersection`, which revoke
 *   a grant after the row is read, so a row passing this predicate
 *   is a row `check()` will *consider*, not one it will allow.
 */
export function admitsSubjectRef(
  config: RelationConfig | null,
  subjectRef: string,
): boolean {
  return config === null || config.directlyAssignable.includes(subjectRef);
}

/** The userset refs the relation admits; `null` when unrestricted. */
export function admittedUsersetRefs(
  config: RelationConfig | null,
): readonly string[] | null {
  if (config === null) return null;
  return config.directlyAssignable.filter((ref) => ref.includes("#"));
}

/**
 * Validate that a tuple is writable under the relation's config.
 * Used by both `addTuple` and contextual-tuple validation so the
 * two paths cannot drift apart.
 *
 * Userset tuples are validated on the full `type#relation` ref,
 * matching OpenFGA, which refuses
 * `document:budget#viewer@team:eng#owner` when `document#viewer`
 * admits only `team#member`.
 *
 * @throws RelationConfigNotFoundError when no relation config
 *   exists for the tuple's object type + relation.
 * @throws InvalidSubjectTypeError when the subject ref — `type`,
 *   `type:*` or `type#relation` — is not directly assignable.
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

  const subjectRef = directSubjectRef(
    request.subjectType,
    request.subjectId,
    request.subjectRelation,
  );
  if (!admitsSubjectRef(config, subjectRef)) {
    throw new InvalidSubjectTypeError(
      subjectRef,
      request.objectType,
      request.relation,
      config.directlyAssignable,
    );
  }
}
