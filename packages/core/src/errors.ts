import type { SubjectShape } from "./tuple-validation.ts";
import type { TypeRestriction } from "./types.ts";
import type { WriteRuleId } from "./write-rules.ts";

/**
 * The base every error this library raises extends, so a caller
 * can catch the whole surface with one `instanceof`.
 *
 * It is also raised **directly**, in one narrow family: a refusal
 * about the caller's own arguments that upstream cannot express
 * because its own field would not hold the value — an option
 * outside its domain (`listObjectsMaxResults`, `maxBreadth`,
 * `maxConditionEvaluationCost`, `maxConcurrentChecks`, `maxDepth`,
 * `writeContextByteLimit`). These are argument errors, not
 * authorization outcomes, and giving each a class would grow the
 * surface without giving a caller anything to do differently.
 *
 * A malformed object id is no longer among them: it has
 * `InvalidObjectError`, which extends this class, so a caller
 * catching `TsfgaError` sees it either way.
 */
export class TsfgaError extends Error {
  /**
   * Which write rule refused, when a write rule did.
   *
   * `null` everywhere else -- an option error, a check-path
   * refusal, an evaluation failure. It is the join between the
   * code that refuses and
   * `packages/core/write-gate-causes.json`, and it is what lets an
   * assertion be about *which* of two competing refusals won: a
   * tuple carrying two defects is refused by whichever rule runs
   * first, and a test that can only see "refused" reports a
   * reordering as green.
   *
   * See `write-rules.ts` for the two namespaces and why there are
   * two.
   */
  readonly ruleId: WriteRuleId | null;

  constructor(message: string, ruleId?: WriteRuleId) {
    super(message);
    this.name = "TsfgaError";
    this.ruleId = ruleId ?? null;
  }
}

export class RelationConfigNotFoundError extends TsfgaError {
  constructor(objectType: string, relation: string, ruleId?: WriteRuleId) {
    super(`No relation config found for ${objectType}.${relation}`, ruleId);
    this.name = "RelationConfigNotFoundError";
  }
}

/**
 * A type restriction in OpenFGA's own notation — `user`,
 * `user:*`, `team#member`, `user with weekday_only`.
 *
 * Only for messages. Everything that decides anything matches the
 * structured fields; rendering to a string is the last step, so
 * nothing is ever re-parsed out of one.
 */
export function formatRestriction(restriction: TypeRestriction): string {
  const base = restriction.wildcard
    ? `${restriction.type}:*`
    : restriction.relation !== undefined
      ? `${restriction.type}#${restriction.relation}`
      : restriction.type;
  return restriction.condition === undefined
    ? base
    : `${base} with ${restriction.condition}`;
}

/**
 * Every way a subject ref can be refused before its condition is
 * ever considered.
 *
 * `undefined` — no cause at all — is the ordinary case: the type is
 * well-formed and defined, and simply not among the ones the
 * relation admits. The named causes are the two refusals upstream
 * reports on the `user` field ahead of any type restriction, in
 * `ValidateUser` (`internal/validation/validation.go:357-380`).
 *
 * They are causes on `InvalidSubjectTypeError` rather than classes
 * of their own, and rather than `ConditionalTupleCause` values,
 * because both are decided without reading the condition.
 */
export type SubjectDefect =
  /**
   * The ref is not well-formed at all — `team:*#member`, a wildcard
   * id carrying a subject relation — which upstream refuses in
   * `IsValidUser` before the type is looked up at all
   * (`pkg/tuple/tuple.go:477-517`).
   */
  | "malformed subject"
  /**
   * The ref is well-formed, but its type is not one the model
   * defines. Upstream's `TypeNotFoundError` on the `user` field,
   * raised immediately after the well-formedness check and before
   * any type restriction is consulted.
   *
   * Distinct from the ordinary no-cause refusal, which is about a
   * type the model *does* define and this relation does not admit.
   */
  | "undefined subject type";

/**
 * The subject's *type* is not assignable here, whatever condition
 * it might carry.
 *
 * Deliberately condition-blind, and raised before the condition is
 * considered at all. The condition dimension has its own error —
 * see `InvalidConditionalTupleError` — because reporting it here
 * would render as `Subject type 'user with weekday_only' is not
 * allowed`, naming a type that does not exist.
 */
