import {
  InvalidConditionalTupleError,
  InvalidSubjectTypeError,
  RelationConfigNotFoundError,
} from "./errors.ts";
import type { TupleStore } from "./store-interface.ts";
import type {
  AddTupleRequest,
  RelationConfig,
  TypeRestriction,
} from "./types.ts";

/**
 * A subject ref with its condition dropped.
 *
 * The type dimension and the condition dimension are checked
 * separately, because OpenFGA checks them separately and answers
 * differently for each: a wrong *type* is refused by the type
 * pass, which never looks at the condition
 * (`internal/validation/validation.go`), and a wrong condition on
 * an admitted type is a different error with its own cause. This
 * is the value the first pass compares.
 */
export interface SubjectShape {
  type: string;
  /** Set for a userset ref: `team#member`. */
  relation?: string;
  /** Set for the typed wildcard: `user:*`. */
  wildcard?: true;
}

/**
 * The shape a tuple's subject presents to a type restriction.
 *
 * A wildcard row is one whose subject id is literally `*`, so the
 * id is what distinguishes `user:*` from `user`; a subject
 * relation makes it a userset regardless of the id.
 */
export function subjectShape(
  subjectType: string,
  subjectId: string,
  subjectRelation: string | null | undefined,
): SubjectShape {
  if (subjectRelation !== null && subjectRelation !== undefined) {
    return { type: subjectType, relation: subjectRelation };
  }
  if (subjectId === "*") {
    return { type: subjectType, wildcard: true };
  }
  return { type: subjectType };
}

/**
 * The full restriction a tuple must be admitted under, condition
 * included.
 *
 * `conditionName` is a **required** parameter rather than an
 * optional fourth one. Every caller has to state it, so adding the
 * condition dimension made the compiler enumerate the call sites
 * instead of letting an existing one keep compiling while silently
 * building an unconditioned ref — which is the fail-open direction.
 */
export function directSubjectRef(
  subjectType: string,
  subjectId: string,
  subjectRelation: string | null | undefined,
  conditionName: string | null | undefined,
): TypeRestriction {
  const shape = subjectShape(subjectType, subjectId, subjectRelation);
  if (conditionName === null || conditionName === undefined) return shape;
  return { ...shape, condition: conditionName };
}

/** Whether two restrictions name the same shape, condition aside. */
function sameShape(restriction: TypeRestriction, shape: SubjectShape): boolean {
  return (
    restriction.type === shape.type &&
    restriction.relation === shape.relation &&
    restriction.wildcard === shape.wildcard
  );
}

/**
 * Whether the relation admits *any* assignment of this shape,
 * whatever condition it carries.
 *
 * This is the read gate, and it is condition-blind **by
 * necessity**: it runs before the row exists, and the condition
 * lives on the row. Asking for a conditioned row and a bare one
 * separately would be two queries for what the store answers in
 * one.
 *
 * So the gate is deliberately wider than the write gate. What
 * makes that safe is that `clampToQuery` performs the exact
 * four-field match on the reply, before the check algorithm sees a
 * row. The invariant is `readGate ⊇ writeGate ∧ clamp ≡ writeGate`
 * — *not* that the two gates agree, which they cannot.
 *
 * A `null` config is unrestricted, which satisfies that invariant
 * trivially rather than strongly.
 */
export function admitsSubjectShape(
  config: RelationConfig | null,
  shape: SubjectShape,
): boolean {
  return (
    config === null ||
    config.directlyAssignable.some((r) => sameShape(r, shape))
  );
}

