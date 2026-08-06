/** A relationship tuple with optional condition */
export interface Tuple {
  objectType: string;
  objectId: string;
  relation: string;
  subjectType: string;
  subjectId: string;
  subjectRelation: string | null;
  conditionName: string | null;
  conditionContext: Record<string, unknown> | null;
}

/** An operand in an intersection expression */
export type IntersectionOperand =
  | { type: "direct" }
  | { type: "computedUserset"; relation: string }
  | { type: "tupleToUserset"; tupleset: string; computedUserset: string };

/** Configuration for a relation on an object type */
export interface RelationConfig {
  objectType: string;
  relation: string;
  directlyAssignableTypes: string[] | null;
  impliedBy: string[] | null;
  computedUserset: string | null;
  tupleToUserset: Array<{ tupleset: string; computedUserset: string }> | null;
  excludedBy: string | null;
  intersection: IntersectionOperand[] | null;
  allowsUsersetSubjects: boolean;
}

/** A named CEL condition definition */
export interface ConditionDefinition {
  name: string;
  expression: string;
  parameters: Record<string, ConditionParameterType> | null;
}

/** Supported CEL parameter types */
export type ConditionParameterType =
  | "string"
  | "int"
  | "uint"
  | "bool"
  | "double"
  | "duration"
  | "timestamp"
  | "list"
  | "map"
  | "any";

/** Parameters for a check request */
export interface CheckRequest {
  objectType: string;
  objectId: string;
  relation: string;
  subjectType: string;
  subjectId: string;
  context?: Record<string, unknown>;
  contextualTuples?: AddTupleRequest[];
}

/** Options for the check algorithm */
export interface CheckOptions {
  /** Maximum recursion depth (default: 25) */
  maxDepth?: number;
  /**
   * Maximum number of branches of one resolution node evaluated
   * concurrently (default: 10, matching OpenFGA's default
   * `OPENFGA_RESOLVE_NODE_BREADTH_LIMIT`; pass Infinity to
   * restore unbounded fanout). Bounding breadth never changes
   * the boolean result or whether a check errors — only which
   * branch's error surfaces when several fail. Must be an
   * integer >= 1, or Infinity.
   */
  maxBreadth?: number;
}

/** Parameters for adding a tuple */
export interface AddTupleRequest {
  objectType: string;
  objectId: string;
  relation: string;
  subjectType: string;
  subjectId: string;
  subjectRelation?: string | null;
  conditionName?: string | null;
  conditionContext?: Record<string, unknown> | null;
}

/** Parameters for removing a tuple */
export interface RemoveTupleRequest {
  objectType: string;
  objectId: string;
  relation: string;
  subjectType: string;
  subjectId: string;
  subjectRelation?: string | null;
}