export class InvalidSubjectTypeError extends TsfgaError {
  /**
   * Why the subject was refused, when the reason is not simply
   * "the relation does not admit this type".
   *
   * `undefined` is the ordinary case, so every refusal that names
   * no cause keeps its original message. See `SubjectDefect` for
   * the named ones.
   */
  override readonly cause?: SubjectDefect;
  /** The subject ref the write named. */
  readonly subject: SubjectShape;
  readonly objectType: string;
  readonly relation: string;
  /**
   * Everything the relation admits.
   *
   * Deliberately not in the message. `addTuple`'s errors are the
   * ones a service is most likely to hand back to whoever
   * attempted the write, and the list names every admitted type,
   * every userset relation and every condition -- a description of
   * the authorization model, disclosed to anyone who can attempt a
   * write and get the message back. OpenFGA names only the
   * offending type. A caller with a legitimate reason to see the
   * list reads it here.
   *
   * `[]` on a refusal that names a `SubjectDefect` means the
   * restrictions were never consulted, not that the relation
   * admits nothing: those causes are decided ahead of them, and
   * the list is carried only where the caller already held the
   * config.
   */
  readonly allowed: readonly TypeRestriction[];

  constructor(
    subject: SubjectShape,
    objectType: string,
    relation: string,
    allowed: readonly TypeRestriction[],
    cause?: SubjectDefect,
    detail?: string,
    ruleId?: WriteRuleId,
  ) {
    super(
      cause === undefined
        ? `Subject type '${formatRestriction(subject)}' is not allowed for ` +
            `${objectType}.${relation}`
        : `Invalid subject for ${objectType}.${relation}: ${cause}` +
            (detail === undefined ? "" : ` (${detail})`),
      ruleId,
    );
    this.name = "InvalidSubjectTypeError";
    if (cause !== undefined) this.cause = cause;
    this.subject = subject;
    this.objectType = objectType;
    this.relation = relation;
    this.allowed = allowed;
  }
}

/**
 * Every way the object half of a request or a write can be
 * refused, before anything about the subject or the condition is
 * considered.
 *
 * Upstream decides all three in `ValidateObject`, reached from
 * `ValidateUserObjectRelation` — which `CheckCommand` and
 * `WriteCommand` (through `ValidateTupleForWrite`) both call — so
 * one predicate covers the check path, the write path and
 * contextual tuples.
 *
 * A cause string rather than a class each, for the reason
 * `ConditionalTupleCause` is one: upstream reports a single
 * validation error and discriminates by message.
 */
export type ObjectDefect =
  /**
   * The id is empty, or holds a character `type:id` cannot carry
   * — `:`, `#`, a space, or a Unicode control character.
   *
   * `IsValidObject` is **not** `IsValidUserID`. It walks the whole
   * `type:id` string, so the one `:` it allows is the type
   * separator — which tsfga carries in a field of its own, making
   * any `:` in `objectId` a second one. It has no userset arm
   * either, so a `#` is refused outright rather than reinterpreted.
   */
  | "malformed object id"
  /**
   * The id is `*`.
   *
   * A typed wildcard is a *subject*, never an object: upstream
   * admits `user:*` on the `user` field through `ValidateUser` and
   * refuses `doc:*` on the `object` field. So a `subjectId` of `*`
   * stays legal and an `objectId` of `*` does not.
   */
  | "object id is a typed wildcard"
  /**
   * The rendered `type:id` string is longer than the bound.
   *
   * The bound is the caller's, not this error's: the write path and
   * the check path measure the same string against the limit each
   * inherits from upstream, and the detail names the measurement.
   */
  | "object too long";

/**
 * The object the request or the write named is not one the model
 * can carry.
 *
 * Its own class rather than a cause on `InvalidSubjectTypeError`,
 * whose `subject` field would have to be a lie, and rather than
 * the bare `TsfgaError` this was raised as provisionally: the
 * object half of a request is refused on both the read and the
 * write path, and a caller that wants to tell "you named a bad
 * object" from "you passed a bad option" has nothing to switch on
 * otherwise.
 *
 * Nothing about the model is disclosed — the message names only
 * what the caller sent, as upstream's does, and for the reason
 * `InvalidSubjectTypeError` keeps its allow-list off the message.
 */
