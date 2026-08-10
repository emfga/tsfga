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

export class InvalidSubjectTypeError extends TsfgaError {
  constructor(
    subjectType: string,
    objectType: string,
    relation: string,
    allowed: string[],
  ) {
    super(
      `Subject type '${subjectType}' is not allowed for ${objectType}.${relation}. Allowed: ${allowed.join(", ")}`,
    );
    this.name = "InvalidSubjectTypeError";
  }
}

export class ConditionNotFoundError extends TsfgaError {
  constructor(conditionName: string) {
    super(`Condition definition not found: ${conditionName}`);
    this.name = "ConditionNotFoundError";
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