/**
 * Whether the relation admits exactly this restriction — type,
 * userset relation, wildcard **and** condition.
 *
 * Used by the clamp and by the write path, which are the two
 * places holding a real row. A `null` config is unrestricted, as
 * for the shape gate.
 *
 * Exported so a consumer narrowing their own query can apply the
 * gate tsfga applies rather than reimplementing it and drifting.
 * Three hazards come with that, and they are why this is
 * documented rather than merely exposed:
 *
 * - **`null` is permissive.** It has to be, or this would not
 *   match `check()`. But inside `check()` a `null` config means
 *   the relation is unconstrained; in a consumer's `WHERE` clause
 *   it usually means the relation name was misspelled, and the
 *   filter then silently admits everything. Look the config up
 *   yourself and fail on `null` if that is what you meant.
 * - **This is not the read gate.** Narrowing a query by this
 *   predicate is narrowing by the *exact* restriction, which is
 *   correct for filtering rows you already hold and wrong for
 *   deciding which rows to fetch — the condition is on the row.
 *   Use `admitsSubjectShape` to decide what to ask for.
 * - **This is not the whole gate either.** It filters tuple
 *   shapes. It knows nothing of `excludedBy` or `intersection`,
 *   which revoke a grant after the row is read, so a row passing
 *   it is a row `check()` will *consider*, not one it will allow.
 */
export function admitsSubjectRef(
  config: RelationConfig | null,
  ref: TypeRestriction,
): boolean {
  if (config === null) return true;
  return config.directlyAssignable.some(
    (r) => sameShape(r, ref) && r.condition === ref.condition,
  );
}

/**
 * The restrictions of this shape the relation admits, for the
 * store to narrow on; `null` when the relation declines to narrow.
 *
 * `[]` is a positive answer — the relation admits nothing of this
 * shape — and the caller reads it as "do not ask".
 */
export function admittedRefsForShape(
  config: RelationConfig | null,
  shape: SubjectShape,
): readonly TypeRestriction[] | null {
  if (config === null) return null;
  return config.directlyAssignable.filter((r) => sameShape(r, shape));
}

/** The userset refs the relation admits; `null` when unrestricted. */
export function admittedUsersetRefs(
  config: RelationConfig | null,
): readonly TypeRestriction[] | null {
  if (config === null) return null;
  return config.directlyAssignable.filter((r) => r.relation !== undefined);
}

/**
 * Whether a set of admitted refs covers this one.
 *
 * `null` declines to narrow and so admits everything; `[]` admits
 * nothing. Shared by the clamp and the store-reply checks so the
 * two cannot read the same query differently.
 */
export function refsAdmit(
  refs: readonly TypeRestriction[] | null,
  ref: TypeRestriction,
): boolean {
  if (refs === null) return true;
  return refs.some(
    (r) =>
      r.type === ref.type &&
      r.relation === ref.relation &&
      r.wildcard === ref.wildcard &&
      r.condition === ref.condition,
  );
}

/**
 * Validate that a tuple is writable under the relation's config.
 * Used by both `addTuple` and contextual-tuple validation so the
 * two paths cannot drift apart.
 *
 * The two dimensions are checked in OpenFGA's order and reported
 * as OpenFGA reports them: the type first, condition-blind, then
 * the condition. Folding the second into `InvalidSubjectTypeError`
 * would produce `Subject type 'user with weekday_only' is not
 * allowed`, which names a type nobody wrote.
 *
 * @throws RelationConfigNotFoundError when no relation config
 *   exists for the tuple's object type + relation.
 * @throws InvalidSubjectTypeError when the subject's shape —
 *   `type`, `type:*` or `type#relation` — is not directly
 *   assignable under any condition.
 * @throws InvalidConditionalTupleError when the shape is
 *   assignable but not with the condition the tuple carries, or
 *   without one.
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

  const shape = subjectShape(
    request.subjectType,
    request.subjectId,
    request.subjectRelation,
  );
  if (!admitsSubjectShape(config, shape)) {
    throw new InvalidSubjectTypeError(
      shape,
      request.objectType,
      request.relation,
      config.directlyAssignable,
    );
  }

  const ref = directSubjectRef(
    request.subjectType,
    request.subjectId,
    request.subjectRelation,
    request.conditionName,
  );
  if (!admitsSubjectRef(config, ref)) {
    // Upstream's two causes for this, discriminated the same way:
    // a tuple carrying no condition where every matching
    // restriction has one is "condition is missing"; anything else
    // is a condition the restriction does not name.
    throw new InvalidConditionalTupleError(
      ref.condition === undefined
        ? "condition is missing"
        : "invalid condition for type restriction",
      ref,
      request.objectType,
      request.relation,
      config.directlyAssignable,
    );
  }
}
