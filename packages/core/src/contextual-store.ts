import type { IdDomain, TupleStore } from "./store-interface.ts";
import type {
  AddTupleRequest,
  CheckTuples,
  CheckTuplesQuery,
  ConditionDefinition,
  RelationConfig,
  RemoveTupleRequest,
  Tuple,
  TypeRestriction,
} from "./types.ts";
import type { GatedRelationConfig, GatedTuple } from "./write-gate.ts";

/**
 * Wraps a TupleStore, overlaying contextual tuples on read operations.
 * Contextual tuples are temporary tuples passed with the check request
 * that exist only for the duration of the check.
 */
export class ContextualTupleStore implements TupleStore {
  private contextualTuples: Tuple[];

  constructor(
    private inner: TupleStore,
    tuples: AddTupleRequest[],
  ) {
    this.contextualTuples = tuples.map((t) => ({
      objectType: t.objectType,
      objectId: t.objectId,
      relation: t.relation,
      subjectType: t.subjectType,
      subjectId: t.subjectId,
      subjectRelation: t.subjectRelation ?? null,
      conditionName: t.conditionName ?? null,
      conditionContext: t.conditionContext ?? null,
    }));
  }

  /**
   * The wrapped store's, forwarded rather than declared. A wrapper
   * holds no ids of its own; the domain belongs to whatever is
   * underneath it.
   */
  get idDomain(): IdDomain {
    return this.inner.idDomain;
  }

  /**
   * The overlay is deliberately asymmetric, and merging the three
   * reads into one call must not quietly even it out.
   *
   * The **direct** probe returns *one* tuple, so a contextual tuple
   * on that exact key **replaces** the stored one — it is not
   * unioned with it. That is what lets a caller override a
   * conditioned stored tuple with an unconditioned contextual one,
   * and it is upstream's `ReadUserTuple`, which returns the first
   * contextual row whose user matches and never consults the store.
   *
   * Every other read is a **scan**, and upstream's `Read` /
   * `ReadUsersetTuples` concatenate the contextual rows with the
   * stored ones with no dedup at all
   * (`pkg/storage/storagewrappers/combinedtuplereader.go:63-103`).
   * So the wildcard rows and the userset rows are **concatenated**.
   *
   * The wildcard used to replace, like the direct probe, and that
   * was a hole in the granting direction: a caller cancelled a
   * stored `blocked@user:*` row by sending a contextual row on the
   * same key whose condition could not hold. A contextual row
   * duplicating a stored one now grants twice rather than once,
   * which is what upstream does and is harmless for a boolean
   * answer.
   *
   * A part the overlay already answers is dropped from the inner
   * query, so a replaced probe still costs the store nothing. The
   * wildcard is no longer such a part: the store must still be
   * asked, because its rows join the contextual ones.
   */
  async findCheckTuples(query: CheckTuplesQuery): Promise<CheckTuples> {
    const direct =
      query.directRefs?.length === 0
        ? null
        : this.findContextualDirect(query, query.subjectId);

    const stored = await this.inner.findCheckTuples({
      ...query,
      // This field **suppresses**, and suppressing is `[]`.
      //
      // The reading to avoid: `directRefs` is not a permission to
      // be forwarded or withheld, it is a restriction, and its
      // `null` means *unrestricted*. So the natural-looking
      // `direct === null ? query.directRefs : null` is fail-open —
      // it turns "the overlay already answered this probe, don't
      // ask the store" into "ask the store, and accept anything".
      // `[]` is the value that says the part is excluded.
      directRefs: direct === null ? query.directRefs : [],
    });

    const excluded = (refs: readonly TypeRestriction[] | null): boolean =>
      refs !== null && refs.length === 0;

    return {
      direct: direct ?? stored.direct,
      wildcard: excluded(query.wildcardRefs)
        ? stored.wildcard
        : [...this.findContextualWildcards(query), ...stored.wildcard],
      usersets: excluded(query.usersetRefs)
        ? stored.usersets
        : [...this.findContextualUsersets(query), ...stored.usersets],
    };
  }