export class InvalidObjectError extends TsfgaError {
  override readonly cause: ObjectDefect;
  readonly objectType: string;
  readonly objectId: string;

  constructor(
    cause: ObjectDefect,
    objectType: string,
    objectId: string,
    detail?: string,
    ruleId?: WriteRuleId,
  ) {
    super(
      `Invalid object '${objectType}:${objectId}': ${cause}` +
        (detail === undefined ? "" : ` (${detail})`),
      ruleId,
    );
    this.name = "InvalidObjectError";
    this.cause = cause;
    this.objectType = objectType;
    this.objectId = objectId;
  }
}

/**
 * Every way a tuple's condition can fail against the model.
 *
 * OpenFGA raises one error type for all of them and discriminates
 * by a cause string (`internal/validation/validation.go`), so
 * tsfga does the same rather than inventing a class per cause —
 * one upstream error, one tsfga error.
 */
export type ConditionalTupleCause =
  /** No condition on the tuple, but every matching restriction has one. */
  | "condition is missing"
  /** A condition the matching restrictions do not name. */
  | "invalid condition for type restriction"
  /** The condition is not defined in the store. */
  | "undefined condition"
  /** A context value cannot be read as its declared parameter type. */
  | "parameter type error"
  /** A context key the condition does not declare. */
  | "invalid context parameter"
  /**
   * The context is larger than the write limit.
   *
   * Upstream measures a serialised protobuf `Struct` against
   * `DefaultWriteContextByteLimit` (32 KiB,
   * `pkg/server/config/config.go:36`); tsfga cannot reproduce that
   * encoding, so it measures the JSON. The rule is the same; the
   * measure diverges, and only near the boundary.
   */
  | "context size limit exceeded"
  /**
   * A key or string value holds a Unicode control character.
   *
   * Go's `unicode.IsControl` — `U+0000`-`U+001F` and
   * `U+007F`-`U+009F` (`internal/utils/sanitize.go:8-11`). Nested
   * lists and structs are in scope, and so is the condition name.
   */
  | "context contains forbidden characters";

/**
 * The subject's type is assignable, but not with the condition the
 * tuple carries — or without one.
 */
export class InvalidConditionalTupleError extends TsfgaError {
  override readonly cause: ConditionalTupleCause;
  /** The subject ref the write named. */
  readonly subject: TypeRestriction;
  readonly objectType: string;
  readonly relation: string;
  /**
   * Everything the relation admits.
   *
   * On the error, not in the message, for the reason given on
   * `InvalidSubjectTypeError`: rendering it would disclose the
   * relation's whole type restriction list -- every admitted type,
   * every userset relation, every condition name -- to whoever can
   * attempt a write and read the response.
   */
  readonly allowed: readonly TypeRestriction[];

  constructor(
    cause: ConditionalTupleCause,
    subject: TypeRestriction,
    objectType: string,
    relation: string,
    allowed: readonly TypeRestriction[],
    detail?: string,
    ruleId?: WriteRuleId,
  ) {
    super(
      `Invalid conditional tuple for ${objectType}.${relation}: ${cause}` +
        (detail === undefined ? "" : ` (${detail})`) +
        `. Subject: '${formatRestriction(subject)}'`,
      ruleId,
    );
    this.name = "InvalidConditionalTupleError";
    this.cause = cause;
    this.subject = subject;
    this.objectType = objectType;
    this.relation = relation;
    this.allowed = allowed;
  }
}

/**
 * The tuple says only what the model already says.
 *
 * `doc:1#blocked@doc:1#blocked` asserts that the relation contains
 * itself, which is true by definition, so upstream refuses to
 * store it: `Reason: cannot write a tuple that is implicit`.
 *
 * Refused on the **write** path only. A contextual tuple of the
 * same shape is accepted upstream — measured on v1.18.2, with a
 * control proving the field was honoured — so the asymmetry is
 * deliberate, not an oversight about where the check belongs.
 */
export class ImplicitTupleError extends TsfgaError {
  readonly objectType: string;
  readonly objectId: string;
  readonly relation: string;

  constructor(
    objectType: string,
    objectId: string,
    relation: string,
    ruleId?: WriteRuleId,
  ) {
    const ref = `${objectType}:${objectId}#${relation}`;
    super(`Cannot write a tuple that is implicit: ${ref}@${ref}`, ruleId);
    this.name = "ImplicitTupleError";
    this.objectType = objectType;
    this.objectId = objectId;
    this.relation = relation;
  }
}

