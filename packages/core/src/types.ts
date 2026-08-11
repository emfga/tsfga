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
 * One entry of a relation's type restriction, matching OpenFGA's
 * `RelationReference` field for field.
 *
 * The four shapes upstream writes are:
 *
 * - `user` — `{ type: "user" }`
 * - `user:*` — `{ type: "user", wildcard: true }`
 * - `team#member` — `{ type: "team", relation: "member" }`
 * - `user with weekday_only` —
 *   `{ type: "user", condition: "weekday_only" }`
 *
 * and the condition composes with the other three.
 *
 * **The condition is part of the restriction, not an annotation on
 * it.** OpenFGA matches it exactly and in both directions: a
 * relation admitting only `[user with weekday_only]` refuses a
 * tuple carrying no condition — even when the check context would
 * have satisfied it — and a relation admitting only `[user]`
 * refuses one that carries a condition. Probed against v1.18.2.
 *
 * Structured rather than a `"user with weekday_only"` string
 * because the restriction is two-dimensional and every consumer
 * needs a different projection of it: the read gate is
 * condition-blind, the clamp is exact, and the adapter stores
 * `type` and `relation` in separate columns. A string forces each
 * of them to re-parse, and `CachingTupleStore` already refuses a
 * joined string key on that same ground.
 */
export interface TypeRestriction {
  type: string;
  /** Set for a userset ref: `team#member`. */
  relation?: string;
  /** Set for the typed wildcard: `user:*`. */
  wildcard?: true;
  /** Set when the restriction carries a condition. */
  condition?: string;
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
 * The three ref sets say which parts the caller wants, and under
 * which restrictions. They reflect the relation config: a part the
 * model cannot admit is not requested at all.
 *
 * **For all three, `null` and `[]` are opposites.** `null` means
 * the query declines to narrow that part, so every row of that
 * shape qualifies. `[]` means the relation positively admits
 * nothing of that shape, so the part is excluded. Reading one as
 * the other is the difference between a closed gate and an open
 * one, so a wrapper forwarding these must say which it means.
 *
 * **The check algorithm no longer sends `null`.** It used to, for
 * a relation with no config, on the reading that there was nothing
 * to restrict against — which made an unconfigured relation the
 * widest query in the library. A relation with no config is now
 * refused before any read, so every query core builds carries the
 * relation's own restrictions. The fields stay nullable because
 * `null` is a statement about a *query*, not about a model, and a
 * wrapper that widens one still has to be able to say it; the
 * clamp re-applies the real restrictions to the reply either way.
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
  /**
   * Restrictions under which a direct tuple for exactly this
   * subject is admitted, with no subject relation.
   *
   * More than one entry is ordinary: `[user, user with
   * weekday_only]` admits the same subject both bare and
   * conditioned, and a row matching either qualifies.
   */
  directRefs: readonly TypeRestriction[] | null;
  /** As `directRefs`, for the `subjectType:*` wildcard row. */
  wildcardRefs: readonly TypeRestriction[] | null;
  /**
   * Userset refs (`type#relation`) this relation admits, so a
   * store can restrict its userset scan to rows the model can
   * actually use.
   */
  usersetRefs: readonly TypeRestriction[] | null;
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
   * What this relation admits as a direct assignment, matching
   * OpenFGA's `directly_related_user_types` one for one.
   *
   * Required. `[]` says the relation admits no direct assignment
   * at all — a purely computed relation — which is a different
   * statement from a relation that declines to narrow, and the
   * check algorithm reads it as one: it issues no tuple read.
   *
   * Each entry is matched on all four of its fields. The userset
   * entries carry the relation, so `team#member` and `team#owner`
   * are distinguishable; the entries carry the condition, so
   * `user` and `user with weekday_only` are too. A relation
   * admitting only one of a pair must refuse a tuple naming the
   * other, on the write path and on the read path alike.
   */
  directlyAssignable: TypeRestriction[];
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

/**
 * A parameter type that stands on its own, and the only thing a
 * `list` or a `map` may hold.
 *
 * `ipaddress` is absent: cel-js has no such type and no `in_cidr`,
 * so a condition declaring one could be stored but never
 * evaluated.
 */
export type ConditionParameterScalarType =
  | "string"
  | "int"
  | "uint"
  | "bool"
  | "double"
  | "duration"
  | "timestamp"
  | "any";

/**
 * Supported CEL parameter types.
 *
 * `list` and `map` carry their element type, as upstream requires:
 * a container parameter is declared `list<string>`, never a bare
 * `list`. Without it nothing reads the elements, so `list<string>`
 * given `[1]` — which OpenFGA refuses — was accepted here and the
 * number reached CEL. A map's keys are always strings; only the
 * value type is declared.
 */
export type ConditionParameterType =
  | ConditionParameterScalarType
  | `list<${ConditionParameterScalarType}>`
  | `map<${ConditionParameterScalarType}>`;

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

/**
 * Parameters for a list-objects request.
 *
 * A request object rather than positional arguments because
 * upstream's `ListObjectsRequest` carries `contextual_tuples` and
 * the flat form had nowhere to put them.
 */
export interface ListObjectsRequest {
  objectType: string;
  relation: string;
  subjectType: string;
  subjectId: string;
  /** Forwarded to every per-candidate check. */
  context?: Record<string, unknown>;
  /**
   * Tuples that exist for this request only. Validated exactly as
   * `addTuple` validates a write, once for the whole call, and
   * their objects join the candidate pool — an object reachable
   * only through a contextual tuple is still an answer.
   */
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
   * restore unbounded fanout). Must be an integer >= 1, or
   * Infinity.
   *
   * Bounding breadth changes the boolean result on exactly one
   * shape: a cycle reaching an intersection operand, where which
   * operand wins the race decides whether the denial carries its
   * indeterminacy out, and breadth decides whether the operands
   * race at all. Everywhere else it changes only which branch's
   * error surfaces when several fail. Upstream behaves the same
   * way. See "Bounded breadth" in the README.
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
