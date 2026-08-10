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

/**
 * The tuple reads one node of a check needs, as one request.
 *
 * A node can want up to three things about `objectType:objectId`
 * and `relation`: whether the subject holds it directly, whether
 * a `subjectType:*` wildcard grants it publicly, and which
 * usersets are assigned to it. They are asked for together so a
 * store can serve them in one round-trip.
 *
 * The three `include*` flags say which parts the caller wants.
 * They reflect the relation config: a part the model cannot admit
 * is not requested at all.
 *
 * They are a **narrowing hint, not a trust boundary**. A store
 * may use them to skip work — that is the point of sending them —
 * but it is never relied on to. The check algorithm re-clamps
 * every reply against the query it sent, so a store that ignores
 * a flag, or files a row under the wrong slot, loses that row
 * rather than smuggling it past the model's type restrictions.
 * Narrowing is the store's business; widening is impossible.
 */
export interface CheckTuplesQuery {
  objectType: string;
  objectId: string;
  relation: string;
  subjectType: string;
  subjectId: string;
  /** Direct tuple for exactly this subject, no subject relation. */
  includeDirect: boolean;
  /** Direct tuple for `subjectType:*`, no subject relation. */
  includeWildcard: boolean;
  /**
   * Userset refs (`type#relation`) this relation admits, so a
   * store can restrict its userset scan to rows the model can
   * actually use.
   *
   * `[]` excludes the userset part entirely. `null` means the
   * relation declines to narrow — every tuple on it with a
   * subject relation.
   */
  usersetRefs: readonly string[] | null;
}

/**
 * What a `CheckTuplesQuery` found.
 *
 * A part the query excluded reads back as `null` / `[]` — the same
 * value it would have on a miss. That is deliberate: the check
 * algorithm treats "the model forbids it" and "nothing is stored"
 * identically, so nothing downstream has to tell them apart.
 *
 * `usersets` is `readonly` because the check algorithm aliases a
 * shared empty array for the excluded case rather than allocating
 * one per node.
 */
export interface CheckTuples {
  direct: Tuple | null;
  wildcard: Tuple | null;
  usersets: readonly Tuple[];
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
  /**
   * What this relation admits as a direct assignment, in OpenFGA's
   * type-restriction notation and matching its
   * `directly_related_user_types` one for one:
   *
   * - `"user"` — an ordinary subject of that type
   * - `"user:*"` — the typed wildcard
   * - `"team#member"` — a userset, naming the relation
   *
   * Required. `[]` says the relation admits no direct assignment
   * at all — a purely computed relation — which is a different
   * statement from a relation that declines to narrow, and the
   * check algorithm reads it as one: it issues no tuple read.
   *
   * The userset entries carry the relation, so `team#member` and
   * `team#owner` are distinguishable. A relation admitting only
   * the first must refuse a tuple naming the second, on the write
   * path and on the read path alike.
   */
  directlyAssignable: string[];
  impliedBy: string[] | null;
  computedUserset: string | null;
  tupleToUserset: Array<{ tupleset: string; computedUserset: string }> | null;
  excludedBy: string | null;
  intersection: IntersectionOperand[] | null;
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
  /**
   * Maximum number of whole checks of one `checkMany` batch
   * resolved concurrently (default: 50, matching OpenFGA's
   * `OPENFGA_MAX_CONCURRENT_CHECKS_PER_BATCH_CHECK`). A separate
   * knob from `maxBreadth`, which bounds the branches within one
   * check. Ignored by `check` and `listObjects`. Must be an
   * integer >= 1, or Infinity.
   */
  maxConcurrentChecks?: number;
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