/**
 * The tuple is already stored.
 *
 * Upstream's `on_duplicate` defaults to `error`
 * (`pkg/server/commands/write.go:58-67`), so a second write of the
 * same edge is refused rather than absorbed. The natural key is
 * upstream's `TupleKeyWithoutCondition`: **the condition is not
 * part of it**, so rewriting a live grant with a different
 * condition is a duplicate too, not a second row.
 */
export class DuplicateTupleError extends TsfgaError {
  readonly objectType: string;
  readonly objectId: string;
  readonly relation: string;
  readonly subjectType: string;
  readonly subjectId: string;
  readonly subjectRelation: string | null;

  constructor(
    objectType: string,
    objectId: string,
    relation: string,
    subjectType: string,
    subjectId: string,
    subjectRelation: string | null,
    ruleId?: WriteRuleId,
  ) {
    const subject =
      subjectRelation === null
        ? `${subjectType}:${subjectId}`
        : `${subjectType}:${subjectId}#${subjectRelation}`;
    super(
      `Cannot write a tuple which already exists: ` +
        `${objectType}:${objectId}#${relation}@${subject}`,
      ruleId,
    );
    this.name = "DuplicateTupleError";
    this.objectType = objectType;
    this.objectId = objectId;
    this.relation = relation;
    this.subjectType = subjectType;
    this.subjectId = subjectId;
    this.subjectRelation = subjectRelation;
  }
}

/**
 * The tuple is not there.
 *
 * Upstream's `on_missing` defaults to `error`
 * (`pkg/server/commands/write.go`), so deleting a row that does
 * not exist is refused rather than absorbed --
 * `write_failed_due_to_invalid_input`. `removeTuple` used to
 * answer `false` for it, which encoded an outcome OpenFGA has no
 * word for.
 *
 * Named for `on_missing`, as `DuplicateTupleError` is named for
 * `on_duplicate`, and carrying the same fields: this is the same
 * refusal reached from the other direction, and upstream reports
 * both through one sentinel.
 */
export class MissingTupleError extends TsfgaError {
  readonly objectType: string;
  readonly objectId: string;
  readonly relation: string;
  readonly subjectType: string;
  readonly subjectId: string;
  readonly subjectRelation: string | null;

  constructor(
    objectType: string,
    objectId: string,
    relation: string,
    subjectType: string,
    subjectId: string,
    subjectRelation: string | null,
    ruleId?: WriteRuleId,
  ) {
    const subject =
      subjectRelation === null
        ? `${subjectType}:${subjectId}`
        : `${subjectType}:${subjectId}#${subjectRelation}`;
    super(
      `Cannot delete a tuple which does not exist: ` +
        `${objectType}:${objectId}#${relation}@${subject}`,
      ruleId,
    );
    this.name = "MissingTupleError";
    this.objectType = objectType;
    this.objectId = objectId;
    this.relation = relation;
    this.subjectType = subjectType;
    this.subjectId = subjectId;
    this.subjectRelation = subjectRelation;
  }
}

/**
 * Every way a relation config can be malformed against the rules
 * OpenFGA's typesystem enforces when it validates a model.
 *
 * A cause string rather than a class each, for the same reason
 * `ConditionalTupleCause` is: upstream reports these as one
 * invalid-model error discriminated by its message.
 */
