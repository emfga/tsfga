import { coerceContext } from "./conditions.ts";
import {
  type ConditionalTupleCause,
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
 * The config is required rather than nullable. It used to admit
 * `null` and answer `true` for it, which made a relation nobody
 * had configured the widest gate in the library instead of the
 * narrowest; every caller now establishes the config exists before
 * asking, and a relation without one is refused rather than
 * unrestricted.
 */
export function admitsSubjectShape(
  config: RelationConfig,
  shape: SubjectShape,
): boolean {
  return config.directlyAssignable.some((r) => sameShape(r, shape));
}

/**
 * Whether the relation admits exactly this restriction — type,
 * userset relation, wildcard **and** condition.
 *
 * Used by the clamp and by the write path, which are the two
 * places holding a real row.
 *
 * Exported so a consumer narrowing their own query can apply the
 * gate tsfga applies rather than reimplementing it and drifting.
 * Three hazards come with that, and they are why this is
 * documented rather than merely exposed:
 *
 * - **The config is not optional.** This used to accept `null` and
 *   answer `true` for it, matching a `check()` that read a missing
 *   config as unrestricted. Both are gone: `check()` now raises
 *   `RelationConfigNotFoundError` on a relation with no config, so
 *   the misspelled relation name that used to silently admit
 *   everything is a `null` the compiler makes you handle.
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
  config: RelationConfig,
  ref: TypeRestriction,
): boolean {
  return config.directlyAssignable.some(
    (r) => sameShape(r, ref) && r.condition === ref.condition,
  );
}

/**
 * The restrictions of this shape the relation admits, for the
 * store to narrow on.
 *
 * `[]` is a positive answer — the relation admits nothing of this
 * shape — and the caller reads it as "do not ask". There is no
 * "declines to narrow" answer any more: every relation a check
 * reaches has a config, so there is always something to narrow
 * against.
 */
export function admittedRefsForShape(
  config: RelationConfig,
  shape: SubjectShape,
): readonly TypeRestriction[] {
  return config.directlyAssignable.filter((r) => sameShape(r, shape));
}

/** The userset refs the relation admits. */
export function admittedUsersetRefs(
  config: RelationConfig,
): readonly TypeRestriction[] {
  return config.directlyAssignable.filter((r) => r.relation !== undefined);
}

/**
 * Whether a set of admitted refs covers this one.
 *
 * `null` declines to narrow and so admits everything; `[]` admits
 * nothing. Shared by the clamp and the store-reply checks so the
 * two cannot read the same query differently.
 *
 * **Deliberately still permissive on `null`,** where the config
 * gates above no longer are. This one reads a `CheckTuplesQuery`
 * rather than a config, and that type keeps its nullable fields:
 * they are how a wrapper says "I did not narrow this part", which
 * is a statement about a query and not about a model. Core stopped
 * emitting `null` in them — it always holds a config now — so what
 * the clamp compares against is always the real restriction list.
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
 * Whether the tuple says only what the model already says:
 * `doc:1#blocked@doc:1#blocked`.
 *
 * A predicate, not a gate, and deliberately **not** called from
 * `validateTupleWrite`. That function is shared by `addTuple` and
 * by contextual-tuple validation, and the two paths differ here:
 * upstream refuses the write and *accepts* the contextual tuple.
 * Only `addTuple` applies it.
 */
export function isSelfDefining(request: AddTupleRequest): boolean {
  return (
    request.subjectType === request.objectType &&
    request.subjectId === request.objectId &&
    request.subjectRelation === request.relation
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
  // Explicitly typed so TypeScript treats it as never-returning
  // and narrows after each call.
  const refuse: (cause: ConditionalTupleCause, detail?: string) => never = (
    cause,
    detail,
  ) => {
    throw new InvalidConditionalTupleError(
      cause,
      ref,
      request.objectType,
      request.relation,
      config.directlyAssignable,
      detail,
    );
  };

  // An unconditioned tuple needs a matching restriction that names
  // no condition. There is nothing further to check for it — no
  // definition to look up, no context to read — so it costs no
  // extra round-trip.
  if (ref.condition === undefined) {
    if (!admitsSubjectRef(config, ref)) refuse("condition is missing");
    return;
  }

  // Upstream's order, and it is observable: a name that is not
  // defined reports *that*, even when the restriction would not
  // have admitted it either. Probed against v1.18.2 — a defined
  // condition the restriction omits reports "invalid condition for
  // type restriction"; an undefined one reports "undefined
  // condition" whatever the restriction says.
  const definition = await store.findConditionDefinition(ref.condition);
  if (!definition) refuse("undefined condition");

  if (!admitsSubjectRef(config, ref)) {
    refuse("invalid condition for type restriction");
  }

  const context = request.conditionContext;
  if (!context) return;

  // Only the keys actually present are validated. A conditioned
  // tuple with no context at all, or with a partial one, is
  // accepted — probed — because the rest can still arrive with the
  // check request.
  try {
    coerceContext(definition.parameters, context);
  } catch (error) {
    refuse(
      "parameter type error",
      error instanceof Error ? error.message : String(error),
    );
  }

  // A key the condition does not declare can never be read, so it
  // is a mistake rather than spare data. Checked after the type
  // pass, which is upstream's order when a context has both
  // problems.
  const declared = definition.parameters ?? {};
  for (const key of Object.keys(context)) {
    if (!(key in declared)) {
      refuse("invalid context parameter", key);
    }
  }
}
