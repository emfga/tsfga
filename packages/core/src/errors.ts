import type { SubjectShape } from "./tuple-validation.ts";
import type { TypeRestriction } from "./types.ts";

export class TsfgaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TsfgaError";
  }
}

export class RelationConfigNotFoundError extends TsfgaError {
  constructor(objectType: string, relation: string) {
    super(`No relation config found for ${objectType}.${relation}`);
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
   */
  readonly allowed: readonly TypeRestriction[];

  constructor(
    subject: SubjectShape,
    objectType: string,
    relation: string,
    allowed: readonly TypeRestriction[],
  ) {
    super(
      `Subject type '${formatRestriction(subject)}' is not allowed for ` +
        `${objectType}.${relation}`,
    );
    this.name = "InvalidSubjectTypeError";
    this.subject = subject;
    this.objectType = objectType;
    this.relation = relation;
    this.allowed = allowed;
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
  | "invalid context parameter";

/**
 * The subject's type is assignable, but not with the condition the
 * tuple carries — or without one.
 */
export class InvalidConditionalTupleError extends TsfgaError {
  override readonly cause: ConditionalTupleCause;

  constructor(
    cause: ConditionalTupleCause,
    subject: TypeRestriction,
    objectType: string,
    relation: string,
    allowed: readonly TypeRestriction[],
    detail?: string,
  ) {
    super(
      `Invalid conditional tuple for ${objectType}.${relation}: ${cause}` +
        (detail === undefined ? "" : ` (${detail})`) +
        `. Subject: '${formatRestriction(subject)}'. Allowed: ` +
        `${allowed.map(formatRestriction).join(", ")}`,
    );
    this.name = "InvalidConditionalTupleError";
    this.cause = cause;
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
  constructor(conditionName: string, cause: unknown) {
    super(`Failed to compile condition '${conditionName}': ${cause}`);
    this.name = "ConditionCompileError";
    this.cause = cause;
  }
}

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