export type RelationConfigDefect =
  /**
   * The object type's own name is not one the model can carry.
   *
   * Upstream refuses it at the API boundary, before the typesystem
   * ever sees the model — `type_invalid_pattern` for a name the
   * proto pattern `^[^:#@\s]{1,254}$` rejects, and
   * `type_invalid_length` for an empty or over-long one
   * (`pkg/server/errors/encoded_errors.go:190-198`). One cause
   * covers both: upstream's own split is between two proto
   * constraints on the same field, not between two defects.
   *
   * `\s` is Go's five whitespace characters — tab, newline, form
   * feed, carriage return and space — and **nothing wider**. There
   * is no general control-character rule here: U+000B, U+0001,
   * U+007F, U+0085, U+00A0, U+2028 and U+3000 are all stored,
   * measured against the v1.18.2 container. The bound counts code
   * points, not bytes and not UTF-16 units.
   */
  | "malformed type name"
  /**
   * The relation's own name is not one the model can carry.
   *
   * `relation_invalid_pattern` / `relation_invalid_length`, the
   * same pair on the relation field, and the same character class
   * — `^[^:#@\s]{1,50}$`, differing from a type name's only in the
   * bound. `IsValidRelation` (`pkg/tuple/tuple.go:440-457`) is a
   * later gate on the *tuple* path and is not what refuses a
   * model.
   */
  | "malformed relation name"
  /**
   * A condition's own name is not one the model can carry.
   *
   * `Condition.name` carries the same proto pattern as a relation
   * name, `^[^:#@\s]{1,50}$`, so the predicate and the bound are
   * the ones above and only the field differs. A condition stored
   * under a name upstream refuses is one no type restriction in an
   * OpenFGA-acceptable model could ever name.
   *
   * On `InvalidRelationConfigError` rather than a class of its own
   * for the reason the whole union exists: upstream reports one
   * invalid-model error and discriminates by message.
   */
  | "malformed condition name"
  /**
   * A condition parameter's name is not one the model can carry.
   *
   * Every key of `Condition.parameters` carries the same pattern
   * under the same bound. Separate from the condition's own name
   * because it is a different loop, and because a parameter name
   * is the one place the model's name class and CEL's identifier
   * grammar disagree: CEL cannot *reference* a parameter named
   * `bad:p`, but the model gate refuses it before that matters.
   */
  | "malformed condition parameter name"
  /**
   * The object type's or the relation's name is one the DSL
   * reserves — `self` or `this`.
   *
   * Upstream refuses it in `validateNames`
   * (`pkg/typesystem/typesystem.go`), which looks at type and
   * relation names and at **nothing else**. It is deliberately not
   * a condition-name rule: v1.18.2 stores a condition named `self`
   * without complaint, measured against the container.
   *
   * Separate from `"malformed type name"` and
   * `"malformed relation name"`, which are the proto pattern and
   * the length bound. A reserved name passes both and is still
   * refused, and upstream's message for it is a different one.
   */
  | "reserved keyword"
  /**
   * A rewrite on the same object names the relation it defines,
   * so the relation is defined in terms of itself with no tuple in
   * between (`viewer: viewer`, `viewer: a or viewer`,
   * `viewer: a but not viewer`).
   *
   * Exactly four positions: `computedUserset`, an entry of
   * `impliedBy`, `excludedBy`, and an `intersection` operand of
   * type `computedUserset`.
   *
   * **`tupleToUserset` is not one of them.**
   * `viewer: viewer from parent` names its own relation on
   * *another* object, which is upstream's single most common model
   * shape and is valid.
   */
  | "rewrite names its own relation"
  /** A set operation with fewer than two children. */
  | "intersection has fewer than two operands"
  /** A tupleset relation may not be assignable to a userset. */
  | "tupleset relation admits a userset"
  /** A tupleset relation may not be assignable to a wildcard. */
  | "tupleset relation admits a wildcard"
  /** A type restriction names a condition the store has not got. */
  | "undefined condition"
  /**
   * A tupleset relation must be directly assignable and nothing
   * else — upstream requires its rewrite to be exactly
   * `Userset_This` (`pkg/typesystem/typesystem.go:1301-1304`).
   */
  | "tupleset relation is not a direct relation"
  /**
   * Type restrictions on a relation that admits no direct
   * assignment at all (`pkg/typesystem/error.go:147-150`).
   *
   * Not the converse: `directlyAssignable` beside `impliedBy`,
   * `computedUserset`, `tupleToUserset` or `excludedBy` is
   * upstream's `union(This, …)` / `difference(This, …)`, and both
   * are valid.
   */
  | "type restrictions on a non-assignable relation"
  /**
   * The relation admits nothing and rewrites nothing, so it can
   * never grant (`pkg/typesystem/error.go:142-145`). An empty
   * `directlyAssignable` on its own is *not* this — that is how a
   * purely computed relation is spelled.
   */
  | "relation admits nothing and rewrites nothing"
  /**
   * Nothing can ever enter the relation: its only arm is a
   * tuple-to-userset whose computed relation is itself.
   */
  | "relation has no entrypoint"
  /**
   * No type the tupleset relation admits defines the computed
   * relation (`pkg/typesystem/typesystem.go:1306-1318`). *Some*
   * type failing to define it is fine and stays fine — that is the
   * per-row skip `resolveTupleset` makes.
   */
  | "computed relation undefined on every tupleset type"
  /** A rewrite names a relation the object type does not define. */
  | "undefined relation"
  /**
   * The rewrites lead back to a relation already on the path --
   * `viewer: editor` beside `editor: viewer`. Upstream's
   * `ErrCycle`: "an authorization model cannot contain a cycle".
   *
   * Distinct from `rewrite names its own relation`, which is the
   * depth-1 case and which upstream reports as a different cause
   * from a different function.
   */
  | "rewrite cycle";