  private findContextualDirect(
    query: CheckTuplesQuery,
    subjectId: string,
  ): Tuple | null {
    return (
      this.contextualTuples.find(
        (t) =>
          t.objectType === query.objectType &&
          t.objectId === query.objectId &&
          t.relation === query.relation &&
          t.subjectType === query.subjectType &&
          t.subjectId === subjectId &&
          t.subjectRelation === null,
      ) ?? null
    );
  }

  private findContextualWildcards(query: CheckTuplesQuery): Tuple[] {
    return this.contextualTuples.filter(
      (t) =>
        t.objectType === query.objectType &&
        t.objectId === query.objectId &&
        t.relation === query.relation &&
        t.subjectType === query.subjectType &&
        t.subjectId === "*" &&
        t.subjectRelation === null,
    );
  }

  private findContextualUsersets(query: CheckTuplesQuery): Tuple[] {
    return this.contextualTuples.filter(
      (t) =>
        t.objectType === query.objectType &&
        t.objectId === query.objectId &&
        t.relation === query.relation &&
        t.subjectRelation !== null,
    );
  }

  async findTuplesByRelation(
    objectType: string,
    objectId: string,
    relation: string,
  ): Promise<Tuple[]> {
    const contextual = this.contextualTuples.filter(
      (t) =>
        t.objectType === objectType &&
        t.objectId === objectId &&
        t.relation === relation,
    );
    const stored = await this.inner.findTuplesByRelation(
      objectType,
      objectId,
      relation,
    );
    return [...contextual, ...stored];
  }

  findRelationConfig(
    objectType: string,
    relation: string,
  ): Promise<RelationConfig | null> {
    return this.inner.findRelationConfig(objectType, relation);
  }

  findConditionDefinition(name: string): Promise<ConditionDefinition | null> {
    return this.inner.findConditionDefinition(name);
  }

  /**
   * Delegated, with nothing overlaid: a contextual tuple cannot
   * define a type. They are validated against the relation configs
   * that already exist, so one naming an undefined type is refused
   * before it is ever read.
   */
  hasTypeDefinition(type: string): Promise<boolean> {
    return this.inner.hasTypeDefinition(type);
  }

  insertTuple(tuple: GatedTuple): Promise<boolean> {
    return this.inner.insertTuple(tuple);
  }

  deleteTuple(tuple: RemoveTupleRequest): Promise<boolean> {
    return this.inner.deleteTuple(tuple);
  }

  /**
   * The stored candidates, plus every object a contextual tuple
   * names of this type.
   *
   * The pool is a pre-filter for `listObjects`, and a contextual
   * tuple can be the only reason an object belongs in the answer —
   * upstream returns such an object, and passing the call straight
   * through would leave it out with no error. Ids the store already
   * returned are not repeated, since a duplicate candidate would
   * appear twice in the result.
   */
  async listCandidateObjectIds(objectType: string): Promise<string[]> {
    const stored = await this.inner.listCandidateObjectIds(objectType);
    const seen = new Set(stored);
    const extra: string[] = [];
    for (const tuple of this.contextualTuples) {
      if (tuple.objectType !== objectType) continue;
      if (seen.has(tuple.objectId)) continue;
      seen.add(tuple.objectId);
      extra.push(tuple.objectId);
    }
    return extra.length === 0 ? stored : [...stored, ...extra];
  }

  upsertRelationConfig(config: GatedRelationConfig): Promise<void> {
    return this.inner.upsertRelationConfig(config);
  }

  deleteRelationConfig(objectType: string, relation: string): Promise<boolean> {
    return this.inner.deleteRelationConfig(objectType, relation);
  }

  upsertConditionDefinition(condition: ConditionDefinition): Promise<void> {
    return this.inner.upsertConditionDefinition(condition);
  }

  deleteConditionDefinition(name: string): Promise<boolean> {
    return this.inner.deleteConditionDefinition(name);
  }
}
