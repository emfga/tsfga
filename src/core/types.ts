/** A relationship tuple with optional condition */
export interface Tuple {
  objectType: string;
  objectId: string;
  relation: string;
  subjectType: string;
  subjectId: string;
  subjectRelation?: string;
  conditionName?: string;
  conditionContext?: Record<string, unknown>;
}

/** Configuration for a relation on an object type */
export interface RelationConfig {
  objectType: string;
  relation: string;
  directlyAssignableTypes?: string[];
  impliedBy?: string[];
  computedUserset?: string;
  tupleToUserset?: { tupleset: string; computedUserset: string };
  allowsUsersetSubjects: boolean;
}

/** A named CEL condition definition */
export interface ConditionDefinition {
  name: string;
  expression: string;
  parameters?: Record<string, ConditionParameterType>;
}

/** Supported CEL parameter types */
export type ConditionParameterType =
  | "string"
  | "int"
  | "bool"
  | "double"
  | "duration"
  | "timestamp"
  | "list"
  | "map";

/** Parameters for a check request */
export interface CheckRequest {
  objectType: string;
  objectId: string;
  relation: string;
  subjectType: string;
  subjectId: string;
  context?: Record<string, unknown>;
}

/** Options for the check algorithm */
export interface CheckOptions {
  /** Maximum recursion depth (default: 10) */
  maxDepth?: number;
}

/** Parameters for adding a tuple */
export interface AddTupleRequest {
  objectType: string;
  objectId: string;
  relation: string;
  subjectType: string;
  subjectId: string;
  subjectRelation?: string;
  conditionName?: string;
  conditionContext?: Record<string, unknown>;
}

/** Parameters for removing a tuple */
export interface RemoveTupleRequest {
  objectType: string;
  objectId: string;
  relation: string;
  subjectType: string;
  subjectId: string;
  subjectRelation?: string;
}