/**
 * A piece of the model the model would not admit.
 *
 * Named for the relation config because that is where every cause
 * but two is raised. The two condition-name causes are part of the
 * same upstream error — one invalid-model refusal, discriminated
 * by message — and a condition definition has no object type and
 * no relation, so both fields are `null` on those and the message
 * names the condition instead.
 */
export class InvalidRelationConfigError extends TsfgaError {
  override readonly cause: RelationConfigDefect;
  /** `null` when the defect is a condition definition's, not a config's. */
  readonly objectType: string | null;
  /** `null` for the same reason. */
  readonly relation: string | null;
  /** The condition the write named, on the two condition causes. */
  readonly conditionName?: string;

  constructor(
    cause: RelationConfigDefect,
    objectType: string | null,
    relation: string | null,
    detail?: string,
    conditionName?: string,
    ruleId?: WriteRuleId,
  ) {
    const where =
      objectType === null || relation === null
        ? `Invalid condition definition` +
          (conditionName === undefined ? "" : ` '${conditionName}'`)
        : `Invalid relation config for ${objectType}.${relation}`;
    super(
      `${where}: ${cause}${detail === undefined ? "" : ` (${detail})`}`,
      ruleId,
    );
    this.name = "InvalidRelationConfigError";
    this.cause = cause;
    this.objectType = objectType;
    this.relation = relation;
    if (conditionName !== undefined) this.conditionName = conditionName;
  }
}

/**
 * Every way a request's own CEL context can be refused, before
 * anything is resolved.
 *
 * A cause string rather than a class each, for the reason
 * `ConditionalTupleCause` is one.
 */
export type RequestContextDefect =
  /**
   * A key or string value holds a Unicode control character.
   *
   * Go's `unicode.IsControl` — `U+0000`-`U+001F` and
   * `U+007F`-`U+009F`. Nested lists and structs are in scope;
   * numbers, booleans and nulls carry no characters and are
   * skipped, exactly as upstream's switch on the value kind skips
   * them (`ValidateStruct`,
   * `internal/validation/validation.go:402-441`).
   */
  "context contains forbidden characters";

/**
 * The request's own context is one upstream refuses.
 *
 * Distinct from `InvalidConditionalTupleError`, which is about a
 * *tuple's* condition context and names the tuple's subject and
 * relation. Upstream reports this one as a request-level
 * `validation_error` from `CheckCommand`, before it resolves
 * anything (`pkg/server/commands/check_command.go:197`), so it
 * names nothing but the context — there is no tuple to blame and
 * naming one would be a lie.
 *
 * Raised at the entry to `check` and `checkMany`, ahead of any
 * store read, and **nowhere else**. `listObjects` and
 * `listSubjects` do not apply the gate: upstream's nearest
 * requests to them are `ListObjects` and `ListUsers`, neither of
 * which is a check, and `ValidateStruct` runs from `CheckCommand`
 * alone. Borrowing it would refuse a call upstream answers.
 */
export class InvalidRequestContextError extends TsfgaError {
  override readonly cause: RequestContextDefect;
  /**
   * Where in the context the offending value sits, outermost key
   * first — `["claims", "roles"]` for a bad string inside a list
   * under `claims.roles`.
   *
   * `[]` means the walk did not track a path to it; the value
   * itself is still on the error and in the message, which is
   * what upstream reports.
   */
  readonly path: readonly string[];
  /** The offending key or string value, when one was isolated. */
  readonly value?: string;

