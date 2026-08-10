import type {
  AddTupleRequest,
  CheckTuples,
  CheckTuplesQuery,
  ConditionDefinition,
  RelationConfig,
  RemoveTupleRequest,
  Tuple,
} from "./types.ts";

export interface TupleStore {
  // === Read ===

  /**
   * Read the tuples one check node needs: the subject's direct
   * tuple, the `subjectType:*` wildcard tuple, and the usersets
   * assigned to the relation.
   *
   * These three are asked for together because a check issues
   * them together, at every node it visits — serving them in one
   * round-trip is the single largest thing an adapter can do for
   * check latency. An implementation is free to run three queries
   * instead; it just gives that up.
   *
   * The `include*` flags are there so a store can **narrow** its
   * query — that is where the saving is. They are not a contract
   * you can breach dangerously: the check algorithm re-clamps
   * every reply against the query it sent, so returning a part
   * that was not asked for, or filing a row under the wrong slot,
   * loses that row. It cannot widen what the model admits.
   *
   * Slots are exact. `direct` is the tuple for this subject with
   * no subject relation; `wildcard` is the one for
   * `subjectType:*`, likewise with no subject relation; every row
   * in `usersets` has a subject relation. Anything else is
   * discarded.
   */
  findCheckTuples(query: CheckTuplesQuery): Promise<CheckTuples>;

  /** Find tuples by object + relation (for tuple-to-userset tupleset lookup) */
  findTuplesByRelation(
    objectType: string,
    objectId: string,
    relation: string,
  ): Promise<Tuple[]>;

  /** Get relation config for an object_type + relation */
  findRelationConfig(
    objectType: string,
    relation: string,
  ): Promise<RelationConfig | null>;

  /** Get a condition definition by name */
  findConditionDefinition(name: string): Promise<ConditionDefinition | null>;

  // === Write ===

  /** Insert or update a tuple (upsert on natural key) */
  insertTuple(tuple: AddTupleRequest): Promise<void>;

  /** Delete a tuple by natural key */
  deleteTuple(tuple: RemoveTupleRequest): Promise<boolean>;

  // === Query ===

  /**
   * List candidate object IDs for `listObjects` (pre-filter, check
   * still required).
   *
   * Deliberately ungated, unlike `listSubjects`. Every candidate is
   * re-checked through the gated path before `listObjects` returns
   * it, so over-returning here costs work and cannot grant —
   * whereas under-returning would silently drop objects the subject
   * really can reach.
   */
  listCandidateObjectIds(objectType: string): Promise<string[]>;

  /** List direct subjects for an object + relation */
  listDirectSubjects(
    objectType: string,
    objectId: string,
    relation: string,
  ): Promise<
    Array<{
      subjectType: string;
      subjectId: string;
      subjectRelation: string | null;
    }>
  >;

  // === Config management ===

  /** Insert or update a relation config */
  upsertRelationConfig(config: RelationConfig): Promise<void>;

  /** Delete a relation config */
  deleteRelationConfig(objectType: string, relation: string): Promise<boolean>;

  /** Insert or update a condition definition */
  upsertConditionDefinition(condition: ConditionDefinition): Promise<void>;

  /** Delete a condition definition */
  deleteConditionDefinition(name: string): Promise<boolean>;
}