  constructor(
    cause: RequestContextDefect,
    path: readonly string[],
    value?: string,
    ruleId?: WriteRuleId,
  ) {
    super(
      `Invalid request context` +
        (path.length === 0 ? "" : ` at '${path.join(".")}'`) +
        `: ${cause}` +
        (value === undefined ? "" : ` ('${value}')`),
      ruleId,
    );
    this.name = "InvalidRequestContextError";
    this.cause = cause;
    this.path = path;
    if (value !== undefined) this.value = value;
  }
}

export class ConditionNotFoundError extends TsfgaError {
  constructor(conditionName: string) {
    super(`Condition definition not found: ${conditionName}`);
    this.name = "ConditionNotFoundError";
  }
}

/**
 * The expression does not compile.
 *
 * Distinct from `ConditionEvaluationError`, which is a condition
 * that compiled and then could not be *evaluated* against a
 * context. This one has no context and no tuple: the definition is
 * unusable on its own, and OpenFGA refuses the model write that
 * carries it rather than deferring to the first check.
 */
export class ConditionCompileError extends TsfgaError {
  override readonly cause: unknown;
  constructor(conditionName: string, cause: unknown, ruleId?: WriteRuleId) {
    super(`Failed to compile condition '${conditionName}': ${cause}`, ruleId);
    this.name = "ConditionCompileError";
    this.cause = cause;
  }
}

/**
 * A condition compiled and then could not be evaluated against a
 * context.
 *
 * `cause` is free-form — whatever the evaluator threw — rather
 * than a discriminating union, and it stays that way: the causes
 * are CEL's, not tsfga's, and enumerating someone else's failure
 * modes as a union would be a claim tsfga cannot keep.
 *
 * That includes the one refusal tsfga raises here on its own
 * account: an expression whose evaluation cost exceeds
 * `maxConditionEvaluationCost`. It is a refusal about the
 * *request's* size, not about an expression that genuinely failed,
 * and it is distinguished by its message — which begins
 * `evaluation cost limit exceeded` — rather than by a cause value.
 * A caller who needs to tell the two apart reads the message; the
 * class is the same because upstream's is.
 */
export class ConditionEvaluationError extends TsfgaError {
  override cause: unknown;
  constructor(conditionName: string, cause: unknown) {
    super(`Failed to evaluate condition '${conditionName}': ${cause}`);
    this.name = "ConditionEvaluationError";
    this.cause = cause;
  }
}

export class DepthExceededError extends TsfgaError {
  constructor(detail: string) {
    super(`Check resolution too complex: ${detail}`);
    this.name = "DepthExceededError";
  }
}

export class InvalidStoredDataError extends TsfgaError {
  constructor(table: string, column: string, detail: string) {
    super(`Invalid data in ${table}.${column}: ${detail}`);
    this.name = "InvalidStoredDataError";
  }
}

/** Which half of a request the id was in. */
export type IdPosition = "object" | "subject";

/**
 * An id OpenFGA accepts and the store cannot hold.
 *
 * The one refusal in this file that is **not** a parity claim. It
 * is a capability refusal: the request is well formed by every
 * upstream rule, and tsfga declines it because the store said it
 * could not represent it. `packages/core/capability-refusals.json`
 * carries the inventory entry and the conformance pin, and
 * `packages/core/README.md` carries the paragraph.
 *
 * Its own class rather than a cause on `InvalidObjectError` or
 * `InvalidSubjectTypeError`: a capability refusal has to be one
 * greppable thing, and a caller routing around a documented
 * divergence needs to catch exactly it and nothing near it. It
 * also spans both halves of the request, which neither of those
 * classes does.
 */
export class IdDomainError extends TsfgaError {
  readonly position: IdPosition;
  readonly type: string;
  readonly id: string;
  /** The domain's own `name`, so the message reads as a phrase. */
  readonly domain: string;
  /** What the domain's `defect` said, verbatim. */
  readonly detail: string;

  constructor(
    position: IdPosition,
    type: string,
    id: string,
    domain: string,
    detail: string,
    ruleId?: WriteRuleId,
  ) {
    super(
      `The ${position} id '${id}' on '${type}' is outside this store's ` +
        `id domain (${domain}): ${detail}`,
      ruleId,
    );
    this.name = "IdDomainError";
    this.position = position;
    this.type = type;
    this.id = id;
    this.domain = domain;
    this.detail = detail;
  }
}
